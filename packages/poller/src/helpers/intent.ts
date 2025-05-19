import { MarkConfiguration, NewIntentParams, NewIntentWithPermit2Params } from '@mark/core';
import { getERC20Contract } from './contracts';
import { encodeFunctionData, erc20Abi, decodeEventLog, isAddress as viemIsAddress, Hex } from 'viem';
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

// ABI for the Zodiac RoleModule's execTransactionWithRole function
const ZODIAC_ROLE_MODULE_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
      { internalType: 'uint8', name: 'operation', type: 'uint8' },
      { internalType: 'bytes32', name: 'roleKey', type: 'bytes32' },
      { internalType: 'bool', name: 'shouldRevert', type: 'bool' },
    ],
    name: 'execTransactionWithRole',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

/**
 * Uses the api to get the tx data and chainservice to send intents and approve assets if required.
 */
export const sendIntents = async (
  invoiceId: string,
  intents: NewIntentParams[],
  adapters: MarkAdapters,
  config: MarkConfiguration,
  requestId?: string,
): Promise<{ transactionHash: string; chainId: string; intentId: string }[]> => {
  const { everclear, chainService, prometheus, logger } = adapters;

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
  const chainConfig = config.chains[originChainId];
  const useZodiac =
    chainConfig?.zodiacRoleModuleAddress && chainConfig?.zodiacRoleKey && chainConfig?.gnosisSafeAddress;

  // Verify all intents have the same input asset
  const tokens = new Set(intents.map((intent) => intent.inputAsset));
  if (tokens.size !== 1) {
    throw new Error('Cannot process multiple intents with different input assets');
  }

  // Validate Zodiac config
  if (useZodiac) {
    if (
      !viemIsAddress(chainConfig.zodiacRoleModuleAddress!) ||
      !chainConfig.zodiacRoleKey!.startsWith('0x') ||
      !viemIsAddress(chainConfig.gnosisSafeAddress!)
    ) {
      logger.error('Invalid Zodiac configuration values', {
        invoiceId,
        requestId,
        zodiacRoleModuleAddress: chainConfig.zodiacRoleModuleAddress,
        zodiacRoleKey: chainConfig.zodiacRoleKey,
        gnosisSafeAddress: chainConfig.gnosisSafeAddress,
      });
      throw new Error('Invalid Zodiac configuration.');
    }

    const gnosisSafeAddress = chainConfig.gnosisSafeAddress!.toLowerCase();

    // Check for Zodiac rule violations
    for (const intent of intents) {
      if (intent.to.toLowerCase() !== gnosisSafeAddress) {
        throw new Error(`intent.to (${intent.to}) must be Gnosis Safe address (${gnosisSafeAddress})`);
      }
      if (BigInt(intent.maxFee.toString()) !== BigInt(0)) {
        throw new Error(`intent.maxFee (${intent.maxFee}) must be 0`);
      }
      if (intent.callData !== '0x') {
        throw new Error(`intent.callData (${intent.callData}) must be 0x`);
      }
    }
  }

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
    const ownerForAllowance = useZodiac ? chainConfig.gnosisSafeAddress! : config.ownAddress;

    logger.info('Total amount for approvals', {
      requestId,
      invoiceId,
      totalAmount: totalAmount.toString(),
      intentCount: intents.length,
      chainId: originChainId,
      owner: ownerForAllowance,
      spender: spenderForAllowance,
      useZodiac,
    });

    const tokenContract = await getERC20Contract(config, firstIntent.origin, firstIntent.inputAsset as `0x${string}`);
    const allowance = await tokenContract.read.allowance([ownerForAllowance as `0x${string}`, spenderForAllowance]);

    if (BigInt(allowance as string) < totalAmount) {
      logger.warn('Insufficient allowance. Proceeding with approval.', {
        invoiceId,
        requestId,
        required: totalAmount.toString(),
        allowance,
      });

      const chainAssets = config.chains[firstIntent.origin]?.assets ?? [];
      const isUSDT = chainAssets.some(
        (asset) =>
          asset.symbol.toUpperCase() === 'USDT' && asset.address.toLowerCase() === tokenContract.address.toLowerCase(),
      );

      // USDT approval must be set to 0
      if (isUSDT && BigInt(allowance as string) > BigInt(0)) {
        logger.info('USDT allowance is greater than zero, setting allowance to zero first', {
          requestId,
          invoiceId,
          allowance: allowance,
          spender: spenderForAllowance,
        });
        const zeroApproveCalldata = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spenderForAllowance, BigInt(0)],
        });

        let moduleZeroApprovalTo = tokenContract.address;
        let moduleZeroApprovalData = zeroApproveCalldata;

        if (useZodiac) {
          const zodiacModuleAddress = chainConfig.zodiacRoleModuleAddress as `0x${string}`;
          const zodiacRoleKey = chainConfig.zodiacRoleKey as Hex;
          moduleZeroApprovalData = encodeFunctionData({
            abi: ZODIAC_ROLE_MODULE_ABI,
            functionName: 'execTransactionWithRole',
            args: [
              tokenContract.address,
              BigInt(0),
              zeroApproveCalldata,
              0,
              zodiacRoleKey,
              true,
            ],
          });
          moduleZeroApprovalTo = zodiacModuleAddress;
        }

        const zeroApprovalTransaction = {
          to: moduleZeroApprovalTo,
          data: moduleZeroApprovalData,
          from: config.ownAddress,
        };

        const zeroAllowanceTx = await chainService.submitAndMonitor(originChainId, zeroApprovalTransaction);
        prometheus.updateGasSpent(
          firstIntent.origin,
          TransactionReason.Approval,
          BigInt(zeroAllowanceTx.cumulativeGasUsed.mul(zeroAllowanceTx.effectiveGasPrice).toString()),
        );
        logger.info('Zero allowance transaction for USDT sent successfully', {
          requestId,
          invoiceId,
          chainId: originChainId,
          zeroAllowanceTxHash: zeroAllowanceTx.transactionHash,
          asset: tokenContract.address,
        });
      }

      logger.info('Sending USDT zero-out transaction.', {
        invoiceId,
        requestId,
        spender: spenderForAllowance,
        amount: totalAmount.toString(),
      });

      // Approval transaction for the new intent call
      const approveCalldata = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spenderForAllowance, totalAmount],
      });

      let moduleApprovalTo = tokenContract.address;
      let moduleApprovalData = approveCalldata;

      if (useZodiac) {
        const zodiacModuleAddress = chainConfig.zodiacRoleModuleAddress as `0x${string}`;
        const zodiacRoleKey = chainConfig.zodiacRoleKey as Hex;
        moduleApprovalData = encodeFunctionData({
          abi: ZODIAC_ROLE_MODULE_ABI,
          functionName: 'execTransactionWithRole',
          args: [
            tokenContract.address,
            BigInt(0),
            approveCalldata,
            0,
            zodiacRoleKey,
            true,
          ],
        });
        moduleApprovalTo = zodiacModuleAddress;
      }

      const transaction = {
        to: moduleApprovalTo,
        data: moduleApprovalData,
        from: config.ownAddress,
      };

      logger.debug('Sending approval transaction', {
        requestId,
        invoiceId,
        transaction,
        chainId: originChainId,
      });

      const approvalTx = await chainService.submitAndMonitor(originChainId, transaction);
      prometheus.updateGasSpent(
        firstIntent.origin,
        TransactionReason.Approval,
        BigInt(approvalTx.cumulativeGasUsed.mul(approvalTx.effectiveGasPrice).toString()),
      );
      logger.info('Approval transaction sent successfully', {
        requestId,
        invoiceId,
        chainId: originChainId,
        approvalTxHash: approvalTx.transactionHash,
        allowance,
        asset: tokenContract.address,
        amount: totalAmount.toString(),
      });
    } else {
      logger.info('Sufficient allowance already available for all intents', {
        requestId,
        invoiceId,
        allowance,
        chainId: originChainId,
        asset: tokenContract.address,
        totalAmount: totalAmount.toString(),
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

    // Submit the batch transaction
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

    // Transaction will be newIntent (if single intent) or newOrder
    let purchaseTxTo = feeAdapterTxData.to as `0x${string}`;
    let purchaseTxData = feeAdapterTxData.data as Hex;
    let purchaseTxValue = (feeAdapterTxData.value ?? '0').toString();
    const purchaseTxFrom: string = config.ownAddress;

    if (useZodiac) {
      const zodiacModuleAddress = chainConfig.zodiacRoleModuleAddress as `0x${string}`;
      const zodiacRoleKey = chainConfig.zodiacRoleKey as Hex;

      purchaseTxTo = zodiacModuleAddress;
      purchaseTxData = encodeFunctionData({
        abi: ZODIAC_ROLE_MODULE_ABI,
        functionName: 'execTransactionWithRole',
        args: [
          feeAdapterTxData.to as `0x${string}`, // to
          BigInt(feeAdapterTxData.value ?? '0'), // value
          feeAdapterTxData.data as Hex, // data
          0, // operation (CALL)
          zodiacRoleKey, // roleKey
          true, // shouldRevert
        ],
      });
      purchaseTxValue = '0';

      logger.info('Preparing Zodiac transaction', {
        invoiceId,
        requestId,
        zodiacModuleAddress,
        roleKey: zodiacRoleKey,
        purchaseTxTo: feeAdapterTxData.to,
        purchaseTxValue: feeAdapterTxData.value,
        purchaseTxData: feeAdapterTxData.data,
      });
    }

    const purchaseTx = await chainService.submitAndMonitor(originChainId, {
      to: purchaseTxTo,
      value: purchaseTxValue,
      data: purchaseTxData,
      from: purchaseTxFrom,
    });

    // Find the IntentAdded event logs
    const intentAddedLogs = purchaseTx.logs.filter((l) => l.topics[0].toLowerCase() === INTENT_ADDED_TOPIC0);
    if (!intentAddedLogs.length) {
      logger.error('No intents created from purchase transaction', {
        invoiceId,
        requestId,
        transactionHash: purchaseTx.transactionHash,
        chainId: intents[0].origin,
        logs: purchaseTx.logs,
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
