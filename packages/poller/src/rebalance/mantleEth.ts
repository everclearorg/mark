import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import {
  getTickerForAsset,
  convertToNativeUnits,
  getMarkBalancesForTicker,
  getEvmBalance,
  safeParseBigInt,
} from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import {
  getDecimalsFromConfig,
  RebalanceOperationStatus,
  DBPS_MULTIPLIER,
  RebalanceAction,
  SupportedBridge,
  MAINNET_CHAIN_ID,
  MANTLE_CHAIN_ID,
  getTokenAddressFromConfig,
  WalletType,
  serializeBigInt,
  EarmarkStatus,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { getActualAddress } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { MemoizedTransactionRequest, RebalanceTransactionMemo } from '@mark/rebalance';
import { createEarmark, createRebalanceOperation, Earmark, removeEarmark, TransactionEntry, TransactionReceipt } from '@mark/database';
import { IntentStatus } from '@mark/everclear';

const WETH_TICKER_HASH = '0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8';
const METH_TICKER_HASH = '0xd5a2aecb01320815a5625da6d67fbe0b34c12b267ebb3b060c014486ec5484d8';

// Default operation timeout: 24 hours (in minutes)
const DEFAULT_OPERATION_TTL_MINUTES = 24 * 60;

/**
 * Check if an operation has exceeded its TTL (time-to-live).
 * Operations stuck in PENDING or AWAITING_CALLBACK for too long should be marked as failed.
 *
 * @param createdAt - Operation creation timestamp
 * @param ttlMinutes - TTL in minutes (default: 24 hours)
 * @returns true if operation has timed out
 */
function isOperationTimedOut(createdAt: Date, ttlMinutes: number = DEFAULT_OPERATION_TTL_MINUTES): boolean {
  const maxAgeMs = ttlMinutes * 60 * 1000;
  const operationAgeMs = Date.now() - createdAt.getTime();
  return operationAgeMs > maxAgeMs;
}

type ExecuteBridgeContext = Pick<ProcessingContext, 'logger' | 'chainService' | 'config' | 'requestId'>;

interface SenderConfig {
  address: string; // Sender's Ethereum address
  signerUrl?: string; // Web3signer URL for this sender (uses default if not specified)
  label: 'market-maker' | 'fill-service'; // For logging
}
interface ExecuteBridgeParams {
  context: ExecuteBridgeContext;
  route: {
    origin: number;
    destination: number;
    asset: string;
  };
  bridgeType: SupportedBridge;
  bridgeTxRequests: MemoizedTransactionRequest[];
  amountToBridge: bigint;
  senderOverride?: SenderConfig; // Optional: use different sender than config.ownAddress
}

interface ExecuteBridgeResult {
  receipt?: TransactionReceipt;
  effectiveBridgedAmount: string;
}

/**
 * Shared state for tracking WETH that has been committed in this run
 * This prevents over-committing when both MM and FS need rebalancing simultaneously
 */
interface RebalanceRunState {
  committedEthWeth: bigint; // Amount of ETH WETH committed in this run (not yet confirmed on-chain)
}
interface ThresholdRebalanceParams {
  context: ProcessingContext;
  origin: string;
  recipientAddress: string;
  amountToBridge: bigint;
  runState: RebalanceRunState;
  earmarkId: string | null; // null for threshold-based
}


/**
 * Submits a sequence of bridge transactions and returns the final receipt and effective bridged amount.
 * @param senderOverride - If provided, uses this address as sender instead of config.ownAddress
 */
const executeBridgeTransactions = async ({
  context,
  route,
  bridgeType,
  bridgeTxRequests,
  amountToBridge,
  senderOverride,
}: ExecuteBridgeParams): Promise<ExecuteBridgeResult> => {
  const { logger, chainService, config, requestId } = context;

  // Use sender override if provided, otherwise default to ownAddress
  const senderAddress = senderOverride?.address ?? config.ownAddress;
  const senderLabel = senderOverride?.label ?? 'market-maker';

  let idx = -1;
  let effectiveBridgedAmount = amountToBridge.toString();
  let receipt: TransactionReceipt | undefined;

  for (const { transaction, memo, effectiveAmount } of bridgeTxRequests) {
    idx++;
    logger.info('Submitting bridge transaction', {
      requestId,
      route,
      bridgeType,
      transactionIndex: idx,
      totalTransactions: bridgeTxRequests.length,
      transaction,
      memo,
      amountToBridge,
      sender: senderAddress,
      senderType: senderLabel,
    });

    const result = await submitTransactionWithLogging({
      chainService,
      logger,
      chainId: route.origin.toString(),
      txRequest: {
        to: transaction.to!,
        data: transaction.data!,
        value: (transaction.value || 0).toString(),
        chainId: route.origin,
        from: senderAddress,
        funcSig: transaction.funcSig || '',
      },
      zodiacConfig: {
        walletType: WalletType.EOA,
      },
      context: { requestId, route, bridgeType, transactionType: memo, sender: senderLabel },
    });

    logger.info('Successfully submitted bridge transaction', {
      requestId,
      route,
      bridgeType,
      transactionIndex: idx,
      totalTransactions: bridgeTxRequests.length,
      transactionHash: result.hash,
      memo,
      amountToBridge,
    });

    if (memo !== RebalanceTransactionMemo.Rebalance) {
      continue;
    }

    receipt = result.receipt! as unknown as TransactionReceipt;
    if (effectiveAmount) {
      effectiveBridgedAmount = effectiveAmount;
      logger.info('Using effective bridged amount from adapter', {
        requestId,
        originalAmount: amountToBridge.toString(),
        effectiveAmount: effectiveBridgedAmount,
        bridgeType,
      });
    }
  }

  return { receipt, effectiveBridgedAmount };
};

export async function rebalanceMantleEth(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, rebalance } = context;
  const actions: RebalanceAction[] = [];

  // Always check destination callbacks to ensure operations complete
  await executeMethCallbacks(context);

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('mETH Rebalance loop is paused', { requestId });
    return actions;
  }

  const methRebalanceConfig = config.methRebalance;
  if (!methRebalanceConfig?.enabled) {
    logger.warn('mETH Rebalance is not enabled', { requestId });
    return actions;
  }

  // Validate critical configuration before proceeding
  const validationErrors: string[] = [];
  if (!methRebalanceConfig.fillService?.address) {
    validationErrors.push('fillService.address is required');
  }
  if (!methRebalanceConfig.bridge?.minRebalanceAmount) {
    validationErrors.push('bridge.minRebalanceAmount is required');
  }
  if (validationErrors.length > 0) {
    logger.error('mETH rebalance configuration validation failed', {
      requestId,
      errors: validationErrors,
    });
    return actions;
  }

  logger.info('Starting mETH rebalancing', {
    requestId,
    ownAddress: config.ownAddress,
    wallets: {
      marketMaker: {
        walletType: 'market-maker',
        address: methRebalanceConfig.marketMaker.address,
        onDemandEnabled: methRebalanceConfig.marketMaker.onDemandEnabled,
        thresholdEnabled: methRebalanceConfig.marketMaker.thresholdEnabled,
        threshold: methRebalanceConfig.marketMaker.threshold,
        targetBalance: methRebalanceConfig.marketMaker.targetBalance,
      },
      fillService: {
        walletType: 'fill-service',
        address: methRebalanceConfig.fillService.address,
        senderAddress: methRebalanceConfig.fillService.senderAddress,
        thresholdEnabled: methRebalanceConfig.fillService.thresholdEnabled,
        threshold: methRebalanceConfig.fillService.threshold,
        targetBalance: methRebalanceConfig.fillService.targetBalance,
      },
    },
  });

  // Track committed funds to prevent over-committing in this run
  const runState: RebalanceRunState = {
    committedEthWeth: 0n,
  };

  // Evaluate Fill Service path (threshold-based only)
  const fsActions = await evaluateFillServiceRebalance(context, runState);
  actions.push(...fsActions);

  logger.info('Completed mETH rebalancing cycle', {
    requestId,
    totalActions: actions.length,
    fsActions: fsActions.length,
    totalCommitted: runState.committedEthWeth.toString(),
  });

  return actions;
}

/**
 * Evaluate Fill Service rebalancing with priority logic:
 *
 * PRIORITY 1: Same-Account Flow (FS → FS)
 *   - Use FS sender's own ETH WETH to bridge to FS mETH address
 *   - This is always preferred as it doesn't require cross-wallet coordination
 *
 */
const evaluateFillServiceRebalance = async (
  context: ProcessingContext,
  runState: RebalanceRunState,
): Promise<RebalanceAction[]> => {
  const { config, logger, requestId, prometheus, fillServiceChainService, everclear, database } = context;

  const fsConfig = config.methRebalance!.fillService;
  const bridgeConfig = config.methRebalance!.bridge;
  if (!fsConfig.thresholdEnabled) {
    logger.debug('FS threshold rebalancing disabled', { requestId });
    return [];
  }

  if (!fillServiceChainService) {
    logger.warn('Fill service chain service not found, skipping', { requestId });
    return [];
  }

  const actions: RebalanceAction[] = [];

  // WETH/mETH use 18 decimals natively, so config values are already in wei (18 decimals)
  // Example: threshold of 1 ETH = "1000000000000000000" (18 zeros)
  // No decimal conversion needed - we use values directly as they are in native token units
  const threshold = safeParseBigInt(fsConfig.threshold);
  const target = safeParseBigInt(fsConfig.targetBalance);
  const minRebalance = safeParseBigInt(bridgeConfig.minRebalanceAmount);

  // Get FS sender address (used for same-account flow)
  const fsSenderAddress = fsConfig.senderAddress ?? fsConfig.address;

  logger.info('Evaluating FS rebalancing options', {
    requestId,
    walletType: 'fill-service',
    fsAddress: fsConfig.address,
    fsSenderAddress,
    hasFillServiceChainService: !!fillServiceChainService,
  });

  // PRIORITY 1: Intent Based Flow (FS → FS)
  // Get all intents to mantle
  // add parameters to filter intents: status: IntentStatus.SETTLED_AND_COMPLETED, origin: any, destination: MANTLE_CHAINID
  // TODO: check startDate to avoid processing duplicates
  // Note: outputAsset is NOT supported by the Everclear API - we use tickerHash instead
  const intents = await everclear.fetchIntents({
    limit: 20,
    statuses: [IntentStatus.SETTLED_AND_COMPLETED],
    destinations: [MANTLE_CHAIN_ID],
    tickerHash: WETH_TICKER_HASH,
    isFastPath: true,
  });

  // Get all of mark balances
  const balances = await getMarkBalancesForTicker(
    WETH_TICKER_HASH,
    config,
    fillServiceChainService!,
    context.prometheus,
  );
  logger.debug('Retrieved all solver balances for WETH', { balances: jsonifyMap(balances) });
  if (!balances) {
    logger.warn('No balances found for WETH, skipping', { requestId });
    return [];
  }

  for (const intent of intents) {
    logger.info('Processing mETH intent for rebalance', { requestId, intent });

    if (!intent.hub_settlement_domain) {
      logger.warn('Intent does not have a hub settlement domain, skipping', { requestId, intent });
      continue;
    }

    if (intent.destinations.length !== 1 || intent.destinations[0] !== MANTLE_CHAIN_ID) {
      logger.warn('Intent does not have exactly one destination - mantle, skipping', { requestId, intent });
      continue;
    }

    // Check if an active earmark already exists for this intent before executing operations
    const existingActive = await database.getActiveEarmarkForInvoice(intent.intent_id);

    if (existingActive) {
      logger.warn('Active earmark already exists for intent, skipping rebalance operations', {
        requestId,
        invoiceId: intent.intent_id,
        existingEarmarkId: existingActive.id,
        existingStatus: existingActive.status,
      });
      continue;
    }

    const origin = Number(intent.hub_settlement_domain);

    // WETH -> mETH intent should be settled with WETH address on settlement domain
    const decimals = getDecimalsFromConfig(WETH_TICKER_HASH, origin.toString(), config);
    const intentAmount = convertToNativeUnits(safeParseBigInt(intent.amount_out_min), decimals);
    if (intentAmount < minRebalance) {
      logger.warn('Intent amount is less than min staking amount, skipping', {
        requestId,
        intent,
        intentAmount: intentAmount.toString(),
        minAmount: minRebalance.toString(),
      });
      continue;
    }

    const availableBalance = balances.get(origin.toString()) || 0n;

    // Ticker balances always in 18 units, convert to proper decimals
    const currentBalance = convertToNativeUnits(availableBalance, decimals);
    logger.debug('Current WETH balance on origin chain.', { requestId, currentBalance: currentBalance.toString() });

    if (currentBalance < intentAmount) {
      logger.info('Balance is below intent amount, skipping route', {
        requestId,
        currentBalance: currentBalance.toString(),
        minAmount: intentAmount.toString(),
      });
      continue; // Skip to next route
    }

    const amountToBridge = intentAmount;
    let earmark: Earmark;
    try {
      earmark = await createEarmark({
        invoiceId: intent.intent_id,
        designatedPurchaseChain: Number(MANTLE_CHAIN_ID),
        tickerHash: WETH_TICKER_HASH,
        minAmount: amountToBridge.toString(),
        status: EarmarkStatus.PENDING,
      });
    } catch (error: unknown) {
      // Handle unique constraint violation (race condition with another instance)
      const errorMessage = (error as Error)?.message?.toLowerCase() ?? '';
      const isUniqueConstraintViolation =
        errorMessage.includes('unique') ||
        errorMessage.includes('duplicate') ||
        errorMessage.includes('constraint') ||
        (error as { code?: string })?.code === '23505'; // PostgreSQL unique violation code

      if (isUniqueConstraintViolation) {
        logger.info('Earmark already created by another instance, skipping', {
          requestId,
          invoiceId: intent.intent_id,
          note: 'Race condition resolved - another poller instance created the earmark first',
        });
        continue;
      }

      logger.error('Failed to create earmark for intent', {
        requestId,
        intent,
        error: jsonifyError(error),
      });
      throw error;
    }

    logger.info('Created earmark for intent rebalance', {
      requestId,
      earmarkId: earmark.id,
      invoiceId: intent.intent_id,
    });

    const fsActions = await processThresholdRebalancing({
      context,
      origin: origin.toString(),
      recipientAddress: fsConfig.address!,
      amountToBridge,
      runState,
      earmarkId: earmark.id,
    });

    if(fsActions.length === 0) {
      await removeEarmark(earmark.id);
      logger.info('Removed earmark for intent rebalance because no operations were executed', {
        requestId,
        earmarkId: earmark.id,
        invoiceId: intent.intent_id,
      });
    }

    actions.push(...fsActions);
  }

  // PRIORITY 2: Threshold Rebalancing (FS → FS)
  // FS sender does not have enough funds on Mantle, rebalance from WETH on Mainnet
  // Get FS receiver's mETH balance
  let fsReceiverMethBalance = 0n;
  if (fsConfig.address) {
    try {
      fsReceiverMethBalance = await getEvmBalance(
        config,
        MANTLE_CHAIN_ID.toString(),
        fsConfig.address,
        getTokenAddressFromConfig(METH_TICKER_HASH, MANTLE_CHAIN_ID.toString(), config)!,
        getDecimalsFromConfig(METH_TICKER_HASH, MANTLE_CHAIN_ID.toString(), config)!,
        prometheus,
      );
    } catch (error) {
      logger.warn('Failed to check FS receiver mETH balance', {
        requestId,
        fsReceiverAddress: fsConfig.address,
        error: jsonifyError(error),
      });
      return actions;
    }
  }

  // Add committed funds to receiver balance.
  fsReceiverMethBalance += runState.committedEthWeth;

  // Get FS sender's WETH balance on Mainnet
  let fsSenderWethBalance = 0n;
  if (fsSenderAddress) {
    try {
      fsSenderWethBalance = await getEvmBalance(
        config,
        MAINNET_CHAIN_ID.toString(),
        fsSenderAddress,
        getTokenAddressFromConfig(WETH_TICKER_HASH, MAINNET_CHAIN_ID.toString(), config)!,
        getDecimalsFromConfig(WETH_TICKER_HASH, MAINNET_CHAIN_ID.toString(), config)!,
        prometheus,
      );
    } catch (error) {
      logger.warn('Failed to check FS sender WETH balance', {
        requestId,
        fsSenderAddress,
        error: jsonifyError(error),
      });
      return actions;
    }
  }

  if (fsReceiverMethBalance >= threshold) {
    logger.info('FS receiver has enough mETH, no rebalance needed', {
      requestId,
      fsReceiverMethBalance: fsReceiverMethBalance.toString(),
      thresholdMethBalance: threshold.toString(),
    });

    return actions;
  }

  const shortfall = target - fsReceiverMethBalance;
  if (shortfall < minRebalance) {
    logger.debug('FS shortfall below minimum rebalance amount, skipping', {
      requestId,
      shortfall: shortfall.toString(),
      minRebalance: minRebalance.toString(),
    });
    return actions;
  }

  // Check if sender has enough WETH to cover the shortfall
  // If fsSenderWethBalance < shortfall, sender doesn't have enough funds to bridge
  if (fsSenderWethBalance < shortfall) {
    logger.warn('FS sender has insufficient WETH to cover the full shortfall', {
      requestId,
      fsSenderWethBalance: fsSenderWethBalance.toString(),
      shortfall: shortfall.toString(),
      note: 'Will bridge available balance if above minimum',
    });
    // Don't return early - we can still bridge what we have if above minimum
  }

  // Calculate amount to bridge: min(shortfall, available balance)
  const amountFromSender = fsSenderWethBalance < shortfall ? fsSenderWethBalance : shortfall;

  // Skip if available amount is below minimum
  if (amountFromSender < minRebalance) {
    logger.info('Available WETH below minimum rebalance threshold, skipping', {
      requestId,
      availableAmount: amountFromSender.toString(),
      minRebalance: minRebalance.toString(),
    });
    return actions;
  }

  logger.info('FS threshold rebalancing triggered', {
    requestId,
    fsSenderWethBalance: fsSenderWethBalance.toString(),
    shortfall: shortfall.toString(),
    amountToBridge: amountFromSender.toString(),
    recipient: fsConfig.address,
  });

  actions.push(
    ...(await processThresholdRebalancing({
      context,
      origin: MAINNET_CHAIN_ID,
      recipientAddress: fsConfig.address!,
      amountToBridge: amountFromSender,
      runState,
      earmarkId: null,
    })),
  );

  return actions;
};

const processThresholdRebalancing = async ({
  context,
  origin,
  recipientAddress,
  amountToBridge,
  runState,
  earmarkId,
}: ThresholdRebalanceParams): Promise<RebalanceAction[]> => {
  const { config, logger, requestId } = context;
  const bridgeConfig = config.methRebalance!.bridge;

  // mETH/WETH use 18 decimals natively - config values are already in wei
  // No decimal conversion needed
  const minAmount = safeParseBigInt(bridgeConfig.minRebalanceAmount);

  if (amountToBridge < minAmount) {
    logger.debug('amountToBridge below minimum, skipping', {
      requestId,
      amountToBridge: amountToBridge.toString(),
      minAmount: minAmount.toString(),
      note: 'Both values in wei (18 decimals)',
    });
    return [];
  }

  // Note: Sender balance was already validated by the caller (evaluateFillServiceRebalance)
  // before calling this function. No need to re-check here.

  // Execute bridge (no earmark for threshold-based)
  // Pass runState to track committed funds
  const actions = await executeMethBridge(context, origin.toString(), recipientAddress, amountToBridge, earmarkId);

  // Track committed funds if bridge was successful
  if (actions.length > 0) {
    runState.committedEthWeth += amountToBridge;
    logger.debug('Updated committed funds after threshold bridge', {
      requestId,
      recipient: recipientAddress,
      bridgedAmount: amountToBridge.toString(),
      totalCommitted: runState.committedEthWeth.toString(),
    });
  }

  return actions;
};

const executeMethBridge = async (
  context: ProcessingContext,
  origin: string,
  recipientAddress: string, // Final Mantle recipient
  amount: bigint,
  earmarkId: string | null, // null for threshold-based
): Promise<RebalanceAction[]> => {
  const { config, chainService, fillServiceChainService, logger, requestId, rebalance, prometheus } = context;
  // Existing Mantle bridge logic
  // Store recipientAddress in operation.recipient
  // Store earmarkId (null for threshold-based)
  const actions: RebalanceAction[] = [];

  // Determine if this is for Fill Service or Market Maker based on recipient
  const isForFillService = recipientAddress.toLowerCase() === config.methRebalance?.fillService?.address?.toLowerCase();

  // --- Leg 1: Bridge WETH from origin chain to Mainnet via Across ---
  let rebalanceSuccessful = false;
  const bridgeType = SupportedBridge.Across;

  // Determine sender for the bridge based on recipient type
  // For Fill Service recipient: prefer filler as sender, fallback to MM
  // For Market Maker recipient: always use MM
  // Use senderAddress if explicitly set, otherwise default to address (same key = same address on ETH and TAC)
  const fillerSenderAddress =
    config.methRebalance?.fillService?.senderAddress ?? config.methRebalance?.fillService?.address;
  const originWethAddress = getTokenAddressFromConfig(WETH_TICKER_HASH, origin.toString(), config)!;
  const originWethDecimals = getDecimalsFromConfig(WETH_TICKER_HASH, origin.toString(), config)!;

  let evmSender: string;
  let senderConfig: SenderConfig | undefined;
  let selectedChainService = chainService;

  if (isForFillService && fillerSenderAddress && fillServiceChainService) {
    // Check if filler has enough WETH on ETH to send
    // getEvmBalance returns balance in 18 decimals (normalized)
    // amount is in 18 decimals (from getMarkBalancesForTicker which also normalizes)
    let fillerBalance = 0n;
    try {
      fillerBalance = await getEvmBalance(
        config,
        origin.toString(),
        fillerSenderAddress,
        originWethAddress,
        originWethDecimals,
        prometheus,
      );
    } catch (error) {
      logger.warn('Failed to check filler balance, falling back to MM sender', {
        requestId,
        fillerAddress: fillerSenderAddress,
        error: jsonifyError(error),
      });
      // Fall through to MM sender below
    }

    logger.debug('Retrieved WETH balance for Fill Service sender', {
      requestId,
      walletType: 'fill-service',
      address: fillerSenderAddress,
      chainId: origin.toString(),
      balance: fillerBalance.toString(),
      requiredAmount: amount.toString(),
      note: 'Both values are in 18 decimal format (normalized)',
    });

    if (fillerBalance >= amount) {
      // Filler has enough - use filler as sender
      evmSender = fillerSenderAddress;
      senderConfig = {
        address: fillerSenderAddress,
        label: 'fill-service',
      };
      selectedChainService = fillServiceChainService;
      logger.info('Using Fill Service sender for mETH rebalancing (filler has sufficient balance)', {
        requestId,
        sender: fillerSenderAddress,
        balance: fillerBalance.toString(),
        amount: amount.toString(),
      });
    } else {
      // Filler doesn't have enough - fall back to MM
      evmSender = getActualAddress(Number(origin), config, logger, { requestId });
      senderConfig = {
        address: evmSender,
        label: 'market-maker',
      };
      logger.info('Falling back to Market Maker sender for mETH rebalancing (filler has insufficient balance)', {
        requestId,
        fillerAddress: fillerSenderAddress,
        fillerBalance: fillerBalance.toString(),
        mmAddress: evmSender,
        requiredAmount: amount.toString(),
      });
    }
  } else {
    // MM recipient or no FS sender configured - use default
    evmSender = getActualAddress(Number(origin), config, logger, { requestId });
    senderConfig = {
      address: evmSender,
      label: 'market-maker',
    };
  }

  // Security validation: Ensure recipient is one of the configured Mantle receivers
  const allowedRecipients = [
    config.methRebalance?.marketMaker?.address?.toLowerCase(),
    config.methRebalance?.fillService?.address?.toLowerCase(),
  ].filter(Boolean);

  if (!allowedRecipients.includes(recipientAddress.toLowerCase())) {
    logger.error('Recipient address is not a configured mETH receiver (MM or FS)', {
      requestId,
      recipientAddress,
      allowedRecipients,
      note: 'Only methRebalance.marketMaker.address and methRebalance.fillService.address are allowed',
    });
    return [];
  }

  // IMPORTANT: If recipient is MM but doesn't match ownAddress, funds won't be usable for intent filling
  // because intent filling always uses config.ownAddress as the source of funds
  if (!isForFillService && recipientAddress.toLowerCase() !== config.ownAddress.toLowerCase()) {
    logger.warn('Market Maker address differs from ownAddress - funds will NOT be usable for intent filling!', {
      requestId,
      mmAddress: recipientAddress,
      ownAddress: config.ownAddress,
      note: 'Intent filling requires funds at ownAddress. Consider setting MM address = ownAddress.',
    });
  }

  logger.debug('Address flow for two-leg bridge', {
    requestId,
    evmSender,
    recipientAddress,
    isForFillService,
    canUseForIntentFilling: recipientAddress.toLowerCase() === config.ownAddress.toLowerCase(),
  });

  // Use slippage from config (default 500 = 5%)
  const slippageDbps = config.methRebalance!.bridge.slippageDbps;

  // Send WETH to Mainnet first
  const route = {
    asset: originWethAddress, // WETH address on Origin chain
    origin: Number(origin), // Ethereum mainnet
    destination: Number(MAINNET_CHAIN_ID), // Mainnet
    maximum: amount.toString(), // Maximum amount to bridge
    slippagesDbps: [slippageDbps], // Slippage tolerance in decibasis points (1000 = 1%). Array indices match preferences
    preferences: [bridgeType], // Priority ordered platforms
    reserve: '0', // Amount to keep on origin chain during rebalancing
  };

  logger.info('Attempting Leg 1: Settlement chain to Mainnet WETH via Across', {
    requestId,
    origin,
    bridgeType,
    amount: amount.toString(),
    evmSender,
    recipientAddress,
  });

  const adapter = rebalance.getAdapter(bridgeType);
  if (!adapter) {
    logger.error('Across adapter not found', { requestId });
    return [];
  }

  let bridgeTxRequests: MemoizedTransactionRequest[] = [];
  let receivedAmount: bigint = amount;

  const originIsMainnet = String(origin) === MAINNET_CHAIN_ID;
  if (!originIsMainnet) {
    try {
      const amountInNativeUnits = convertToNativeUnits(amount, originWethDecimals);
      // Get quote
      const receivedAmountStr = await adapter.getReceivedAmount(amountInNativeUnits.toString(), route);
      logger.info('Received Across quote', {
        requestId,
        route,
        amountToBridge: amountInNativeUnits.toString(),
        receivedAmount: receivedAmountStr,
      });

      // Check slippage - use safeParseBigInt for adapter response
      // Note: Both receivedAmount and minimumAcceptableAmount are in native units (18 decimals for WETH)
      receivedAmount = safeParseBigInt(receivedAmountStr);
      const slippageDbps = BigInt(route.slippagesDbps[0]); // slippagesDbps is number[], BigInt is safe
      const minimumAcceptableAmount = amountInNativeUnits - (amountInNativeUnits * slippageDbps) / DBPS_MULTIPLIER;

      if (receivedAmount < minimumAcceptableAmount) {
        logger.warn('Across quote does not meet slippage requirements', {
          requestId,
          route,
          amountToBridge: amountInNativeUnits.toString(),
          receivedAmount: receivedAmount.toString(),
          minimumAcceptableAmount: minimumAcceptableAmount.toString(),
        });
        return [];
      }

      // Get bridge transactions
      bridgeTxRequests = await adapter.send(evmSender, recipientAddress, amountInNativeUnits.toString(), route);

      if (!bridgeTxRequests.length) {
        logger.error('No bridge transactions returned from Across adapter', { requestId });
        return [];
      }

      logger.info('Prepared Across bridge transactions', {
        requestId,
        route,
        transactionCount: bridgeTxRequests.length,
      });
    } catch (error) {
      logger.error('Failed to execute Across bridge', {
        requestId,
        route,
        bridgeType,
        error: jsonifyError(error),
      });
      return [];
    }
  }

  try {
    // Execute bridge transactions using the selected chain service and sender
    const { receipt, effectiveBridgedAmount } = await executeBridgeTransactions({
      context: { requestId, logger, chainService: selectedChainService, config },
      route,
      bridgeType,
      bridgeTxRequests,
      amountToBridge: amount,
      senderOverride: senderConfig,
    });

    // Create database record for Leg 1
    await createRebalanceOperation({
      earmarkId: earmarkId,
      originChainId: route.origin,
      destinationChainId: route.destination,
      tickerHash: getTickerForAsset(route.asset, route.origin, config) || WETH_TICKER_HASH,
      amount: effectiveBridgedAmount,
      slippage: route.slippagesDbps[0],
      status: originIsMainnet ? RebalanceOperationStatus.AWAITING_CALLBACK : RebalanceOperationStatus.PENDING,
      bridge: `${bridgeType}-mantle`,
      transactions: receipt
        ? {
            [route.origin]: receipt,
          }
        : undefined,
      recipient: recipientAddress,
    });

    logger.info('Successfully created mETH Leg 1 rebalance operation', {
      requestId,
      route,
      bridgeType,
      originTxHash: receipt?.transactionHash,
      amountToBridge: effectiveBridgedAmount,
    });

    // Track the operation
    const rebalanceAction: RebalanceAction = {
      bridge: adapter.type(),
      amount: amount.toString(),
      origin: route.origin,
      destination: route.destination,
      asset: route.asset,
      transaction: receipt?.transactionHash || '',
      recipient: recipientAddress,
    };
    actions.push(rebalanceAction);

    rebalanceSuccessful = true;
  } catch (error) {
    logger.error('Failed to execute Across bridge', {
      requestId,
      route,
      bridgeType,
      error: jsonifyError(error),
    });
    return [];
  }

  if (rebalanceSuccessful) {
    logger.info('Leg 1 rebalance successful', {
      requestId,
      route,
      amount: amount.toString(),
    });
  } else {
    logger.warn('Failed to complete Leg 1 rebalance', {
      requestId,
      route,
      amount: amount.toString(),
    });
  }

  return actions;
};

export const executeMethCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, config, rebalance, chainService, database: db } = context;
  logger.info('Executing destination callbacks for meth rebalance', { requestId });

  // Get operation TTL from config (with default fallback)
  const operationTtlMinutes = config.regularRebalanceOpTTLMinutes ?? DEFAULT_OPERATION_TTL_MINUTES;

  // Get all pending operations from database
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  logger.debug('Found meth rebalance operations', {
    count: operations.length,
    requestId,
    statuses: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
    operationTtlMinutes,
  });

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    if (!operation.bridge) {
      logger.warn('Operation missing bridge type', logContext);
      continue;
    }

    // Check for operation timeout - operations stuck too long should be marked as cancelled
    if (operation.createdAt && isOperationTimedOut(operation.createdAt, operationTtlMinutes)) {
      const operationAgeMinutes = Math.round((Date.now() - operation.createdAt.getTime()) / (60 * 1000));
      logger.warn('Operation timed out - marking as cancelled', {
        ...logContext,
        createdAt: operation.createdAt.toISOString(),
        operationAgeMinutes,
        ttlMinutes: operationTtlMinutes,
        status: operation.status,
      });

      try {
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.CANCELLED,
        });

        // Also update earmark if present
        if (operation.earmarkId) {
          await db.updateEarmarkStatus(operation.earmarkId, EarmarkStatus.CANCELLED);
          logger.info('Earmark cancelled due to operation timeout', {
            ...logContext,
            earmarkId: operation.earmarkId,
          });
        }
      } catch (error) {
        logger.error('Failed to cancel timed-out operation', {
          ...logContext,
          error: jsonifyError(error),
        });
      }
      continue;
    }

    const bridgeType = operation.bridge.split('-')[0];
    const isToMainnetBridge = operation.bridge.split('-').length === 2 && operation.bridge.split('-')[1] === 'mantle';
    const isFromMainnetBridge = operation.originChainId === Number(MAINNET_CHAIN_ID);

    if (bridgeType !== SupportedBridge.Mantle && !isToMainnetBridge) {
      logger.warn('Operation is not a mantle bridge', logContext);
      continue;
    }
    const adapter = rebalance.getAdapter(bridgeType as SupportedBridge);

    // Get origin transaction hash from JSON field
    const txHashes = operation.transactions;
    const originTx = txHashes?.[operation.originChainId] as
      | TransactionEntry<{ receipt: TransactionReceipt }>
      | undefined;

    if (!originTx && !isFromMainnetBridge) {
      logger.warn('Operation missing origin transaction', { ...logContext, operation });
      continue;
    }

    // Get the transaction receipt from origin chain
    const receipt = originTx?.metadata?.receipt;
    if (!receipt && !isFromMainnetBridge) {
      logger.info('Origin transaction receipt not found for operation', { ...logContext, operation });
      continue;
    }

    const assetAddress = getTokenAddressFromConfig(operation.tickerHash, operation.originChainId.toString(), config);

    if (!assetAddress) {
      logger.error('Could not find asset address for ticker hash', {
        ...logContext,
        tickerHash: operation.tickerHash,
        originChain: operation.originChainId,
      });
      continue;
    }

    let route = {
      origin: operation.originChainId,
      destination: operation.destinationChainId,
      asset: assetAddress,
    };

    // Check if ready for callback
    if (operation.status === RebalanceOperationStatus.PENDING) {
      try {
        const ready = await adapter.readyOnDestination(
          operation.amount,
          route,
          receipt as unknown as ViemTransactionReceipt,
        );
        if (ready) {
          // Update status to awaiting callback
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
          });
          logger.info('Operation ready for callback, updated status', {
            ...logContext,
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
          });

          // Update the operation object for further processing
          operation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        } else {
          logger.info('Action not ready for destination callback', logContext);
        }
      } catch (e: unknown) {
        logger.error('Failed to check if ready on destination', { ...logContext, error: jsonifyError(e) });
        continue;
      }
    }

    // Execute callback if awaiting
    else if (operation.status === RebalanceOperationStatus.AWAITING_CALLBACK) {
      let callback;

      // no need to execute callback if origin is mainnet
      if (!isFromMainnetBridge) {
        try {
          callback = await adapter.destinationCallback(route, receipt as unknown as ViemTransactionReceipt);
        } catch (e: unknown) {
          logger.error('Failed to retrieve destination callback', { ...logContext, error: jsonifyError(e) });
          continue;
        }
      }

      let amountToBridge = operation.amount.toString();
      let successCallback = false;
      let txHashes: { [key: string]: TransactionReceipt } = {};
      if (!callback) {
        // No callback needed, mark as completed
        logger.info('No destination callback required, marking as completed', logContext);
        successCallback = true;
      } else {
        logger.info('Retrieved destination callback', {
          ...logContext,
          callback: serializeBigInt(callback),
          receipt: serializeBigInt(receipt),
        });

        // Try to execute the destination callback
        try {
          const tx = await submitTransactionWithLogging({
            chainService,
            logger,
            chainId: route.destination.toString(),
            txRequest: {
              chainId: +route.destination,
              to: callback.transaction.to!,
              data: callback.transaction.data!,
              value: (callback.transaction.value || 0).toString(),
              from: config.ownAddress,
              funcSig: callback.transaction.funcSig || '',
            },
            zodiacConfig: {
              walletType: WalletType.EOA,
            },
            context: { ...logContext, callbackType: `destination: ${callback.memo}` },
          });

          logger.info('Successfully submitted destination callback', {
            ...logContext,
            callback: serializeBigInt(callback),
            receipt: serializeBigInt(receipt),
            destinationTx: tx.hash,
            walletType: WalletType.EOA,
          });

          // Update operation as completed with destination tx hash
          if (!tx || !tx.receipt) {
            logger.error('Destination transaction receipt not found', { ...logContext, tx });
            continue;
          }

          successCallback = true;
          txHashes[route.destination.toString()] = tx.receipt as TransactionReceipt;
          amountToBridge = (callback.transaction.value as bigint).toString();
        } catch (e) {
          logger.error('Failed to execute destination callback', {
            ...logContext,
            callback: serializeBigInt(callback),
            receipt: serializeBigInt(receipt),
            error: jsonifyError(e),
          });
          continue;
        }
      }

      try {
        if (isToMainnetBridge) {
          // Stake WETH / ETH on mainnet to get mETH and bridge to Mantle using the Mantle adapter
          const mantleAdapter = rebalance.getAdapter(SupportedBridge.Mantle);
          if (!mantleAdapter) {
            logger.error('Mantle adapter not found', { ...logContext });
            continue;
          }

          const mantleBridgeType = SupportedBridge.Mantle;

          route = {
            origin: Number(MAINNET_CHAIN_ID),
            destination: Number(MANTLE_CHAIN_ID),
            asset: getTokenAddressFromConfig(WETH_TICKER_HASH, MAINNET_CHAIN_ID.toString(), config) || '',
          };
          const sender = getActualAddress(route.origin, config, logger, { requestId });

          // Step 1: Get Quote
          let receivedAmountStr: string;
          try {
            receivedAmountStr = await mantleAdapter.getReceivedAmount(amountToBridge, route);
            logger.info('Received quote from mantle adapter', {
              requestId,
              route,
              bridgeType: mantleBridgeType,
              amountToBridge,
              receivedAmount: receivedAmountStr,
            });
          } catch (quoteError) {
            logger.error('Failed to get quote from Mantle adapter', {
              requestId,
              route,
              bridgeType: mantleBridgeType,
              amountToBridge,
              error: jsonifyError(quoteError),
            });
            continue;
          }

          // Step 2: Get Bridge Transaction Requests
          let bridgeTxRequests: MemoizedTransactionRequest[] = [];
          try {
            bridgeTxRequests = await mantleAdapter.send(sender, sender, amountToBridge, route);
            logger.info('Prepared bridge transaction request from Mantle adapter', {
              requestId,
              route,
              bridgeType: mantleBridgeType,
              bridgeTxRequests,
              amountToBridge,
              receiveAmount: receivedAmountStr,
              transactionCount: bridgeTxRequests.length,
              sender,
              recipient: sender,
            });
            if (!bridgeTxRequests.length) {
              throw new Error(`Failed to retrieve any bridge transaction requests`);
            }
          } catch (sendError) {
            logger.error('Failed to get bridge transaction request from Mantle adapter', {
              requestId,
              route,
              bridgeType: mantleBridgeType,
              amountToBridge,
              error: jsonifyError(sendError),
            });
            continue;
          }

          // Step 3: Submit the bridge transactions in order and create database record
          try {
            const { receipt, effectiveBridgedAmount } = await executeBridgeTransactions({
              context: { requestId, logger, chainService, config },
              route,
              bridgeType: mantleBridgeType,
              bridgeTxRequests,
              amountToBridge: BigInt(amountToBridge),
            });

            // Step 4: Create database record for the Mantle bridge leg
            try {
              await createRebalanceOperation({
                earmarkId: null, // NULL indicates regular rebalancing
                originChainId: route.origin,
                destinationChainId: route.destination,
                tickerHash: getTickerForAsset(route.asset, route.origin, config) || route.asset,
                amount: effectiveBridgedAmount,
                slippage: 1000, // 1% slippage
                status: RebalanceOperationStatus.PENDING,
                bridge: mantleBridgeType,
                transactions: receipt ? { [route.origin]: receipt } : undefined,
                recipient: sender,
              });

              logger.info('Successfully created Mantle rebalance operation in database', {
                requestId,
                route,
                bridgeType: mantleBridgeType,
                originTxHash: receipt?.transactionHash,
                amountToBridge: effectiveBridgedAmount,
                originalRequestedAmount: amountToBridge.toString(),
                receiveAmount: receivedAmountStr,
              });
            } catch (error) {
              logger.error('Failed to confirm transaction or create Mantle database record', {
                requestId,
                route,
                bridgeType: mantleBridgeType,
                transactionHash: receipt?.transactionHash,
                error: jsonifyError(error),
              });

              // Don't consider this a success if we can't confirm or record it
              continue;
            }
          } catch (sendError) {
            logger.error('Failed to send or monitor Mantle bridge transaction', {
              requestId,
              route,
              bridgeType: mantleBridgeType,
              error: jsonifyError(sendError),
            });
            continue;
          }
        }

        if (successCallback) {
          try {
            await db.updateRebalanceOperation(operation.id, {
              status: RebalanceOperationStatus.COMPLETED,
              txHashes: txHashes,
            });

            if (operation.earmarkId) {
              await db.updateEarmarkStatus(operation.earmarkId, EarmarkStatus.COMPLETED);
            }
            logger.info('Successfully updated database with destination transaction', {
              operationId: operation.id,
              earmarkId: operation.earmarkId,
              status: RebalanceOperationStatus.COMPLETED,
              txHashes: txHashes,
            });
          } catch (dbError) {
            logger.error('Failed to update database with destination transaction', {
              ...logContext,
              error: jsonifyError(dbError),
              errorMessage: (dbError as Error)?.message,
              errorStack: (dbError as Error)?.stack,
            });
            throw dbError;
          }
        }
      } catch (dbError) {
        logger.error('Failed to send to mantle', {
          ...logContext,
          error: jsonifyError(dbError),
          errorMessage: (dbError as Error)?.message,
          errorStack: (dbError as Error)?.stack,
        });
        throw dbError;
      }
    }
  }
};
