import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { getEvmBalance, safeParseBigInt, convertToNativeUnits } from '../helpers';
import { jsonifyError } from '@mark/logger';
import {
  getDecimalsFromConfig,
  getTokenAddressFromConfig,
  MarkConfiguration,
  RebalanceOperationStatus,
  DBPS_MULTIPLIER,
  RebalanceAction,
  SupportedBridge,
  MAINNET_CHAIN_ID,
  MANTLE_CHAIN_ID,
  WalletType,
  PostBridgeActionConfig,
  TokenRebalanceConfig,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { RebalanceTransactionMemo, buildTransactionsForAction } from '@mark/rebalance';
import { createRebalanceOperation, TransactionReceipt } from '@mark/database';

// Default operation timeout: 24 hours (in minutes)
const DEFAULT_OPERATION_TTL_MINUTES = 24 * 60;

/**
 * Descriptor that parameterizes the generic Aave token rebalancer for a specific flow.
 */
export interface AaveTokenFlowDescriptor {
  /** Human-readable name, e.g., 'aManUSDe', 'aMansyrupUSDT' */
  name: string;
  /** Destination aToken ticker hash */
  aTokenTickerHash: string;
  /** Intermediate token ticker hash (e.g., USDe or syrupUSDT) */
  intermediateTokenTickerHash: string;
  /** Source token ticker hash bridged from mainnet (e.g., USDC) */
  sourceTokenTickerHash: string;
  /** DB tag for identifying operations, e.g., 'stargate-amanusde' */
  bridgeTag: string;
  /** Extract the relevant TokenRebalanceConfig from the overall config */
  getConfig: (config: MarkConfiguration) => TokenRebalanceConfig | undefined;
  /** Build the post-bridge action pipeline (DexSwap + AaveSupply) */
  buildPostBridgeActions: (params: {
    sourceTokenOnMantle: string;
    intermediateTokenOnMantle: string;
    aavePoolAddress: string;
    dexSwapSlippageBps: number;
  }) => PostBridgeActionConfig[];
  /** Get the Aave Pool address from env */
  getAavePoolAddress: () => string | undefined;
  /** Get the DEX swap slippage from env */
  getDexSwapSlippageBps: () => number;
}

/**
 * Shared state for tracking source token committed in this run.
 */
interface RebalanceRunState {
  committedSourceToken: bigint;
}

function isOperationTimedOut(createdAt: Date, ttlMinutes: number = DEFAULT_OPERATION_TTL_MINUTES): boolean {
  const maxAgeMs = ttlMinutes * 60 * 1000;
  const operationAgeMs = Date.now() - createdAt.getTime();
  return operationAgeMs > maxAgeMs;
}

/**
 * Main entry point for Aave token threshold-based rebalancing.
 *
 * Flow: Source Token (ETH) -> Stargate -> Source Token (Mantle) -> DEX Swap -> Intermediate Token -> Aave Supply -> aToken
 */
export async function rebalanceAaveToken(
  context: ProcessingContext,
  descriptor: AaveTokenFlowDescriptor,
): Promise<RebalanceAction[]> {
  const { logger, requestId, config, rebalance } = context;
  const actions: RebalanceAction[] = [];

  // Always process callbacks first to complete in-flight operations
  await executeAaveTokenCallbacks(context, descriptor);

  const tokenConfig = descriptor.getConfig(config);
  if (!tokenConfig?.enabled) {
    logger.debug(`${descriptor.name} rebalancing disabled`, { requestId });
    return actions;
  }

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('Rebalance loop is paused', { requestId });
    return actions;
  }

  // Validate required config
  const validationErrors: string[] = [];
  if (!tokenConfig.fillService?.address) {
    validationErrors.push('fillService.address is required');
  }
  if (!tokenConfig.bridge?.minRebalanceAmount) {
    validationErrors.push('bridge.minRebalanceAmount is required');
  }
  if (validationErrors.length > 0) {
    logger.error(`${descriptor.name} rebalance configuration validation failed`, {
      requestId,
      errors: validationErrors,
    });
    return actions;
  }

  logger.info(`Starting ${descriptor.name} rebalancing`, {
    requestId,
    ownAddress: config.ownAddress,
    wallets: {
      fillService: {
        address: tokenConfig.fillService.address,
        senderAddress: tokenConfig.fillService.senderAddress,
        thresholdEnabled: tokenConfig.fillService.thresholdEnabled,
        threshold: tokenConfig.fillService.threshold,
        targetBalance: tokenConfig.fillService.targetBalance,
      },
    },
  });

  const runState: RebalanceRunState = { committedSourceToken: 0n };

  const fsActions = await evaluateThresholdRebalance(context, descriptor, runState);
  actions.push(...fsActions);

  logger.info(`Completed ${descriptor.name} rebalancing cycle`, {
    requestId,
    totalActions: actions.length,
    totalCommitted: runState.committedSourceToken.toString(),
  });

  return actions;
}

/**
 * Evaluate Fill Service threshold rebalancing for an Aave token.
 *
 * Checks aToken balance on Mantle against the configured threshold.
 * If below threshold, bridges source token from ETH via Stargate.
 */
export const evaluateThresholdRebalance = async (
  context: ProcessingContext,
  descriptor: AaveTokenFlowDescriptor,
  runState: RebalanceRunState,
): Promise<RebalanceAction[]> => {
  const { config, logger, requestId, prometheus, database: db } = context;
  const tokenConfig = descriptor.getConfig(config)!;
  const fsConfig = tokenConfig.fillService;
  const bridgeConfig = tokenConfig.bridge;

  if (!fsConfig.thresholdEnabled) {
    logger.debug(`FS threshold rebalancing disabled for ${descriptor.name}`, { requestId });
    return [];
  }

  const actions: RebalanceAction[] = [];

  // Config values are in 18 decimals (normalized)
  const threshold = safeParseBigInt(fsConfig.threshold);
  const target = safeParseBigInt(fsConfig.targetBalance);
  const minRebalance = safeParseBigInt(bridgeConfig.minRebalanceAmount);

  // Get FS sender address (source token holder on ETH)
  const fsSenderAddress = fsConfig.senderAddress ?? fsConfig.address;

  // Check for in-flight operations to prevent overlapping rebalances
  const { operations: inFlightOps } = await db.getRebalanceOperations(undefined, undefined, {
    status: [
      RebalanceOperationStatus.PENDING,
      RebalanceOperationStatus.AWAITING_CALLBACK,
      RebalanceOperationStatus.AWAITING_POST_BRIDGE,
    ],
    bridge: descriptor.bridgeTag,
    earmarkId: null,
  });
  if (inFlightOps.length) {
    logger.info(`Found ${inFlightOps.length} in-flight ${descriptor.name} rebalance operations, skipping`, {
      requestId,
    });
    return actions;
  }

  // Get aToken balance on Mantle
  const aTokenAddress = getTokenAddressFromConfig(descriptor.aTokenTickerHash, MANTLE_CHAIN_ID, config);
  const aTokenDecimals = getDecimalsFromConfig(descriptor.aTokenTickerHash, MANTLE_CHAIN_ID, config);

  if (!aTokenAddress || !aTokenDecimals) {
    logger.error(`${descriptor.name} token not found in chain config for Mantle`, {
      requestId,
      tickerHash: descriptor.aTokenTickerHash,
      chainId: MANTLE_CHAIN_ID,
    });
    return actions;
  }

  let fsReceiverBalance = 0n;
  try {
    fsReceiverBalance = await getEvmBalance(
      config,
      MANTLE_CHAIN_ID,
      fsConfig.address!,
      aTokenAddress,
      aTokenDecimals,
      prometheus,
    );
  } catch (error) {
    logger.warn(`Failed to check FS receiver ${descriptor.name} balance`, {
      requestId,
      fsReceiverAddress: fsConfig.address,
      error: jsonifyError(error),
    });
    return actions;
  }

  logger.info(`Checking FS receiver ${descriptor.name} balance`, {
    requestId,
    fillServiceAddress: fsConfig.address,
    senderAddress: fsSenderAddress,
    fsReceiverBalance: fsReceiverBalance.toString(),
    committedSourceToken: runState.committedSourceToken.toString(),
    threshold: threshold.toString(),
    target: target.toString(),
    minRebalance: minRebalance.toString(),
  });

  if (fsReceiverBalance >= threshold) {
    logger.info(`FS receiver has enough ${descriptor.name}, no rebalance needed`, {
      requestId,
      fsReceiverBalance: fsReceiverBalance.toString(),
      threshold: threshold.toString(),
    });
    return actions;
  }

  // Calculate shortfall in 18 decimals (normalized)
  const shortfall = target - fsReceiverBalance;

  // Convert shortfall from 18 decimals to source token native decimals
  const sourceTokenDecimals = getDecimalsFromConfig(descriptor.sourceTokenTickerHash, MAINNET_CHAIN_ID, config);
  if (!sourceTokenDecimals) {
    logger.error('Source token decimals not found in chain config for mainnet', { requestId });
    return actions;
  }
  const shortfallInSourceToken = convertToNativeUnits(shortfall, sourceTokenDecimals);

  if (shortfallInSourceToken < minRebalance) {
    logger.debug('FS shortfall below minimum rebalance amount, skipping', {
      requestId,
      shortfall: shortfall.toString(),
      shortfallInSourceToken: shortfallInSourceToken.toString(),
      minRebalance: minRebalance.toString(),
    });
    return actions;
  }

  // Get FS sender's source token balance on Mainnet
  const sourceTokenAddress = getTokenAddressFromConfig(descriptor.sourceTokenTickerHash, MAINNET_CHAIN_ID, config);
  if (!sourceTokenAddress) {
    logger.error('Source token address not found in chain config for mainnet', { requestId });
    return actions;
  }

  let fsSenderBalance = 0n;
  if (fsSenderAddress) {
    try {
      fsSenderBalance = await getEvmBalance(
        config,
        MAINNET_CHAIN_ID,
        fsSenderAddress,
        sourceTokenAddress,
        sourceTokenDecimals,
        prometheus,
      );
    } catch (error) {
      logger.warn('Failed to check FS sender source token balance', {
        requestId,
        fsSenderAddress,
        error: jsonifyError(error),
      });
      return actions;
    }
  }

  // getEvmBalance returns 18-decimal normalized, convert to native
  const fsSenderNative = convertToNativeUnits(fsSenderBalance, sourceTokenDecimals);

  // Calculate amount to bridge: min(shortfall, available balance)
  let amountToBridge = fsSenderNative < shortfallInSourceToken ? fsSenderNative : shortfallInSourceToken;

  // Cap at maxRebalanceAmount if set
  if (bridgeConfig.maxRebalanceAmount) {
    const maxAmount = safeParseBigInt(bridgeConfig.maxRebalanceAmount);
    if (maxAmount > 0n && amountToBridge > maxAmount) {
      amountToBridge = maxAmount;
    }
  }

  if (amountToBridge < minRebalance) {
    logger.warn('Available source token below minimum rebalance threshold, skipping', {
      requestId,
      availableAmount: amountToBridge.toString(),
      minRebalance: minRebalance.toString(),
    });
    return actions;
  }

  logger.info(`FS threshold rebalancing triggered for ${descriptor.name}`, {
    requestId,
    fsSenderBalance: fsSenderNative.toString(),
    shortfallInSourceToken: shortfallInSourceToken.toString(),
    amountToBridge: amountToBridge.toString(),
    recipient: fsConfig.address,
  });

  // Execute Stargate bridge
  const bridgeActions = await executeStargateBridgeForAaveToken(
    context,
    descriptor,
    fsSenderAddress!,
    fsConfig.address!,
    amountToBridge,
  );

  if (bridgeActions.length > 0) {
    runState.committedSourceToken += amountToBridge;
    logger.debug('Updated committed funds after Stargate bridge', {
      requestId,
      bridgedAmount: amountToBridge.toString(),
      totalCommitted: runState.committedSourceToken.toString(),
    });
  }

  actions.push(...bridgeActions);
  return actions;
};

/**
 * Execute Stargate bridge: source token from ETH to Mantle.
 */
export const executeStargateBridgeForAaveToken = async (
  context: ProcessingContext,
  descriptor: AaveTokenFlowDescriptor,
  senderAddress: string,
  recipientAddress: string,
  amount: bigint,
): Promise<RebalanceAction[]> => {
  const { config, chainService, fillServiceChainService, logger, requestId, rebalance } = context;
  const tokenConfig = descriptor.getConfig(config)!;
  const bridgeConfig = tokenConfig.bridge;
  const actions: RebalanceAction[] = [];

  const bridgeType = SupportedBridge.Stargate;
  const adapter = rebalance.getAdapter(bridgeType);
  if (!adapter) {
    logger.error('Stargate adapter not found', { requestId });
    return actions;
  }

  // Select the correct chain service based on whether the sender is the fill service address
  const fsConfig = tokenConfig.fillService;
  const fillerSenderAddress = fsConfig.senderAddress ?? fsConfig.address;
  const isFillerSender = senderAddress.toLowerCase() === fillerSenderAddress?.toLowerCase();
  const selectedChainService = isFillerSender && fillServiceChainService ? fillServiceChainService : chainService;

  if (isFillerSender && !fillServiceChainService) {
    logger.error(`Fill service chain service not available but sender is fill service address for ${descriptor.name}`, {
      requestId,
      senderAddress,
      fillerSenderAddress,
    });
    return actions;
  }

  const sourceTokenAddress = getTokenAddressFromConfig(descriptor.sourceTokenTickerHash, MAINNET_CHAIN_ID, config)!;
  const slippageDbps = bridgeConfig.slippageDbps;

  const route = {
    asset: sourceTokenAddress,
    origin: Number(MAINNET_CHAIN_ID),
    destination: Number(MANTLE_CHAIN_ID),
    maximum: amount.toString(),
    slippagesDbps: [slippageDbps],
    preferences: [bridgeType],
    reserve: '0',
  };

  logger.info(`Attempting Stargate bridge for ${descriptor.name}`, {
    requestId,
    bridgeType,
    amount: amount.toString(),
    senderAddress,
    recipientAddress,
    usingFillServiceSigner: isFillerSender,
    route,
  });

  try {
    // Get quote
    const receivedAmountStr = await adapter.getReceivedAmount(amount.toString(), route);
    logger.info('Received Stargate quote', {
      requestId,
      amountToBridge: amount.toString(),
      receivedAmount: receivedAmountStr,
    });

    // Check slippage
    const receivedAmount = BigInt(receivedAmountStr);
    const slippage = BigInt(slippageDbps);
    const minimumAcceptableAmount = amount - (amount * slippage) / DBPS_MULTIPLIER;

    if (receivedAmount < minimumAcceptableAmount) {
      logger.warn('Stargate quote does not meet slippage requirements', {
        requestId,
        amountToBridge: amount.toString(),
        receivedAmount: receivedAmount.toString(),
        minimumAcceptableAmount: minimumAcceptableAmount.toString(),
        slippageDbps,
      });
      return actions;
    }

    // Get bridge transactions
    const bridgeTxRequests = await adapter.send(senderAddress, recipientAddress, amount.toString(), route);
    if (!bridgeTxRequests.length) {
      logger.error('No bridge transactions returned from Stargate adapter', { requestId });
      return actions;
    }

    logger.info('Prepared Stargate bridge transactions', {
      requestId,
      transactionCount: bridgeTxRequests.length,
    });

    // Execute bridge transactions
    let receipt: TransactionReceipt | undefined;
    let effectiveBridgedAmount = amount.toString();

    for (const { transaction, memo, effectiveAmount } of bridgeTxRequests) {
      logger.info('Submitting Stargate bridge transaction', {
        requestId,
        memo,
        to: transaction.to,
      });

      const result = await submitTransactionWithLogging({
        chainService: selectedChainService,
        logger,
        chainId: MAINNET_CHAIN_ID,
        txRequest: {
          to: transaction.to!,
          data: transaction.data!,
          value: (transaction.value || 0).toString(),
          chainId: Number(MAINNET_CHAIN_ID),
          from: senderAddress,
          funcSig: transaction.funcSig || '',
        },
        zodiacConfig: { walletType: WalletType.EOA },
        context: { requestId, route, bridgeType, transactionType: memo },
      });

      logger.info('Successfully submitted Stargate bridge transaction', {
        requestId,
        memo,
        transactionHash: result.hash,
      });

      if (memo === RebalanceTransactionMemo.Rebalance) {
        receipt = result.receipt! as unknown as TransactionReceipt;
        if (effectiveAmount) {
          effectiveBridgedAmount = effectiveAmount;
        }
      }
    }

    // Create database record
    await createRebalanceOperation({
      earmarkId: null,
      originChainId: route.origin,
      destinationChainId: route.destination,
      tickerHash: descriptor.sourceTokenTickerHash,
      amount: effectiveBridgedAmount,
      slippage: slippageDbps,
      status: RebalanceOperationStatus.PENDING,
      bridge: descriptor.bridgeTag,
      transactions: receipt ? { [MAINNET_CHAIN_ID]: receipt } : undefined,
      recipient: recipientAddress,
    });

    logger.info(`Successfully created ${descriptor.name} rebalance operation`, {
      requestId,
      originTxHash: receipt?.transactionHash,
      amountToBridge: effectiveBridgedAmount,
      bridge: descriptor.bridgeTag,
    });

    actions.push({
      bridge: bridgeType,
      amount: amount.toString(),
      origin: route.origin,
      destination: route.destination,
      asset: route.asset,
      transaction: receipt?.transactionHash || '',
      recipient: recipientAddress,
    });
  } catch (error) {
    logger.error(`Failed to execute Stargate bridge for ${descriptor.name}`, {
      requestId,
      route,
      error: jsonifyError(error),
    });
  }

  return actions;
};

/**
 * Callback handler for in-flight Aave token rebalance operations.
 *
 * Handles the state machine:
 *   PENDING -> readyOnDestination check -> AWAITING_CALLBACK
 *   AWAITING_CALLBACK -> destinationCallback -> AWAITING_POST_BRIDGE
 *   AWAITING_POST_BRIDGE -> DexSwap + AaveSupply -> COMPLETED
 */
export const executeAaveTokenCallbacks = async (
  context: ProcessingContext,
  descriptor: AaveTokenFlowDescriptor,
): Promise<void> => {
  const { logger, requestId, config, rebalance, chainService, fillServiceChainService, database: db } = context;
  logger.info(`Executing callbacks for ${descriptor.name} rebalance`, { requestId });

  const operationTtlMinutes = config.regularRebalanceOpTTLMinutes ?? DEFAULT_OPERATION_TTL_MINUTES;

  // Get all in-flight operations for this flow
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: [
      RebalanceOperationStatus.PENDING,
      RebalanceOperationStatus.AWAITING_CALLBACK,
      RebalanceOperationStatus.AWAITING_POST_BRIDGE,
    ],
    bridge: descriptor.bridgeTag,
  });

  logger.debug(`Found ${operations.length} ${descriptor.name} rebalance operations`, {
    count: operations.length,
    requestId,
    operationTtlMinutes,
  });

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
      status: operation.status,
    };

    // Determine if this is for Fill Service or Market Maker based on recipient
    const tokenConfig = descriptor.getConfig(config);
    const fsAddress = tokenConfig?.fillService?.address;
    const isForFillService = operation.recipient?.toLowerCase() === fsAddress?.toLowerCase();
    const fillerSenderAddress = tokenConfig?.fillService?.senderAddress ?? fsAddress;
    const selectedSender = isForFillService && fillerSenderAddress ? fillerSenderAddress : config.ownAddress;
    const selectedChainService = isForFillService && fillServiceChainService ? fillServiceChainService : chainService;

    if (isForFillService && !fillServiceChainService) {
      logger.warn(
        `Fill service chain service not available for ${descriptor.name} callback, using main chain service`,
        {
          ...logContext,
          recipient: operation.recipient,
          fsAddress,
        },
      );
    }

    // Check for operation timeout
    if (operation.createdAt && isOperationTimedOut(operation.createdAt, operationTtlMinutes)) {
      const operationAgeMinutes = Math.round((Date.now() - operation.createdAt.getTime()) / (60 * 1000));
      logger.warn(`${descriptor.name} operation timed out, marking as cancelled`, {
        ...logContext,
        createdAt: operation.createdAt.toISOString(),
        operationAgeMinutes,
        ttlMinutes: operationTtlMinutes,
      });

      try {
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.CANCELLED,
        });
      } catch (error) {
        logger.error('Failed to cancel timed-out operation', {
          ...logContext,
          error: jsonifyError(error),
        });
      }
      continue;
    }

    // Strip bridge tag to get the actual adapter name: 'stargate-amanusde' -> 'stargate'
    const bridgeType = operation.bridge?.split('-')[0] as SupportedBridge;
    const adapter = rebalance.getAdapter(bridgeType);

    if (!adapter) {
      logger.warn('Adapter not found for bridge type', { ...logContext, bridgeType });
      continue;
    }

    // Get origin transaction receipt
    const originTx = operation.transactions?.[operation.originChainId] as
      | { transactionHash: string; metadata?: { receipt?: TransactionReceipt } }
      | undefined;
    const receipt = originTx?.metadata?.receipt;

    // --- Handle PENDING: check if bridge completed on destination ---
    if (operation.status === RebalanceOperationStatus.PENDING) {
      if (!receipt) {
        logger.info('Origin transaction receipt not found for operation', logContext);
        continue;
      }

      try {
        const route = {
          origin: operation.originChainId,
          destination: operation.destinationChainId,
          asset: getTokenAddressFromConfig(operation.tickerHash, operation.originChainId.toString(), config) || '',
        };

        const ready = await adapter.readyOnDestination(
          operation.amount,
          route,
          receipt as unknown as ViemTransactionReceipt,
        );

        if (ready) {
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
          });
          logger.info('Stargate bridge ready on destination, updated to AWAITING_CALLBACK', logContext);
          operation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        } else {
          logger.info('Stargate bridge not yet ready on destination', logContext);
          continue;
        }
      } catch (e) {
        logger.error('Failed to check readyOnDestination', { ...logContext, error: jsonifyError(e) });
        continue;
      }
    }

    // --- Handle AWAITING_CALLBACK: execute destination callback, transition to post-bridge ---
    if (operation.status === RebalanceOperationStatus.AWAITING_CALLBACK) {
      try {
        const route = {
          origin: operation.originChainId,
          destination: operation.destinationChainId,
          asset: getTokenAddressFromConfig(operation.tickerHash, operation.originChainId.toString(), config) || '',
        };

        let callback = null;
        if (receipt) {
          try {
            callback = await adapter.destinationCallback(route, receipt as unknown as ViemTransactionReceipt);
          } catch (e) {
            logger.error('Failed to retrieve destination callback', { ...logContext, error: jsonifyError(e) });
            continue;
          }
        }

        if (callback) {
          const callbackSender = operation.recipient ?? selectedSender;

          const tx = await submitTransactionWithLogging({
            chainService: selectedChainService,
            logger,
            chainId: operation.destinationChainId.toString(),
            txRequest: {
              chainId: operation.destinationChainId,
              to: callback.transaction.to!,
              data: callback.transaction.data!,
              value: (callback.transaction.value ?? BigInt(0)).toString(),
              from: callbackSender,
              funcSig: callback.transaction.funcSig || '',
            },
            zodiacConfig: { walletType: WalletType.EOA },
            context: { ...logContext, callbackType: `destination: ${callback.memo}` },
          });

          logger.info('Successfully submitted destination callback', {
            ...logContext,
            transactionHash: tx.hash,
          });
        } else {
          logger.info('No destination callback required for Stargate', logContext);
        }

        // Transition to AWAITING_POST_BRIDGE for DexSwap + AaveSupply
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.AWAITING_POST_BRIDGE,
        });
        logger.info('Transitioned to AWAITING_POST_BRIDGE for post-bridge actions', logContext);
        operation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
      } catch (e) {
        logger.error('Failed to process AWAITING_CALLBACK', { ...logContext, error: jsonifyError(e) });
        continue;
      }
    }

    // --- Handle AWAITING_POST_BRIDGE: execute DexSwap + AaveSupply ---
    if (operation.status === RebalanceOperationStatus.AWAITING_POST_BRIDGE) {
      const aavePoolAddress = descriptor.getAavePoolAddress();
      const dexSwapSlippageBps = descriptor.getDexSwapSlippageBps();

      if (!aavePoolAddress) {
        logger.error(
          `Aave pool address not set for ${descriptor.name}, cannot execute post-bridge actions`,
          logContext,
        );
        continue;
      }

      const sourceTokenOnMantle = getTokenAddressFromConfig(descriptor.sourceTokenTickerHash, MANTLE_CHAIN_ID, config);
      const intermediateTokenOnMantle = getTokenAddressFromConfig(
        descriptor.intermediateTokenTickerHash,
        MANTLE_CHAIN_ID,
        config,
      );

      if (!sourceTokenOnMantle || !intermediateTokenOnMantle) {
        const availableAssets = (config.chains[MANTLE_CHAIN_ID]?.assets ?? []).map((a) => a.symbol);
        logger.error('Source or intermediate token address not found in chain config for Mantle', {
          ...logContext,
          sourceTokenOnMantle,
          intermediateTokenOnMantle,
          sourceTokenTickerHash: descriptor.sourceTokenTickerHash,
          intermediateTokenTickerHash: descriptor.intermediateTokenTickerHash,
          availableAssetsOnMantle: availableAssets,
        });
        continue;
      }

      const postBridgeActions = descriptor.buildPostBridgeActions({
        sourceTokenOnMantle,
        intermediateTokenOnMantle,
        aavePoolAddress,
        dexSwapSlippageBps,
      });

      // Use operation.recipient — that's where the bridge deposits tokens on the
      // destination chain, so balance/allowance checks must target that address.
      const actualSender = operation.recipient ?? selectedSender;

      try {
        logger.info(`Executing post-bridge actions for ${descriptor.name}`, {
          ...logContext,
          actionCount: postBridgeActions.length,
          sourceTokenOnMantle,
          intermediateTokenOnMantle,
          aavePoolAddress,
          dexSwapSlippageBps,
        });

        let currentAmount = operation.amount;

        for (let i = 0; i < postBridgeActions.length; i++) {
          const action = postBridgeActions[i];

          logger.info('Building transactions for post-bridge action', {
            ...logContext,
            actionIndex: i,
            actionType: action.type,
            currentAmount,
          });

          const actionTxs = await buildTransactionsForAction(
            actualSender,
            currentAmount,
            operation.destinationChainId,
            action,
            config.chains,
            logger,
            config.quoteServiceUrl,
          );

          if (actionTxs.length === 0) {
            // Use maxUint256 so subsequent actions determine amount from on-chain balance
            currentAmount = (2n ** 256n - 1n).toString();
            logger.info('Post-bridge action returned no transactions, advancing to next action', {
              ...logContext,
              actionIndex: i,
              actionType: action.type,
            });
            continue;
          }

          for (const actionTx of actionTxs) {
            await submitTransactionWithLogging({
              chainService: selectedChainService,
              logger,
              chainId: operation.destinationChainId.toString(),
              txRequest: {
                chainId: operation.destinationChainId,
                to: actionTx.transaction.to!,
                data: actionTx.transaction.data!,
                value: (actionTx.transaction.value ?? BigInt(0)).toString(),
                from: actualSender,
                funcSig: actionTx.transaction.funcSig || '',
              },
              zodiacConfig: { walletType: WalletType.EOA },
              context: { ...logContext, callbackType: `post-bridge: ${actionTx.memo}` },
            });

            if (actionTx.effectiveAmount) {
              currentAmount = actionTx.effectiveAmount;
            }
          }
        }

        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
        });

        logger.info(`${descriptor.name} post-bridge actions completed successfully`, logContext);
      } catch (e) {
        // Leave as AWAITING_POST_BRIDGE for retry on next poll cycle
        logger.error('Failed to execute post-bridge actions, will retry', {
          ...logContext,
          error: jsonifyError(e),
        });
      }
    }
  }
};
