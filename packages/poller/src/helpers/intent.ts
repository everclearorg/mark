import {
  MarkConfiguration,
  NewIntentParams,
  NewIntentWithPermit2Params,
  TransactionSubmissionType,
  TransactionRequest,
  WalletType,
} from '@mark/core';
import { decodeEventLog, Hex } from 'viem';
import { TransactionReason } from '@mark/prometheus';
import { MarkAdapters } from '../init';
import { checkAndApproveERC20 } from './erc20';
import { submitTransactionWithLogging } from './transactions';
import { jsonifyError, Logger } from '@mark/logger';
import { getValidatedZodiacConfig, getActualOwner } from './zodiac';
import {
  isSvmChain,
  isTvmChain,
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  hexToBase58,
} from '@mark/core';
import { LookupTableNotFoundError } from '@mark/everclear';
import { TransactionReceipt } from '@mark/chainservice';

export const INTENT_ADDED_TOPIC0 = '0xefe68281645929e2db845c5b42e12f7c73485fb5f18737b7b29379da006fa5f7';
export const NEW_INTENT_ADAPTER_SELECTOR = '0xb4c20477';

const intentAddedAbi = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: '_intentId',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: '_queueIdx',
        type: 'uint256',
      },
      {
        components: [
          {
            internalType: 'bytes32',
            name: 'initiator',
            type: 'bytes32',
          },
          {
            internalType: 'bytes32',
            name: 'receiver',
            type: 'bytes32',
          },
          {
            internalType: 'bytes32',
            name: 'inputAsset',
            type: 'bytes32',
          },
          {
            internalType: 'bytes32',
            name: 'outputAsset',
            type: 'bytes32',
          },
          {
            internalType: 'uint24',
            name: 'maxFee',
            type: 'uint24',
          },
          {
            internalType: 'uint32',
            name: 'origin',
            type: 'uint32',
          },
          {
            internalType: 'uint64',
            name: 'nonce',
            type: 'uint64',
          },
          {
            internalType: 'uint48',
            name: 'timestamp',
            type: 'uint48',
          },
          {
            internalType: 'uint48',
            name: 'ttl',
            type: 'uint48',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
          {
            internalType: 'uint32[]',
            name: 'destinations',
            type: 'uint32[]',
          },
          {
            internalType: 'bytes',
            name: 'data',
            type: 'bytes',
          },
        ],
        indexed: false,
        internalType: 'struct IEverclear.Intent',
        name: '_intent',
        type: 'tuple',
      },
    ],
    name: 'IntentAdded',
    type: 'event',
  },
] as const;

export const getAddedIntentIdsFromReceipt = async (
  receipt: TransactionReceipt,
  chainId: string,
  logger: Logger,
  context?: { requestId: string; invoiceId: string },
) => {
  // Find the IntentAdded event logs
  const intentAddedLogs = receipt.logs.filter(
    (l) => ((l as any).topics?.[0] ?? '').toLowerCase() === INTENT_ADDED_TOPIC0,
  );
  if (!intentAddedLogs.length) {
    logger.error('No intents created from purchase transaction', {
      invoiceId: context?.invoiceId,
      requestId: context?.requestId,
      transactionHash: receipt.transactionHash,
      chainId,
      logs: receipt.logs,
    });
    return [];
  }
  const purchaseIntentIds = intentAddedLogs.map((log) => {
    const { args } = decodeEventLog({
      abi: intentAddedAbi,
      data: (log as any).data as `0x${string}`,
      topics: (log as any).topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    }) as { args: { _intentId: string } };
    return args._intentId;
  });
  return purchaseIntentIds;
};

/**
 * Uses the api to get the tx data and chainservice to send intents and approve assets if required.
 */
export const sendIntents = async (
  invoiceId: string,
  intents: NewIntentParams[],
  adapters: MarkAdapters,
  config: MarkConfiguration,
  requestId?: string,
): Promise<{ transactionHash: string; type: TransactionSubmissionType; chainId: string; intentId: string }[]> => {
  const { logger } = adapters;

  if (!intents.length) {
    logger.info('No intents to process', { invoiceId });
    return [];
  }

  // Verify all intents have the same origin
  const origins = new Set(intents.map((intent) => intent.origin));
  if (origins.size !== 1) {
    throw new Error('Cannot process multiple intents with different origin domains');
  }
  const originChainId = intents[0].origin;
  if (isSvmChain(originChainId)) {
    return sendSvmIntents(invoiceId, intents, adapters, config, requestId);
  }
  if (isTvmChain(originChainId)) {
    return sendTvmIntents(invoiceId, intents, adapters, config, requestId);
  }
  // we handle default fallback case as evm intents
  return sendEvmIntents(invoiceId, intents, adapters, config, requestId);
};

export const sendEvmIntents = async (
  invoiceId: string,
  intents: NewIntentParams[],
  adapters: MarkAdapters,
  config: MarkConfiguration,
  requestId?: string,
): Promise<{ transactionHash: string; type: TransactionSubmissionType; chainId: string; intentId: string }[]> => {
  const { everclear, chainService, prometheus, logger } = adapters;
  const originChainId = intents[0].origin;
  const chainConfig = config.chains[originChainId];
  const originWalletConfig = getValidatedZodiacConfig(chainConfig, logger, { invoiceId, requestId });

  // Verify all intents have the same input asset
  const tokens = new Set(intents.map((intent) => intent.inputAsset.toLowerCase()));
  if (tokens.size !== 1) {
    throw new Error('Cannot process multiple intents with different input assets');
  }

  // Sanity check intent constraints
  intents.forEach((intent) => {
    // Ensure all intents have the same origin
    if (intent.origin !== originChainId) {
      throw new Error(`intent.origin (${intent.origin}) must be ${originChainId}`);
    }

    // Ensure there is no solver entrypoint
    if (BigInt(intent.maxFee.toString()) !== BigInt(0)) {
      throw new Error(`intent.maxFee (${intent.maxFee}) must be 0`);
    }

    // Ensure there is no calldata to execute
    if (intent.callData !== '0x') {
      throw new Error(`intent.callData (${intent.callData}) must be 0x`);
    }

    // Ensure each of the configured destinations uses the proper `to`.
    intent.destinations.forEach((destination) => {
      const walletConfig = getValidatedZodiacConfig(config.chains[destination], logger, { invoiceId, requestId });
      switch (walletConfig.walletType) {
        case WalletType.EOA:
          // Sanity checks for intents towards SVM
          if (isSvmChain(destination)) {
            if (intent.to !== config.ownSolAddress) {
              throw new Error(
                `intent.to (${intent.to}) must be ownSolAddress (${config.ownSolAddress}) for destination ${destination}`,
              );
            }
            if (intent.destinations.length !== 1) {
              throw new Error(`intent.destination must be length 1 for intents towards SVM`);
            }
            break;
          }
          if (intent.to.toLowerCase() !== config.ownAddress.toLowerCase()) {
            throw new Error(
              `intent.to (${intent.to}) must be ownAddress (${config.ownAddress}) for destination ${destination}`,
            );
          }
          break;
        case WalletType.Zodiac:
          if (intent.to.toLowerCase() !== walletConfig.safeAddress!.toLowerCase()) {
            throw new Error(
              `intent.to (${intent.to}) must be safeAddress (${walletConfig.safeAddress}) for destination ${destination}`,
            );
          }
          break;
        default:
          throw new Error(`Unrecognized destination wallet type configured: ${walletConfig.walletType}`);
      }
    });
  });

  try {
    // Get transaction data for the first intent to use for approval check
    const firstIntent = intents[0];
    // API call to get txdata for the newOrder call
    const feeAdapterTxData = await everclear.createNewIntent(
      intents as (NewIntentParams | NewIntentWithPermit2Params)[],
    );

    // Get total amount needed across all intents
    const totalAmount = intents.reduce((sum, intent) => {
      return BigInt(sum) + BigInt(intent.amount);
    }, BigInt(0));

    const spenderForAllowance = feeAdapterTxData.to as `0x${string}`;
    const ownerForAllowance = getActualOwner(originWalletConfig, config.ownAddress);

    logger.info('Total amount for approvals', {
      requestId,
      invoiceId,
      totalAmount: totalAmount.toString(),
      intentCount: intents.length,
      chainId: originChainId,
      owner: ownerForAllowance,
      spender: spenderForAllowance,
      walletType: originWalletConfig.walletType,
    });

    // Handle ERC20 approval using the general purpose helper
    const approvalResult = await checkAndApproveERC20({
      config,
      chainService,
      logger,
      prometheus,
      chainId: originChainId,
      tokenAddress: firstIntent.inputAsset,
      spenderAddress: spenderForAllowance,
      amount: totalAmount,
      owner: ownerForAllowance,
      zodiacConfig: originWalletConfig,
      context: { requestId, invoiceId },
    });

    if (approvalResult.wasRequired) {
      logger.info('Approval completed for intent batch', {
        requestId,
        invoiceId,
        chainId: originChainId,
        approvalTxHash: approvalResult.transactionHash,
        hadZeroApproval: approvalResult.hadZeroApproval,
        zeroApprovalTxHash: approvalResult.zeroApprovalTxHash,
        asset: firstIntent.inputAsset,
        amount: totalAmount.toString(),
      });
    }

    logger.info(`Processing ${intents.length} total intent(s)`, {
      requestId,
      invoiceId,
      count: intents.length,
      origin: intents[0].origin,
      token: intents[0].inputAsset,
    });

    // Verify min amounts for all intents before sending the batch
    for (const intent of intents) {
      // Sanity check -- minAmounts < intent.amount
      const { minAmounts } = await everclear.getMinAmounts(invoiceId);
      if (BigInt(minAmounts[intent.origin] ?? '0') < BigInt(intent.amount)) {
        logger.warn('Latest min amount for origin is smaller than intent size', {
          minAmount: minAmounts[intent.origin] ?? '0',
          intent,
          invoiceId,
          requestId,
        });
        continue;
        // NOTE: continue instead of exit in case other intents are still below the min amount,
        // then you would still be contributing to invoice to settlement. The invoice will be handled
        // again on the next polling cycle.
      }
    }

    // Submit the batch transaction using the general purpose helper
    logger.info('Submitting batch create intent transaction', {
      invoiceId,
      requestId,
      transaction: {
        to: feeAdapterTxData.to,
        value: feeAdapterTxData.value,
        data: feeAdapterTxData.data,
        from: config.ownAddress,
        chainId: originChainId,
      },
    });

    const purchaseResult = await submitTransactionWithLogging({
      chainService,
      logger,
      chainId: originChainId,
      txRequest: {
        chainId: +originChainId,
        to: feeAdapterTxData.to as `0x${string}`,
        data: feeAdapterTxData.data as Hex,
        value: feeAdapterTxData.value ?? '0',
        from: config.ownAddress,
        funcSig: 'newIntent(uint32[],address,address,address,uint256,uint24,uint48,bytes,(uint256,uint256,bytes))', // FeeAdapter newIntent function
      },
      zodiacConfig: originWalletConfig,
      context: { requestId, invoiceId, transactionType: 'batch-create-intent' },
    });

    const purchaseTx: TransactionReceipt = purchaseResult.receipt!;

    const purchaseIntentIds = await getAddedIntentIdsFromReceipt(purchaseTx, intents[0].origin, logger, {
      invoiceId,
      requestId: requestId || '',
    });

    logger.info('Batch create intent transaction sent successfully', {
      invoiceId,
      requestId,
      batchTxHash: purchaseTx.transactionHash,
      chainId: intents[0].origin,
      intentIds: purchaseIntentIds,
    });

    if (prometheus && purchaseTx && purchaseTx.cumulativeGasUsed && purchaseTx.effectiveGasPrice) {
      prometheus.updateGasSpent(
        intents[0].origin.toString(),
        TransactionReason.CreateIntent,
        BigInt(purchaseTx.cumulativeGasUsed.toString()) * BigInt(purchaseTx.effectiveGasPrice.toString()),
      );
    }

    // Return results for each intent in the batch
    return purchaseIntentIds.map((intentId: string) => ({
      transactionHash: purchaseTx.transactionHash,
      type: purchaseResult.submissionType,
      chainId: intents[0].origin,
      intentId,
    }));
  } catch (error) {
    logger.error('Error processing batch intents', {
      invoiceId,
      requestId,
      error,
      intentCount: intents.length,
    });
    throw error;
  }
};

export const sendSvmIntents = async (
  invoiceId: string,
  intents: NewIntentParams[],
  adapters: MarkAdapters,
  config: MarkConfiguration,
  requestId?: string,
): Promise<{ transactionHash: string; type: TransactionSubmissionType; chainId: string; intentId: string }[]> => {
  const { everclear, chainService, logger } = adapters;
  const originChainId = intents[0].origin;
  const chainConfig = config.chains[originChainId];

  const sourceAddress = config.ownSolAddress;

  // Verify all intents have the same input asset
  const tokens = new Set(intents.map((intent) => intent.inputAsset));
  if (tokens.size !== 1) {
    throw new Error('Cannot process multiple intents with different input assets');
  }

  // assert there is no calldata
  for (const intent of intents) {
    // HACK: solana API do not support callData passed in as '0x' and will return an invalid calldata otherwise
    intent.callData = '';
  }

  // Get total amount needed across all intents
  const totalAmount = intents.reduce((sum, intent) => {
    return BigInt(sum) + BigInt(intent.amount);
  }, BigInt(0));

  logger.info(`Processing ${intents.length} total intent(s)`, {
    requestId,
    invoiceId,
    count: intents.length,
    origin: intents[0].origin,
    token: intents[0].inputAsset,
    totalAmount: totalAmount.toString(),
  });

  try {
    const feeAdapterTxDatas: TransactionRequest[] = [];

    for (const intent of intents) {
      let feeAdapterTxData: TransactionRequest;
      try {
        // API call to get txdata for the newOrder call
        feeAdapterTxData = await everclear.solanaCreateNewIntent({
          ...intent,
          user: sourceAddress,
        });
        feeAdapterTxDatas.push(feeAdapterTxData);
      } catch (err) {
        if (err instanceof LookupTableNotFoundError) {
          // fallback to createLookupTable and retry
          const [userTokenAccountPublicKey] = await chainService.deriveProgramAddress(
            SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
            [sourceAddress, TOKEN_PROGRAM_ID, intent.inputAsset],
          );
          // TODO: this should be provided by the API
          const [programVaultPublicKey] = await chainService.deriveProgramAddress(
            hexToBase58(chainConfig.deployments?.everclear),
            ['vault'],
          );
          const [programVaultAccountPublicKey] = await chainService.deriveProgramAddress(
            SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
            [programVaultPublicKey, TOKEN_PROGRAM_ID, intent.inputAsset],
          );

          const lookupTableTxData = await everclear.solanaCreateLookupTable({
            inputAsset: intent.inputAsset,
            user: sourceAddress,
            userTokenAccountPublicKey,
            programVaultAccountPublicKey: programVaultAccountPublicKey,
          });

          const lookupTableTx = await chainService.submitAndMonitor(originChainId, {
            to: lookupTableTxData.to!,
            value: lookupTableTxData.value,
            data: lookupTableTxData.data,
            chainId: +originChainId,
            from: sourceAddress,
            funcSig: '', // Solana don't need function signatures
          });

          logger.info('solana lookup table transaction sent successfully', {
            invoiceId,
            requestId,
            txHash: lookupTableTx.transactionHash,
            chainId: intents[0].origin,
          });

          // Retry the intent creation after creating the lookup table
          feeAdapterTxData = await everclear.solanaCreateNewIntent({
            ...intent,
            user: sourceAddress,
          });
          feeAdapterTxDatas.push(feeAdapterTxData);
        } else {
          throw err;
        }
      }
    }

    // Verify min amounts for all intents before sending the batch
    for (const intent of intents) {
      // Sanity check -- minAmounts < intent.amount
      const { minAmounts } = await everclear.getMinAmounts(invoiceId);
      if (BigInt(minAmounts[intent.origin] ?? '0') < BigInt(intent.amount)) {
        logger.warn('Latest min amount for origin is smaller than intent size', {
          minAmount: minAmounts[intent.origin] ?? '0',
          intent,
          invoiceId,
          requestId,
        });
        continue;
        // NOTE: continue instead of exit in case other intents are still below the min amount,
        // then you would still be contributing to invoice to settlement. The invoice will be handled
        // again on the next polling cycle.
      }
    }

    // Submit the batch transaction
    logger.info('Submitting create intent transaction', {
      invoiceId,
      requestId,
      address: config.ownSolAddress,
      chainId: originChainId,
      transactions: feeAdapterTxDatas,
    });

    const purchaseData: {
      tx: unknown;
      intentId: string;
    }[] = [];
    for (const feeAdapterTxData of feeAdapterTxDatas) {
      // Transaction will be newIntent (if single intent) or newOrder
      let purchaseTxTo = feeAdapterTxData!.to!;
      let purchaseTxData = feeAdapterTxData!.data as Hex;
      let purchaseTxValue = (feeAdapterTxData!.value ?? '0').toString();

      const purchaseTx = await chainService.submitAndMonitor(originChainId, {
        to: purchaseTxTo,
        value: purchaseTxValue,
        data: purchaseTxData,
        chainId: +originChainId,
        from: sourceAddress,
        funcSig: '',
      });

      // Find the IntentAdded event logs
      // TODO: CPI Logs integration
      purchaseData.push({
        tx: purchaseTx,
        intentId: '',
      });
    }
    // logger.info('Batch create intent transaction sent successfully', {
    //   invoiceId,
    //   requestId,
    //   batchTxHash: purchaseTx.transactionHash,
    //   chainId: intents[0].origin,
    //   intentIds: purchaseIntentIds,
    // });

    // prometheus.updateGasSpent(
    //   intents[0].origin,
    //   TransactionReason.CreateIntent,
    //   BigInt(purchaseTx.cumulativeGasUsed.mul(purchaseTx.effectiveGasPrice).toString()),
    // );

    // Return results for each intent in the batch
    return purchaseData.map((d) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transactionHash: (d.tx as any).transactionHash,
      type: TransactionSubmissionType.Onchain,
      chainId: intents[0].origin,
      intentId: d.intentId,
    }));
  } catch (error) {
    logger.error('Error processing batch intents', {
      invoiceId,
      requestId,
      error,
      intentCount: intents.length,
    });
    throw error;
  }
};

export const sendTvmIntents = async (
  invoiceId: string,
  intents: NewIntentParams[],
  adapters: MarkAdapters,
  config: MarkConfiguration,
  requestId?: string,
): Promise<{ transactionHash: string; type: TransactionSubmissionType; chainId: string; intentId: string }[]> => {
  const { everclear, chainService, prometheus, logger } = adapters;
  const originChainId = intents[0].origin;
  const chainConfig = config.chains[originChainId];
  const originWalletConfig = getValidatedZodiacConfig(chainConfig, logger, { invoiceId, requestId });

  // Verify all intents have the same input asset
  const tokens = new Set(intents.map((intent) => intent.inputAsset.toLowerCase()));
  if (tokens.size !== 1) {
    throw new Error('Cannot process multiple intents with different input assets');
  }

  const addresses = await chainService.getAddress();

  // Sanity check intent constraints
  intents.forEach((intent) => {
    // Ensure all intents have the same origin
    if (intent.origin !== originChainId) {
      throw new Error(`intent.origin (${intent.origin}) must be ${originChainId}`);
    }

    // Ensure each of the configured destinations uses the proper `to`.
    intent.destinations.forEach((destination) => {
      const walletConfig = getValidatedZodiacConfig(config.chains[destination], logger, { invoiceId, requestId });
      switch (walletConfig.walletType) {
        case WalletType.EOA:
          const expectedAddress = isTvmChain(destination) ? addresses[destination] : config.ownAddress;
          if (intent.to.toLowerCase() !== expectedAddress.toLowerCase()) {
            throw new Error(`intent.to (${intent.to}) must be ${expectedAddress} for destination ${destination}`);
          }
          break;
        case WalletType.Zodiac:
          if (intent.to.toLowerCase() !== walletConfig.safeAddress!.toLowerCase()) {
            throw new Error(
              `intent.to (${intent.to}) must be safeAddress (${walletConfig.safeAddress}) for destination ${destination}`,
            );
          }
          break;
        default:
          throw new Error(`Unrecognized destination wallet type configured: ${walletConfig.walletType}`);
      }
    });
  });

  try {
    // Get transaction data for the first intent to use for approval check
    const firstIntent = intents[0];
    // API call to get txdata for the newOrder call
    const feeAdapterTxData = await everclear.tronCreateNewIntent(
      firstIntent as NewIntentParams | NewIntentWithPermit2Params,
    );

    // Get total amount needed across all intents
    const totalAmount = intents.reduce((sum, intent) => {
      return BigInt(sum) + BigInt(intent.amount);
    }, BigInt(0));

    // Get the spender address from the deployment config for approvals
    // const spenderForAllowance = `0x${TronWeb.address.toHex(feeAdapterTxData.to || '').slice(2)}` as `0x${string}`;
    // let spokeAddress = chainConfig.deployments?.everclear;
    // if (!spokeAddress) {
    //   throw new Error(`Everclear deployment not found for chain ${originChainId}`);
    // }
    // const spenderForAllowance = `0x${TronWeb.address.toHex(spokeAddress).slice(2)}` as `0x${string}`;
    const tronAddress = addresses[originChainId];
    // const ownerForAllowance = `0x${TronWeb.address.toHex(tronAddress).slice(2)}`;

    logger.info('Total amount for approvals', {
      requestId,
      invoiceId,
      totalAmount: totalAmount.toString(),
      intentCount: intents.length,
      chainId: originChainId,
      owner: tronAddress,
      spender: feeAdapterTxData.to,
      walletType: originWalletConfig.walletType,
    });

    try {
      // Handle TRC20 approval using the general purpose helper
      const approvalResult = await checkAndApproveERC20({
        config,
        chainService,
        logger,
        prometheus,
        chainId: originChainId,
        tokenAddress: firstIntent.inputAsset,
        spenderAddress: feeAdapterTxData.to!,
        amount: totalAmount,
        owner: tronAddress,
        zodiacConfig: originWalletConfig,
        context: { requestId, invoiceId },
      });

      if (approvalResult.wasRequired) {
        logger.info('Approval completed for Tron intent batch', {
          requestId,
          invoiceId,
          chainId: originChainId,
          approvalTxHash: approvalResult.transactionHash,
          hadZeroApproval: approvalResult.hadZeroApproval,
          zeroApprovalTxHash: approvalResult.zeroApprovalTxHash,
          asset: firstIntent.inputAsset,
          amount: totalAmount.toString(),
        });
      }
    } catch (error) {
      logger.error('Failed to approve TRC20 on Tron', {
        requestId,
        invoiceId,
        error: jsonifyError(error),
        tokenAddress: firstIntent.inputAsset,
        spenderAddress: feeAdapterTxData.to!,
        owner: tronAddress,
        amount: totalAmount.toString(),
      });
      throw error;
    }

    logger.info(`Processing ${intents.length} total intent(s)`, {
      requestId,
      invoiceId,
      count: intents.length,
      origin: intents[0].origin,
      token: intents[0].inputAsset,
    });

    // TEMPORARY: Process only first intent for Tron API compatibility
    // TODO: Revert to process all intents when API supports batching
    const results: { transactionHash: string; type: TransactionSubmissionType; chainId: string; intentId: string }[] =
      [];

    // Only process first intent for now
    if (intents.length > 1) {
      logger.warn('Tron API currently only supports single intents, processing first intent only', {
        totalIntents: intents.length,
        processingOnly: 1,
        invoiceId,
        requestId,
      });
    }
    const intentsToProcess = intents.slice(0, 1);
    for (const intent of intentsToProcess) {
      // Sanity check -- minAmounts < intent.amount
      const { minAmounts } = await everclear.getMinAmounts(invoiceId);
      if (BigInt(minAmounts[intent.origin] ?? '0') < BigInt(intent.amount)) {
        logger.warn('Latest min amount for origin is smaller than intent size', {
          minAmount: minAmounts[intent.origin] ?? '0',
          intent,
          invoiceId,
          requestId,
        });
        continue;
        // NOTE: continue instead of exit in case other intents are still below the min amount,
        // then you would still be contributing to invoice to settlement. The invoice will be handled
        // again on the next polling cycle.
      }

      // API call to get txdata for this single intent
      // const feeAdapterTxData = await everclear.tronCreateNewIntent(
      //   intent as NewIntentParams | NewIntentWithPermit2Params,
      // );

      logger.info('Submitting create intent transaction for Tron', {
        invoiceId,
        requestId,
        transaction: {
          to: feeAdapterTxData.to,
          value: feeAdapterTxData.value,
          data: feeAdapterTxData.data,
          from: tronAddress,
          chainId: originChainId,
        },
      });

      const purchaseResult = await submitTransactionWithLogging({
        chainService,
        logger,
        chainId: originChainId,
        txRequest: {
          chainId: +originChainId,
          to: feeAdapterTxData.to as string,
          data: feeAdapterTxData.data,
          value: feeAdapterTxData.value ?? '0',
          from: tronAddress,
          funcSig: 'newIntent(uint32[],address,address,address,uint256,uint24,uint48,bytes,(uint256,uint256,bytes))',
        },
        zodiacConfig: originWalletConfig,
        context: { requestId, invoiceId, transactionType: 'create-intent' },
      });

      const purchaseTx = purchaseResult.receipt!;
      const purchaseIntentIds = await getAddedIntentIdsFromReceipt(purchaseTx, intent.origin, logger, {
        invoiceId,
        requestId: requestId || '',
      });

      logger.info('Create intent transaction sent successfully', {
        invoiceId,
        requestId,
        txHash: purchaseTx.transactionHash,
        chainId: intent.origin,
        intentIds: purchaseIntentIds,
      });

      try {
        if (prometheus && purchaseTx && purchaseTx.cumulativeGasUsed && purchaseTx.effectiveGasPrice) {
          prometheus.updateGasSpent(
            intent.origin.toString(),
            TransactionReason.CreateIntent,
            BigInt(purchaseTx.cumulativeGasUsed.toString()) * BigInt(purchaseTx.effectiveGasPrice.toString()),
          );
        }
      } catch (err) {
        logger.warn('Failed to update gas spent', { invoiceId, requestId, error: jsonifyError(err), purchaseTx });
      }

      // Add results for this intent
      purchaseIntentIds.forEach((intentId: string) => {
        results.push({
          transactionHash: purchaseTx.transactionHash,
          type: TransactionSubmissionType.Onchain,
          chainId: intent.origin,
          intentId,
        });
      });
    }

    return results;
  } catch (error) {
    logger.error('Error processing Tron intents', {
      invoiceId,
      requestId,
      error,
      intentCount: intents.length,
    });
    throw error;
  }
};
