import {
  MarkConfiguration,
  NewIntentParams,
  NewIntentWithPermit2Params,
  TransactionSubmissionType,
  TransactionRequest,
  WalletType,
} from '@mark/core';
import { getERC20Contract } from './contracts';
import { decodeEventLog, Hex } from 'viem';
import { TransactionReason } from '@mark/prometheus';
import {
  generatePermit2Nonce,
  generatePermit2Deadline,
  getPermit2Signature,
  approvePermit2,
  getPermit2Address,
} from './permit2';
import { prepareMulticall } from './multicall';
import { MarkAdapters } from '../init';
import { checkAndApproveERC20 } from './erc20';
import { submitTransactionWithLogging } from './transactions';
import { Logger } from '@mark/logger';
import { providers } from 'ethers';
import { getValidatedZodiacConfig, getActualOwner } from './zodiac';
import { isSvmChain, SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID, TOKEN_PROGRAM_ID, hexToBase58 } from '@mark/core';
import { LookupTableNotFoundError } from '@mark/everclear';

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
  receipt: providers.TransactionReceipt,
  chainId: string,
  logger: Logger,
  context?: { requestId: string; invoiceId: string },
) => {
  // Find the IntentAdded event logs
  const intentAddedLogs = receipt.logs.filter((l) => (l.topics[0] ?? '').toLowerCase() === INTENT_ADDED_TOPIC0);
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
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
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
      },
      zodiacConfig: originWalletConfig,
      context: { requestId, invoiceId, transactionType: 'batch-create-intent' },
    });

    const purchaseTx = purchaseResult.receipt!;

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

    prometheus.updateGasSpent(
      intents[0].origin,
      TransactionReason.CreateIntent,
      BigInt(purchaseTx.cumulativeGasUsed.mul(purchaseTx.effectiveGasPrice).toString()),
    );

    // Return results for each intent in the batch
    return purchaseIntentIds.map((intentId) => ({
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
          });

          logger.info('solana lookup table transaction sent successfully', {
            invoiceId,
            requestId,
            txHash: lookupTableTx.transactionHash,
            chainId: intents[0].origin,
          });
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
      });
      console.warn('debug tx', purchaseTx);

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

/**
 * Sends multiple intents in a single transaction using Multicall3 with Permit2 for token approvals
 * @param intents The intents to send with Permit2 parameters
 * @param deps The process dependencies (chainService, everclear, logger, etc.)
 * @returns Object containing transaction hash, chain ID, and a joined string of intent IDs
 */
export const sendIntentsMulticall = async (
  intents: NewIntentParams[],
  adapters: MarkAdapters,
  config: MarkConfiguration,
): Promise<{ transactionHash: string; chainId: string; intentId: string }> => {
  if (!intents || intents.length === 0) {
    throw new Error('No intents provided for multicall');
  }

  const { chainService, everclear, logger, prometheus, web3Signer } = adapters;

  const txs = [];

  // Same chain for all multicalled intents
  const chainId = intents[0].origin;

  // Create a combined intent ID for tracking
  const combinedIntentId = intents
    .map((i) => i.to)
    .join('_')
    .slice(0, 42);

  logger.info('Preparing multicall for intents with Permit2', {
    intentCount: intents.length,
    chainId,
    combinedIntentId,
  });

  try {
    try {
      // Check if Mark already has sufficient allowance for Permit2
      const tokenContract = await getERC20Contract(config, chainId, intents[0].inputAsset as `0x${string}`);
      const permit2Address = getPermit2Address(chainId, config);
      const allowance = await tokenContract.read.allowance([config.ownAddress, permit2Address as `0x${string}`]);

      // Simplification here, we assume Mark sets infinite approve on Permit2
      const hasAllowance = BigInt(allowance as string) > 0n;

      // If not approved yet, set infinite approve on Permit2
      if (!hasAllowance) {
        const txHash = await approvePermit2(tokenContract.address as `0x${string}`, chainService, config);

        // Verify allowance again after approval to ensure it worked
        const newAllowance = await tokenContract.read.allowance([config.ownAddress, permit2Address as `0x${string}`]);
        const newHasAllowance = BigInt(newAllowance as string) > 0n;

        if (!newHasAllowance) {
          throw new Error(`Permit2 approval transaction was submitted (${txHash}) but allowance is still zero`);
        }
      }
    } catch (error) {
      logger.error('Error signing/submitting Permit2 approval', {
        error: error instanceof Error ? error.message : error,
        chainId,
      });
      throw error;
    }

    // Generate a unique nonce for this batch of permits
    const nonce = generatePermit2Nonce();
    const deadline = generatePermit2Deadline();

    // Track used nonces to avoid duplicates
    const usedNonces = new Set();
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i];
      // Generate a unique nonce for each intent to avoid conflicts
      // Add an index suffix to ensure uniqueness within this batch
      const intentNonce = nonce + i.toString().padStart(2, '0');
      const tokenAddress = intent.inputAsset;
      const spender = config!.chains[chainId]!.deployments!.everclear;

      // Verify the spender address is properly set
      if (!spender) {
        throw new Error(`Everclear contract address not found for chain ID: ${chainId}`);
      }

      const amount = intent.amount.toString();

      // Get the Permit2 signature and request transaction data
      try {
        const signature = await getPermit2Signature(
          web3Signer,
          parseInt(chainId),
          tokenAddress,
          spender,
          amount,
          intentNonce, // Use the unique nonce
          deadline,
          config,
        );

        // Ensure nonce has 0x prefix when sending to the API
        let nonceForApi = intentNonce; // Use the unique nonce
        if (typeof intentNonce === 'string' && !intentNonce.startsWith('0x')) {
          nonceForApi = '0x' + intentNonce;
        }

        // Add to used nonces set to track uniqueness
        usedNonces.add(nonceForApi);

        // Add Permit2 parameters to the intent
        const intentWithPermit = {
          ...intent,
          permit2Params: {
            nonce: nonceForApi,
            deadline: deadline.toString(),
            signature,
          },
        };

        // Fetch transaction data for Permit2-enabled newIntent
        const txData = await everclear.createNewIntent(intentWithPermit);

        // Add transaction to the batch
        txs.push({
          to: txData.to as `0x${string}`,
          data: txData.data,
          value: '0', // Only sending ERC20 tokens, no native value
        });
      } catch (error) {
        logger.error('Error signing Permit2 message or fetching transaction data', {
          error: error instanceof Error ? error.message : error,
          tokenAddress,
          spender,
          amount,
          nonce,
          deadline: deadline.toString(),
        });
        throw error;
      }
    }

    // Prepare the multicall transaction (not sending native)
    const multicallTx = prepareMulticall(txs, false, chainId, config);

    logger.info('Preparing to submit multicall transaction', {
      to: multicallTx.to,
      chainId,
      combinedIntentId,
    });

    // Log transaction data for debugging
    logger.info('Multicall transaction details', {
      to: multicallTx.to,
      data: multicallTx.data,
      dataLength: multicallTx.data.length,
      value: '0',
    });

    const receipt = await chainService.submitAndMonitor(chainId.toString(), {
      to: multicallTx.to,
      data: multicallTx.data,
      value: '0',
      chainId: +chainId,
    });

    // Extract individual intent IDs from transaction logs
    const intentEvents = receipt.logs.filter((log) => log.topics[0].toLowerCase() === INTENT_ADDED_TOPIC0);
    const individualIntentIds = intentEvents.map((event) => event.topics[1]);

    logger.info('Multicall transaction confirmed', {
      transactionHash: receipt.transactionHash,
      chainId,
      combinedIntentId,
      individualIntentIds,
    });

    // Log each individual intent ID for DD searching
    individualIntentIds.forEach((intentId, index) => {
      logger.info('Individual intent created via multicall', {
        transactionHash: receipt.transactionHash,
        chainId,
        intentId,
        intentIndex: index,
        totalIntents: individualIntentIds.length,
      });
    });

    // Track gas spent for the multicall transaction
    if (prometheus) {
      prometheus.updateGasSpent(
        chainId.toString(),
        TransactionReason.CreateIntent,
        BigInt(receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice).toString()),
      );
    }

    return {
      transactionHash: receipt.transactionHash,
      chainId: chainId.toString(),
      intentId: combinedIntentId,
    };
  } catch (error) {
    logger.error('Failed to submit multicall transaction', {
      error,
      chainId,
      intentCount: intents.length,
    });
    throw error;
  }
};
