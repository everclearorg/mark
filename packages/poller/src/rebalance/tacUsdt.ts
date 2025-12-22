import { randomUUID } from 'crypto';
import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import {
  getTickerForAsset,
  getMarkBalancesForTicker,
  getTonAssetAddress,
  getEvmBalance,
  convertToNativeUnits,
  convertTo18Decimals,
  safeParseBigInt,
} from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import {
  RebalanceOperationStatus,
  BPS_MULTIPLIER,
  RebalanceAction,
  SupportedBridge,
  MAINNET_CHAIN_ID,
  TAC_CHAIN_ID,
  TON_LZ_CHAIN_ID,
  getTokenAddressFromConfig,
  WalletType,
  EarmarkStatus,
  getDecimalsFromConfig,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { getActualAddress } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { MemoizedTransactionRequest, RebalanceTransactionMemo } from '@mark/rebalance';
import {
  createRebalanceOperation,
  Earmark,
  getActiveEarmarkForInvoice,
  TransactionEntry,
  TransactionReceipt,
} from '@mark/database';

// USDT token addresses
// Reference: https://raw.githubusercontent.com/connext/chaindata/main/everclear.json
const USDT_ON_ETH_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';

/**
 * Sender configuration for TAC rebalancing transactions.
 * Specifies which address should sign and send from Ethereum mainnet.
 */
interface TacSenderConfig {
  address: string; // Sender's Ethereum address
  signerUrl?: string; // Web3signer URL for this sender (uses default if not specified)
  label: 'market-maker' | 'fill-service'; // For logging
}

/**
 * Resolved USDT token addresses and decimals for TAC rebalancing.
 * Used to ensure correct token addresses are passed to balance checks
 * and config values are converted to the correct decimal format.
 */
interface UsdtInfo {
  tacAddress: string; // USDT address on TAC chain
  tacDecimals: number; // USDT decimals on TAC (typically 6)
  ethAddress: string; // USDT address on Ethereum mainnet
  ethDecimals: number; // USDT decimals on ETH (typically 6)
}

// Minimum TON balance required for gas (0.5 TON in nanotons)
const MIN_TON_GAS_BALANCE = 500000000n;

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

/**
 * Type for TAC transaction metadata stored in database
 * Used for type-safe access to transactionLinker in callbacks
 */
interface TacTransactionMetadata {
  receipt?: {
    transactionLinker?: unknown;
    [key: string]: unknown;
  };
}

/**
 * Extended TransactionReceipt that includes transactionLinker for TAC operations
 * The transactionLinker is stored in the receipt and persisted to DB metadata
 */
type TacPlaceholderReceipt = TransactionReceipt & {
  transactionLinker: unknown;
};

/**
 * Create a placeholder receipt for TAC bridge transactions
 *
 * TAC SDK transactions don't have EVM transaction hashes, so we create a
 * placeholder receipt to store the transactionLinker in the database.
 * This enables:
 * 1. Tracking the operation status via TAC SDK OperationTracker
 * 2. Preventing duplicate bridge executions (retry loop prevention)
 *
 * @param operationId - Unique identifier for this operation (prevents hash collisions)
 * @param from - Sender address (TON wallet or fallback)
 * @param to - Recipient address (TAC EVM address)
 * @param transactionLinker - TAC SDK transactionLinker for status tracking
 */
function createTacPlaceholderReceipt(
  operationId: string,
  from: string,
  to: string,
  transactionLinker: unknown,
): TacPlaceholderReceipt {
  return {
    // Use crypto.randomUUID for guaranteed uniqueness (cryptographically secure)
    transactionHash: `tac-${operationId}-${randomUUID()}`,
    from: from || 'ton-sender',
    to,
    cumulativeGasUsed: '0',
    effectiveGasPrice: '0',
    blockNumber: 0,
    status: 1,
    logs: [],
    confirmations: 0,
    // Store transactionLinker for later status tracking
    transactionLinker,
  };
}
// Default TONAPI.io URL
const TONAPI_DEFAULT_URL = 'https://tonapi.io/v2';

/**
 * Build headers for TONAPI.io requests
 * Uses Bearer token authentication if API key is provided
 */
function buildTonApiHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Query TON wallet native balance via TONAPI.io
 *
 * @param walletAddress - TON wallet address (user-friendly format)
 * @param apiKey - TONAPI.io API key (optional for free tier, recommended for production)
 * @param rpcUrl - TONAPI.io base URL (defaults to https://tonapi.io/v2)
 * @returns TON balance in nanotons, or 0 if query fails
 */
async function getTonNativeBalance(
  walletAddress: string,
  apiKey?: string,
  rpcUrl: string = TONAPI_DEFAULT_URL,
): Promise<bigint> {
  try {
    const url = `${rpcUrl}/accounts/${walletAddress}`;
    console.log('getTonNativeBalance url', url, apiKey)
    const response = await fetch(url, {
      headers: buildTonApiHeaders(apiKey),
    });

    console.log('getTonNativeBalance response', response.ok)

    if (!response.ok) {
      return 0n;
    }

    const data = (await response.json()) as { balance?: number | string };
    console.log('getTonNativeBalance data', data)
    if (data.balance === undefined) {
      return 0n;
    }

    return safeParseBigInt(data.balance.toString());
  } catch (error) {
    console.log('getTonNativeBalance error', error)
    return 0n;
  }
}

/**
 * Query TON wallet jetton (token) balance via TONAPI.io
 *
 * @param walletAddress - TON wallet address (user-friendly format)
 * @param jettonAddress - TON jetton master address (from config.ton.assets)
 * @param apiKey - TONAPI.io API key (optional for free tier, recommended for production)
 * @param rpcUrl - TONAPI.io base URL (defaults to https://tonapi.io/v2)
 * @returns Jetton balance in native units, or 0 if query fails
 */
async function getTonJettonBalance(
  walletAddress: string,
  jettonAddress: string,
  apiKey?: string,
  rpcUrl: string = TONAPI_DEFAULT_URL,
): Promise<bigint> {
  try {
    const url = `${rpcUrl}/accounts/${walletAddress}/jettons/${jettonAddress}`;
    const response = await fetch(url, {
      headers: buildTonApiHeaders(apiKey),
    });

    if (!response.ok) {
      return 0n;
    }

    const data = (await response.json()) as { balance?: string };
    if (data.balance === undefined) {
      return 0n;
    }

    return safeParseBigInt(data.balance);
  } catch {
    return 0n;
  }
}

type ExecuteBridgeContext = Pick<ProcessingContext, 'logger' | 'chainService' | 'config' | 'requestId'>;

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
  senderOverride?: TacSenderConfig; // Optional: use different sender than config.ownAddress
}

interface ExecuteBridgeResult {
  receipt?: TransactionReceipt;
  effectiveBridgedAmount: string;
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
    logger.info('Submitting TAC bridge transaction', {
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

    logger.info('Successfully submitted TAC bridge transaction', {
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

/**
 * Shared state for tracking ETH USDT that has been committed in this run
 * This prevents over-committing when both MM and FS need rebalancing simultaneously
 */
interface RebalanceRunState {
  committedEthUsdt: bigint; // Amount of ETH USDT committed in this run (not yet confirmed on-chain)
}

/**
 * Main TAC USDT rebalancing function
 *
 * Workflow:
 * 1. Process any pending callbacks (Leg 1 → Leg 2 transitions)
 * 2. Evaluate Market Maker rebalancing needs (invoice-triggered OR threshold-based)
 * 3. Evaluate Fill Service rebalancing needs (threshold-based only)
 * 4. Handle simultaneous MM+FS by tracking committed funds within the run
 *
 * Bridge flow:
 * - Leg 1: USDT Ethereum → TON via Stargate
 * - Leg 2: USDT TON → TAC via TAC Inner Bridge
 */
export async function rebalanceTacUsdt(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, rebalance, prometheus } = context;
  const actions: RebalanceAction[] = [];

  // Always check destination callbacks to ensure operations complete
  await executeTacCallbacks(context);

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('TAC USDT Rebalance loop is paused', { requestId });
    return actions;
  }

  const tacRebalanceConfig = config.tacRebalance;
  if (!tacRebalanceConfig?.enabled) {
    logger.warn('TAC USDT Rebalance is not enabled', { requestId });
    return actions;
  }

  // Validate critical configuration before proceeding
  const validationErrors: string[] = [];
  if (!tacRebalanceConfig.marketMaker?.address) {
    validationErrors.push('marketMaker.address is required');
  }
  if (!tacRebalanceConfig.fillService?.address) {
    validationErrors.push('fillService.address is required');
  }
  if (!tacRebalanceConfig.bridge?.minRebalanceAmount) {
    validationErrors.push('bridge.minRebalanceAmount is required');
  }
  if (validationErrors.length > 0) {
    logger.error('TAC rebalance configuration validation failed', {
      requestId,
      errors: validationErrors,
    });
    return actions;
  }

  // Resolve USDT token addresses and decimals from config for each chain
  const ethUsdtAddress = getTokenAddressFromConfig(USDT_TICKER_HASH, MAINNET_CHAIN_ID.toString(), config);
  const ethUsdtDecimals = getDecimalsFromConfig(USDT_TICKER_HASH, MAINNET_CHAIN_ID.toString(), config) ?? 6;
  const tacUsdtAddress = getTokenAddressFromConfig(USDT_TICKER_HASH, TAC_CHAIN_ID.toString(), config);
  const tacUsdtDecimals = getDecimalsFromConfig(USDT_TICKER_HASH, TAC_CHAIN_ID.toString(), config) ?? 6;

  if (!ethUsdtAddress) {
    logger.error('USDT address not configured for Ethereum mainnet', {
      requestId,
      tickerHash: USDT_TICKER_HASH,
      chainId: MAINNET_CHAIN_ID,
    });
    return actions;
  }

  if (!tacUsdtAddress) {
    logger.error('USDT address not configured for TAC chain', {
      requestId,
      tickerHash: USDT_TICKER_HASH,
      chainId: TAC_CHAIN_ID,
    });
    return actions;
  }

  // Get initial ETH USDT balance (shared pool for both MM and FS)
  // Returns balance normalized to 18 decimals
  const initialEthUsdtBalance = await getEvmBalance(
    config,
    MAINNET_CHAIN_ID.toString(),
    config.ownAddress,
    ethUsdtAddress,
    ethUsdtDecimals,
    prometheus,
  );

  // Resolved USDT addresses and decimals for use in threshold functions
  const usdtInfo = {
    tacAddress: tacUsdtAddress,
    tacDecimals: tacUsdtDecimals,
    ethAddress: ethUsdtAddress,
    ethDecimals: ethUsdtDecimals,
  };

  logger.info('Starting TAC USDT rebalancing', {
    requestId,
    ownAddress: config.ownAddress,
    initialEthUsdtBalance: initialEthUsdtBalance.toString(),
    usdtInfo,
    wallets: {
      marketMaker: {
        walletType: 'market-maker',
        address: tacRebalanceConfig.marketMaker.address,
        onDemandEnabled: tacRebalanceConfig.marketMaker.onDemandEnabled,
        thresholdEnabled: tacRebalanceConfig.marketMaker.thresholdEnabled,
        threshold: tacRebalanceConfig.marketMaker.threshold,
        targetBalance: tacRebalanceConfig.marketMaker.targetBalance,
      },
      fillService: {
        walletType: 'fill-service',
        address: tacRebalanceConfig.fillService.address,
        senderAddress: tacRebalanceConfig.fillService.senderAddress,
        thresholdEnabled: tacRebalanceConfig.fillService.thresholdEnabled,
        threshold: tacRebalanceConfig.fillService.threshold,
        targetBalance: tacRebalanceConfig.fillService.targetBalance,
      },
    },
  });

  // Track committed funds to prevent over-committing in this run
  const runState: RebalanceRunState = {
    committedEthUsdt: 0n,
  };

  // Calculate available balance for MM (no deductions yet)
  const mmAvailableBalance = initialEthUsdtBalance;

  // Evaluate Market Maker path first (invoice-triggered takes priority)
  const mmActions = await evaluateMarketMakerRebalance(context, mmAvailableBalance, runState, usdtInfo);
  actions.push(...mmActions);

  // Calculate remaining balance for FS (deduct MM committed amount)
  const fsAvailableBalance = initialEthUsdtBalance - runState.committedEthUsdt;

  if (runState.committedEthUsdt > 0n) {
    logger.info('MM committed funds, reducing available balance for FS', {
      requestId,
      mmCommitted: runState.committedEthUsdt.toString(),
      fsAvailable: fsAvailableBalance.toString(),
    });
  }

  // Evaluate Fill Service path (threshold-based only)
  const fsActions = await evaluateFillServiceRebalance(context, fsAvailableBalance, runState, usdtInfo);
  actions.push(...fsActions);

  logger.info('Completed TAC USDT rebalancing cycle', {
    requestId,
    totalActions: actions.length,
    mmActions: mmActions.length,
    fsActions: fsActions.length,
    totalCommitted: runState.committedEthUsdt.toString(),
  });

  return actions;
}

const evaluateMarketMakerRebalance = async (
  context: ProcessingContext,
  availableEthUsdt: bigint,
  runState: RebalanceRunState,
  usdtInfo: UsdtInfo,
): Promise<RebalanceAction[]> => {
  const { config, logger, requestId } = context;
  const mmConfig = config.tacRebalance!.marketMaker;
  const actions: RebalanceAction[] = [];

  // MM uses EITHER invoice-triggered OR threshold-based rebalancing, NOT BOTH
  // Priority: Invoice-triggered takes precedence (funds needed for specific intents)
  // Only fall back to threshold-based if no invoices require rebalancing

  // A) On-demand: Invoice-triggered (higher priority)
  if (mmConfig.onDemandEnabled) {
    const invoiceActions = await processOnDemandRebalancing(context, mmConfig.address!, availableEthUsdt, runState);
    if (invoiceActions.length > 0) {
      logger.info('MM rebalancing triggered by invoices, skipping threshold check', {
        requestId,
        invoiceActionsCount: invoiceActions.length,
        note: 'Invoice-triggered rebalancing takes priority over threshold-based',
      });
      actions.push(...invoiceActions);
      return actions; // Exit early - invoice-triggered takes priority
    }
  }

  // B) Threshold-based: Balance check (only if no invoice-triggered rebalancing)
  if (mmConfig.thresholdEnabled) {
    // Convert config values from native decimals (6) to normalized (18)
    // Use safeParseBigInt for robust parsing of config strings
    const thresholdNative = safeParseBigInt(mmConfig.threshold);
    const targetNative = safeParseBigInt(mmConfig.targetBalance);
    const threshold18 = convertTo18Decimals(thresholdNative, usdtInfo.tacDecimals);
    const target18 = convertTo18Decimals(targetNative, usdtInfo.tacDecimals);

    logger.debug('No invoice-triggered rebalancing needed, checking MM threshold', {
      requestId,
      thresholdNative: thresholdNative.toString(),
      threshold18: threshold18.toString(),
      targetNative: targetNative.toString(),
      target18: target18.toString(),
      availableEthUsdt: availableEthUsdt.toString(),
    });
    const thresholdActions = await processThresholdRebalancing({
      context,
      recipientAddress: mmConfig.address!,
      threshold: threshold18,
      targetBalance: target18,
      availableEthUsdt,
      runState,
      tacUsdtAddress: usdtInfo.tacAddress,
      tacUsdtDecimals: usdtInfo.tacDecimals,
    });
    actions.push(...thresholdActions);
  }

  return actions;
};

const processOnDemandRebalancing = async (
  context: ProcessingContext,
  recipientAddress: string,
  availableEthUsdt: bigint,
  runState: RebalanceRunState,
): Promise<RebalanceAction[]> => {
  // Invoice-triggered rebalancing: creates earmarks for specific intents
  // Uses available ETH USDT balance and tracks committed amounts
  const { config, chainService, everclear, database, rebalance, logger, requestId } = context;
  let invoices = await everclear.fetchInvoices({ [TAC_CHAIN_ID]: config.chains[TAC_CHAIN_ID] });

  // Filter invoices for USDT
  invoices = invoices.filter((invoice) => invoice.ticker_hash === USDT_TICKER_HASH);

  if (invoices.length === 0) {
    logger.info('No invoices destined for TAC with USDT output', { requestId });
    return [];
  }

  // Get USDT balances across all chains for Market Maker address
  const balances = await getMarkBalancesForTicker(USDT_TICKER_HASH, config, chainService, context.prometheus);
  logger.debug('Retrieved USDT balances for Market Maker', {
    requestId,
    walletType: 'market-maker',
    address: config.ownAddress,
    balances: jsonifyMap(balances),
  });

  if (!balances) {
    logger.warn('No USDT balances found for Market Maker, skipping', { requestId, address: config.ownAddress });
    return [];
  }

  // Track remaining available balance for this on-demand run
  let remainingEthUsdt = availableEthUsdt - runState.committedEthUsdt;

  const actions: RebalanceAction[] = [];

  for (const invoice of invoices) {
    // Check if earmark already exists
    const existingActive = await getActiveEarmarkForInvoice(invoice.intent_id);
    if (existingActive) {
      logger.warn('Active earmark already exists for invoice, skipping', {
        requestId,
        invoiceId: invoice.intent_id,
        existingEarmarkId: existingActive.id,
      });
      continue;
    }

    const origin = Number(MAINNET_CHAIN_ID); // Always start from Ethereum mainnet
    const destination = Number(TAC_CHAIN_ID);
    const ticker = USDT_TICKER_HASH;
    const decimals = getDecimalsFromConfig(ticker, origin.toString(), config);

    // All amounts normalized to 18 decimals for consistent calculations
    // (same pattern as threshold rebalancing)

    // Invoice amounts from Everclear API are always normalized to 18 decimals
    const intentAmount = safeParseBigInt(invoice.amount);

    // Convert bridge config amounts from native (6 decimals) to normalized (18 decimals)
    const minRebalanceAmountNative = safeParseBigInt(config.tacRebalance!.bridge.minRebalanceAmount);
    const minRebalanceAmount = convertTo18Decimals(minRebalanceAmountNative, decimals);

    if (intentAmount < minRebalanceAmount) {
      logger.warn('Invoice amount is less than minimum rebalance amount, skipping', {
        requestId,
        invoiceId: invoice.intent_id.toString(),
        invoiceAmount: invoice.amount,
        minRebalanceAmount: minRebalanceAmount.toString(),
        note: 'Both values in 18 decimal format',
      });
      continue;
    }

    // Balances from getMarkBalancesForTicker are already in 18 decimals (standardized)
    // Keep them in 18 decimals for consistent comparison with intentAmount
    const currentOriginBalance = balances.get(origin.toString()) || 0n;

    // CRITICAL: Check if TAC (destination) already has sufficient balance
    // On-demand rebalancing should ONLY trigger when the destination lacks funds
    const currentDestBalance = balances.get(destination.toString()) || 0n;

    logger.debug('Current USDT balances (18 decimals)', {
      requestId,
      originBalance: currentOriginBalance.toString(),
      destinationBalance: currentDestBalance.toString(),
      intentAmount: intentAmount.toString(),
      decimals,
    });

    // If TAC already has enough to fulfill the intent, no rebalance needed
    if (currentDestBalance >= intentAmount) {
      logger.info('TAC already has sufficient balance for intent, skipping rebalance', {
        requestId,
        invoiceId: invoice.intent_id.toString(),
        currentDestBalance: currentDestBalance.toString(),
        intentAmount: intentAmount.toString(),
        note: 'On-demand rebalancing only triggers when destination lacks funds (values in 18 decimals)',
      });
      continue;
    }

    // Use remaining available balance (accounts for previously committed funds in this run)
    // remainingEthUsdt is in 18 decimals (from availableEthUsdt)
    if (remainingEthUsdt <= minRebalanceAmount) {
      logger.info('Remaining ETH USDT is at or below minimum, skipping', {
        requestId,
        remainingEthUsdt: remainingEthUsdt.toString(),
        minRebalanceAmount: minRebalanceAmount.toString(),
        note: 'Both values in 18 decimal format',
      });
      continue;
    }

    // Calculate amount to bridge - only bridge what's needed
    // (intentAmount - currentDestBalance) = shortfall that needs to be filled
    // All values in 18 decimals
    const shortfall = intentAmount - currentDestBalance;

    // Don't bridge if shortfall is below minimum threshold
    if (shortfall < minRebalanceAmount) {
      logger.info('Shortfall is below minimum rebalance threshold, skipping', {
        requestId,
        invoiceId: invoice.intent_id.toString(),
        shortfall: shortfall.toString(),
        minRebalanceAmount: minRebalanceAmount.toString(),
        note: 'Both values in 18 decimal format',
      });
      continue;
    }

    // Use remaining available balance (not the on-chain balance, which doesn't account for this run's commits)
    // All values in 18 decimals
    const amountToBridge = remainingEthUsdt < shortfall ? remainingEthUsdt : shortfall;

    logger.info('On-demand rebalancing triggered - destination lacks funds', {
      requestId,
      invoiceId: invoice.intent_id.toString(),
      intentAmount: intentAmount.toString(),
      currentDestBalance: currentDestBalance.toString(),
      shortfall: shortfall.toString(),
      amountToBridge: amountToBridge.toString(),
      note: 'All values in 18 decimal format',
    });

    // Create earmark
    let earmark: Earmark;
    try {
      earmark = await database.createEarmark({
        invoiceId: invoice.intent_id.toString(),
        designatedPurchaseChain: destination,
        tickerHash: ticker,
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
          invoiceId: invoice.intent_id.toString(),
          note: 'Race condition resolved - another poller instance created the earmark first',
        });
        continue;
      }

      logger.error('Failed to create earmark for TAC intent', {
        requestId,
        invoice,
        error: jsonifyError(error),
      });
      throw error;
    }

    logger.info('Created earmark for TAC intent', {
      requestId,
      earmarkId: earmark.id,
      invoiceId: invoice.intent_id.toString(),
    });

    // --- Leg 1: Bridge USDT from Ethereum to TON via Stargate ---
    let rebalanceSuccessful = false;
    const bridgeType = SupportedBridge.Stargate;

    // Get addresses for the bridging flow
    // evmSender: The Ethereum address that holds USDT and will initiate the bridge
    const evmSender = getActualAddress(origin, config, logger, { requestId });

    // tonRecipient: TON wallet address that receives USDT on TON (intermediate step)
    const tonRecipient = config.ownTonAddress;

    // tacRecipient: Final EVM address on TAC that should receive USDT
    // Both Ethereum and TAC are EVM chains, so the same address format works on both
    const tacRecipient = recipientAddress;

    // Validate TON address is configured
    if (!tonRecipient) {
      logger.error('TON address not configured (config.ownTonAddress), cannot execute Stargate bridge', {
        requestId,
        note: 'Add ownTonAddress to config to enable TAC rebalancing',
      });
      continue;
    }

    logger.debug('Address flow for two-leg bridge', {
      requestId,
      evmSender,
      tonRecipient,
      tacRecipient,
      sameAddressOnEthAndTac: evmSender === tacRecipient,
    });

    // Use slippage from config (default 500 = 5%)
    const slippageDbps = config.tacRebalance!.bridge.slippageDbps;

    const route = {
      asset: USDT_ON_ETH_ADDRESS,
      origin: origin,
      destination: Number(TON_LZ_CHAIN_ID), // First leg goes to TON
      maximum: amountToBridge.toString(),
      slippagesDbps: [slippageDbps],
      preferences: [bridgeType],
      reserve: '0',
    };

    logger.info('Attempting Leg 1: Ethereum to TON via Stargate', {
      requestId,
      bridgeType,
      amountToBridge: amountToBridge.toString(),
      evmSender,
      tonRecipient,
      tacRecipient,
    });

    const adapter = rebalance.getAdapter(bridgeType);
    if (!adapter) {
      logger.error('Stargate adapter not found', { requestId });
      continue;
    }

    try {
      // CRITICAL: Convert amount from 18 decimals to native USDT decimals (6)
      // The Stargate API expects amounts in native token units, not normalized 18 decimals
      // Without this conversion, amounts like "10000000000000000000" (10 USDT in 18 decimals)
      // are interpreted as 10 trillion USDT, exceeding pool liquidity and causing "Failed to get route"
      const ethUsdtDecimals = getDecimalsFromConfig(USDT_TICKER_HASH, origin.toString(), config) ?? 6;
      const amountInNativeUnits = convertToNativeUnits(amountToBridge, ethUsdtDecimals);

      logger.debug('Converting amount to native units for Stargate', {
        requestId,
        amountIn18Decimals: amountToBridge.toString(),
        amountInNativeUnits: amountInNativeUnits.toString(),
        decimals: ethUsdtDecimals,
      });

      // Get quote
      const receivedAmountStr = await adapter.getReceivedAmount(amountInNativeUnits.toString(), route);
      logger.info('Received Stargate quote', {
        requestId,
        route,
        amountToBridge: amountInNativeUnits.toString(),
        receivedAmount: receivedAmountStr,
      });

      // Check slippage - use safeParseBigInt for adapter response
      // Note: Both receivedAmount and minimumAcceptableAmount are in native units (6 decimals)
      const receivedAmount = safeParseBigInt(receivedAmountStr);
      // slippagesDbps config uses basis points (500 = 5%), not deci-basis points
      const slippageBps = BigInt(route.slippagesDbps[0]);
      const minimumAcceptableAmount = amountInNativeUnits - (amountInNativeUnits * slippageBps) / BPS_MULTIPLIER;

      if (receivedAmount < minimumAcceptableAmount) {
        logger.warn('Stargate quote does not meet slippage requirements', {
          requestId,
          route,
          amountToBridge: amountInNativeUnits.toString(),
          receivedAmount: receivedAmount.toString(),
          minimumAcceptableAmount: minimumAcceptableAmount.toString(),
        });
        continue;
      }

      // Get bridge transactions
      // Sender is EVM address, recipient is TON address (for Stargate to deliver to)
      const bridgeTxRequests = await adapter.send(evmSender, tonRecipient, amountInNativeUnits.toString(), route);

      if (!bridgeTxRequests.length) {
        logger.error('No bridge transactions returned from Stargate adapter', { requestId });
        continue;
      }

      logger.info('Prepared Stargate bridge transactions', {
        requestId,
        route,
        transactionCount: bridgeTxRequests.length,
      });

      // Execute bridge transactions
      const { receipt, effectiveBridgedAmount } = await executeBridgeTransactions({
        context: { requestId, logger, chainService, config },
        route,
        bridgeType,
        bridgeTxRequests,
        amountToBridge,
      });

      // Create database record for Leg 1
      // Store both TON recipient (for Stargate) and TAC recipient (for Leg 2)
      // Note: Use USDT_TICKER_HASH as fallback to ensure we store ticker hash, not address
      await createRebalanceOperation({
        earmarkId: earmark.id,
        originChainId: route.origin,
        destinationChainId: route.destination,
        tickerHash: getTickerForAsset(route.asset, route.origin, config) || USDT_TICKER_HASH,
        amount: effectiveBridgedAmount,
        slippage: route.slippagesDbps[0],
        status: RebalanceOperationStatus.PENDING,
        bridge: 'stargate-tac', // Tagged for TAC flow
        transactions: receipt
          ? {
              [route.origin]: receipt,
            }
          : undefined,
        recipient: tacRecipient, // Final TAC recipient
      });

      logger.info('Successfully created TAC Leg 1 rebalance operation', {
        requestId,
        route,
        bridgeType,
        originTxHash: receipt?.transactionHash,
        amountToBridge: effectiveBridgedAmount,
      });

      // Track the operation
      const rebalanceAction: RebalanceAction = {
        bridge: adapter.type(),
        amount: amountToBridge.toString(),
        origin: route.origin,
        destination: route.destination,
        asset: route.asset,
        transaction: receipt?.transactionHash || '',
        recipient: tacRecipient, // Final TAC destination
      };
      actions.push(rebalanceAction as RebalanceAction);

      rebalanceSuccessful = true;

      // Track committed funds to prevent over-committing in subsequent operations
      const bridgedAmount = safeParseBigInt(effectiveBridgedAmount);
      runState.committedEthUsdt += bridgedAmount;
      remainingEthUsdt -= bridgedAmount;

      logger.debug('Updated committed funds after on-demand bridge', {
        requestId,
        invoiceId: invoice.intent_id.toString(),
        bridgedAmount: bridgedAmount.toString(),
        totalCommitted: runState.committedEthUsdt.toString(),
        remainingAvailable: remainingEthUsdt.toString(),
      });
    } catch (error) {
      logger.error('Failed to execute Stargate bridge', {
        requestId,
        route,
        bridgeType,
        error: jsonifyError(error),
      });
      continue;
    }

    if (rebalanceSuccessful) {
      logger.info('Leg 1 rebalance successful', {
        requestId,
        route,
        amountToBridge: amountToBridge.toString(),
      });
    } else {
      logger.warn('Failed to complete Leg 1 rebalance', {
        requestId,
        route,
        amountToBridge: amountToBridge.toString(),
      });
    }
  }

  return actions;
};

/**
 * Parameters for threshold-based rebalancing
 * All bigint values should be in 18 decimal format (normalized)
 */
interface ThresholdRebalanceParams {
  context: ProcessingContext;
  recipientAddress: string;
  threshold: bigint; // In 18 decimals
  targetBalance: bigint; // In 18 decimals
  availableEthUsdt: bigint; // In 18 decimals
  runState: RebalanceRunState;
  tacUsdtAddress: string;
  tacUsdtDecimals: number;
}

const processThresholdRebalancing = async ({
  context,
  recipientAddress,
  threshold,
  targetBalance,
  availableEthUsdt,
  runState,
  tacUsdtAddress,
  tacUsdtDecimals,
}: ThresholdRebalanceParams): Promise<RebalanceAction[]> => {
  const { config, database: db, logger, requestId, prometheus } = context;
  const bridgeConfig = config.tacRebalance!.bridge;

  // Determine wallet type based on recipient address
  const isMMRecipient = recipientAddress.toLowerCase() === config.tacRebalance?.marketMaker?.address?.toLowerCase();
  const isFSRecipient = recipientAddress.toLowerCase() === config.tacRebalance?.fillService?.address?.toLowerCase();
  const walletType = isMMRecipient ? 'market-maker' : isFSRecipient ? 'fill-service' : 'unknown';

  // 1. Get current USDT balance on TAC for this recipient
  // Returns balance normalized to 18 decimals
  const tacBalance = await getEvmBalance(
    config,
    TAC_CHAIN_ID.toString(),
    recipientAddress,
    tacUsdtAddress,
    tacUsdtDecimals,
    prometheus,
  );

  logger.debug('Retrieved TAC USDT balance for threshold check', {
    requestId,
    walletType,
    address: recipientAddress,
    chainId: TAC_CHAIN_ID.toString(),
    balance: tacBalance.toString(),
    threshold: threshold.toString(),
    note: 'Both values in 18 decimal format',
  });

  if (tacBalance >= threshold) {
    logger.debug('TAC balance above threshold, skipping rebalance', {
      requestId,
      walletType,
      address: recipientAddress,
      balance: tacBalance.toString(),
      threshold: threshold.toString(),
    });
    return [];
  }

  // 2. Check for in-flight operations to this recipient
  const pendingOps = await db.getRebalanceOperationByRecipient(Number(TAC_CHAIN_ID), recipientAddress, [
    RebalanceOperationStatus.PENDING,
    RebalanceOperationStatus.AWAITING_CALLBACK,
  ]);
  if (pendingOps.length > 0) {
    logger.info('Active rebalance in progress for recipient', {
      requestId,
      walletType,
      address: recipientAddress,
      pendingOps: pendingOps.length,
    });
    return [];
  }

  // 3. Calculate amount needed
  // shortfall is in 18 decimals (targetBalance and tacBalance are both normalized)
  const shortfall = targetBalance - tacBalance;
  // Convert bridge config amounts from native (6 decimals) to normalized (18 decimals)
  // Use safeParseBigInt for robust parsing of config strings
  const minAmountNative = safeParseBigInt(bridgeConfig.minRebalanceAmount);
  const minAmount = convertTo18Decimals(minAmountNative, tacUsdtDecimals);
  const maxAmountNative = safeParseBigInt(bridgeConfig.maxRebalanceAmount);
  const maxAmount = maxAmountNative > 0n ? convertTo18Decimals(maxAmountNative, tacUsdtDecimals) : shortfall;

  if (shortfall < minAmount) {
    logger.debug('Shortfall below minimum, skipping', {
      requestId,
      shortfall: shortfall.toString(),
      minAmount: minAmount.toString(),
      note: 'Both values in 18 decimal format',
    });
    return [];
  }

  // 4. Use available ETH balance (already accounts for committed funds in this run)
  // This prevents over-committing when both MM and FS need rebalancing simultaneously
  const remainingEthUsdt = availableEthUsdt - runState.committedEthUsdt;

  logger.debug('Threshold rebalancing: checking available balance', {
    requestId,
    recipient: recipientAddress,
    availableEthUsdt: availableEthUsdt.toString(),
    alreadyCommitted: runState.committedEthUsdt.toString(),
    remainingEthUsdt: remainingEthUsdt.toString(),
    shortfall: shortfall.toString(),
  });

  // Calculate amount to bridge: min(shortfall, maxAmount, remainingEthUsdt)
  const amountToBridge =
    shortfall < maxAmount && shortfall < remainingEthUsdt
      ? shortfall
      : maxAmount < remainingEthUsdt
        ? maxAmount
        : remainingEthUsdt;

  if (amountToBridge < minAmount) {
    logger.warn('Insufficient available balance for threshold rebalance', {
      requestId,
      recipient: recipientAddress,
      remainingEthUsdt: remainingEthUsdt.toString(),
      minRequired: minAmount.toString(),
      amountToBridge: amountToBridge.toString(),
      note: 'Available balance may be reduced by other operations in this run',
    });
    return [];
  }

  // 5. Execute bridge (no earmark for threshold-based)
  // Pass runState to track committed funds
  const actions = await executeTacBridge(context, recipientAddress, amountToBridge, null);

  // Track committed funds if bridge was successful
  if (actions.length > 0) {
    runState.committedEthUsdt += amountToBridge;
    logger.debug('Updated committed funds after threshold bridge', {
      requestId,
      recipient: recipientAddress,
      bridgedAmount: amountToBridge.toString(),
      totalCommitted: runState.committedEthUsdt.toString(),
    });
  }

  return actions;
};

const executeTacBridge = async (
  context: ProcessingContext,
  recipientAddress: string, // Final TAC recipient
  amount: bigint,
  earmarkId: string | null, // null for threshold-based
): Promise<RebalanceAction[]> => {
  const { config, chainService, fillServiceChainService, logger, requestId, rebalance, prometheus } = context;
  // Existing Stargate bridge logic
  // Store recipientAddress in operation.recipient
  // Store earmarkId (null for threshold-based)
  const actions: RebalanceAction[] = [];

  // Determine if this is for Fill Service or Market Maker based on recipient
  const isForFillService = recipientAddress.toLowerCase() === config.tacRebalance?.fillService?.address?.toLowerCase();
  const walletType = isForFillService ? 'fill-service' : 'market-maker';

  // Get USDT balances across all chains for Market Maker address (source of funds)
  const balances = await getMarkBalancesForTicker(USDT_TICKER_HASH, config, chainService, prometheus);
  logger.debug('Retrieved USDT balances for Market Maker (source)', {
    requestId,
    walletType: 'market-maker',
    address: config.ownAddress,
    recipientWalletType: walletType,
    recipientAddress,
    balances: jsonifyMap(balances),
  });

  if (!balances) {
    logger.warn('No USDT balances found for Market Maker, skipping', {
      requestId,
      address: config.ownAddress,
      recipientWalletType: walletType,
      recipientAddress,
    });
    return [];
  }

  const origin = Number(MAINNET_CHAIN_ID); // Always start from Ethereum mainnet

  // --- Leg 1: Bridge USDT from Ethereum to TON via Stargate ---
  let rebalanceSuccessful = false;
  const bridgeType = SupportedBridge.Stargate;

  // Determine sender for the bridge based on recipient type
  // For Fill Service recipient: prefer filler as sender, fallback to MM
  // For Market Maker recipient: always use MM
  // Use senderAddress if explicitly set, otherwise default to address (same key = same address on ETH and TAC)
  const fillerSenderAddress =
    config.tacRebalance?.fillService?.senderAddress ?? config.tacRebalance?.fillService?.address;

  let evmSender: string;
  let senderConfig: TacSenderConfig | undefined;
  let selectedChainService = chainService;

  if (isForFillService && fillerSenderAddress && fillServiceChainService) {
    // Check if filler has enough USDT on ETH to send
    // getEvmBalance returns balance in 18 decimals (normalized)
    // amount is in 18 decimals (from getMarkBalancesForTicker which also normalizes)
    let fillerBalance = 0n;
    try {
      fillerBalance = await getEvmBalance(
        config,
        MAINNET_CHAIN_ID.toString(),
        fillerSenderAddress,
        USDT_ON_ETH_ADDRESS,
        6, // USDT native decimals - will be converted to 18 internally
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

    logger.debug('Retrieved USDT balance for Fill Service sender', {
      requestId,
      walletType: 'fill-service',
      address: fillerSenderAddress,
      chainId: MAINNET_CHAIN_ID.toString(),
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
      logger.info('Using Fill Service sender for TAC rebalancing (filler has sufficient balance)', {
        requestId,
        sender: fillerSenderAddress,
        balance: fillerBalance.toString(),
        amount: amount.toString(),
      });
    } else {
      // Filler doesn't have enough - fall back to MM
      evmSender = getActualAddress(origin, config, logger, { requestId });
      senderConfig = {
        address: evmSender,
        label: 'market-maker',
      };
      logger.info('Falling back to Market Maker sender for TAC rebalancing (filler has insufficient balance)', {
        requestId,
        fillerAddress: fillerSenderAddress,
        fillerBalance: fillerBalance.toString(),
        mmAddress: evmSender,
        requiredAmount: amount.toString(),
      });
    }
  } else {
    // MM recipient or no FS sender configured - use default
    evmSender = getActualAddress(origin, config, logger, { requestId });
    senderConfig = {
      address: evmSender,
      label: 'market-maker',
    };
  }

  // tonRecipient: TON wallet address that receives USDT on TON (intermediate step)
  // This wallet will sign Leg 2 using config.ton.mnemonic
  const tonRecipient = config.ownTonAddress;

  // tacRecipient: Final EVM address on TAC that should receive USDT
  // The TAC SDK allows sending to any EVM address via evmProxyMsg.evmTargetAddress
  // SECURITY: We restrict recipients to ONLY the configured MM or FS addresses
  // This prevents funds from being sent to arbitrary/malicious addresses
  const tacRecipient = recipientAddress;

  // Security validation: Ensure recipient is one of the configured TAC receivers
  const allowedRecipients = [
    config.tacRebalance?.marketMaker?.address?.toLowerCase(),
    config.tacRebalance?.fillService?.address?.toLowerCase(),
  ].filter(Boolean);

  if (!allowedRecipients.includes(recipientAddress.toLowerCase())) {
    logger.error('Recipient address is not a configured TAC receiver (MM or FS)', {
      requestId,
      recipientAddress,
      allowedRecipients,
      note: 'Only tacRebalance.marketMaker.address and tacRebalance.fillService.address are allowed',
    });
    return [];
  }

  // Validate TON address is configured
  if (!tonRecipient) {
    logger.error('TON address not configured (config.ownTonAddress), cannot execute Stargate bridge', {
      requestId,
      note: 'Add ownTonAddress to config to enable TAC rebalancing',
    });
    return [];
  }

  // Check if recipient is MM vs FS and log appropriately
  const isMarketMaker = tacRecipient.toLowerCase() === config.tacRebalance?.marketMaker?.address?.toLowerCase();
  const isFillService = tacRecipient.toLowerCase() === config.tacRebalance?.fillService?.address?.toLowerCase();

  // IMPORTANT: If recipient is MM but doesn't match ownAddress, funds won't be usable for intent filling
  // because intent filling always uses config.ownAddress as the source of funds
  if (isMarketMaker && tacRecipient.toLowerCase() !== config.ownAddress.toLowerCase()) {
    logger.warn('Market Maker address differs from ownAddress - funds will NOT be usable for intent filling!', {
      requestId,
      mmAddress: tacRecipient,
      ownAddress: config.ownAddress,
      note: 'Intent filling requires funds at ownAddress. Consider setting MM address = ownAddress.',
    });
  }

  logger.debug('Address flow for two-leg bridge', {
    requestId,
    evmSender,
    tonRecipient,
    tacRecipient,
    isMarketMaker,
    isFillService,
    canUseForIntentFilling: tacRecipient.toLowerCase() === config.ownAddress.toLowerCase(),
  });

  // Use slippage from config (default 500 = 5%)
  const slippageDbps = config.tacRebalance!.bridge.slippageDbps;

  const route = {
    asset: USDT_ON_ETH_ADDRESS,
    origin: origin,
    destination: Number(TON_LZ_CHAIN_ID), // First leg goes to TON
    maximum: amount.toString(),
    slippagesDbps: [slippageDbps],
    preferences: [bridgeType],
    reserve: '0',
  };

  logger.info('Attempting Leg 1: Ethereum to TON via Stargate', {
    requestId,
    bridgeType,
    amount: amount.toString(),
    evmSender,
    tonRecipient,
    tacRecipient,
  });

  const adapter = rebalance.getAdapter(bridgeType);
  if (!adapter) {
    logger.error('Stargate adapter not found', { requestId });
    return [];
  }

  try {
    // CRITICAL: Convert amount from 18 decimals to native USDT decimals (6)
    // The Stargate API expects amounts in native token units, not normalized 18 decimals
    // Without this conversion, amounts like "10000000000000000000" (10 USDT in 18 decimals)
    // are interpreted as 10 trillion USDT, exceeding pool liquidity and causing "Failed to get route"
    const ethUsdtDecimals = getDecimalsFromConfig(USDT_TICKER_HASH, origin.toString(), config) ?? 6;
    const amountInNativeUnits = convertToNativeUnits(amount, ethUsdtDecimals);

    logger.debug('Converting amount to native units for Stargate', {
      requestId,
      amountIn18Decimals: amount.toString(),
      amountInNativeUnits: amountInNativeUnits.toString(),
      decimals: ethUsdtDecimals,
    });

    // Get quote
    const receivedAmountStr = await adapter.getReceivedAmount(amountInNativeUnits.toString(), route);
    logger.info('Received Stargate quote', {
      requestId,
      route,
      amountToBridge: amountInNativeUnits.toString(),
      receivedAmount: receivedAmountStr,
    });

    // Check slippage - use safeParseBigInt for adapter response
    // Note: Both receivedAmount and minimumAcceptableAmount are in native units (6 decimals)
    const receivedAmount = safeParseBigInt(receivedAmountStr);
    // slippagesDbps config uses basis points (500 = 5%), not deci-basis points
    const slippageBps = BigInt(route.slippagesDbps[0]);
    const minimumAcceptableAmount = amountInNativeUnits - (amountInNativeUnits * slippageBps) / BPS_MULTIPLIER;

    if (receivedAmount < minimumAcceptableAmount) {
      logger.warn('Stargate quote does not meet slippage requirements', {
        requestId,
        route,
        amountToBridge: amountInNativeUnits.toString(),
        receivedAmount: receivedAmount.toString(),
        minimumAcceptableAmount: minimumAcceptableAmount.toString(),
      });
      return [];
    }

    // Get bridge transactions
    // Sender is EVM address, recipient is TON address (for Stargate to deliver to)
    const bridgeTxRequests = await adapter.send(evmSender, tonRecipient, amountInNativeUnits.toString(), route);

    if (!bridgeTxRequests.length) {
      logger.error('No bridge transactions returned from Stargate adapter', { requestId });
      return [];
    }

    logger.info('Prepared Stargate bridge transactions', {
      requestId,
      route,
      transactionCount: bridgeTxRequests.length,
    });

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
    // Store both TON recipient (for Stargate) and TAC recipient (for Leg 2)
    // Note: Use USDT_TICKER_HASH as fallback to ensure we store ticker hash, not address
    await createRebalanceOperation({
      earmarkId: earmarkId,
      originChainId: route.origin,
      destinationChainId: route.destination,
      tickerHash: getTickerForAsset(route.asset, route.origin, config) || USDT_TICKER_HASH,
      amount: effectiveBridgedAmount,
      slippage: route.slippagesDbps[0],
      status: RebalanceOperationStatus.PENDING,
      bridge: 'stargate-tac', // Tagged for TAC flow
      transactions: receipt
        ? {
            [route.origin]: receipt,
          }
        : undefined,
      recipient: tacRecipient, // Final TAC recipient
    });

    logger.info('Successfully created TAC Leg 1 rebalance operation', {
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
      recipient: tacRecipient, // Final TAC destination
    };
    actions.push(rebalanceAction);

    rebalanceSuccessful = true;
  } catch (error) {
    logger.error('Failed to execute Stargate bridge', {
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

/**
 * Evaluate Fill Service rebalancing with priority logic:
 *
 * PRIORITY 1: Same-Account Flow (FS → FS)
 *   - Use FS sender's own ETH USDT to bridge to FS TAC address
 *   - This is always preferred as it doesn't require cross-wallet coordination
 *
 * PRIORITY 2: Cross-Wallet Flow (MM → FS)
 *   - Only if allowCrossWalletRebalancing=true
 *   - Only if FS sender doesn't have enough funds
 *   - Only if no pending FS rebalancing operations (both Leg1 and Leg2 must be complete)
 *   - Uses MM's ETH USDT to bridge to FS TAC address
 */
const evaluateFillServiceRebalance = async (
  context: ProcessingContext,
  mmAvailableEthUsdt: bigint,
  runState: RebalanceRunState,
  usdtInfo: UsdtInfo,
): Promise<RebalanceAction[]> => {
  const { config, database: db, logger, requestId, prometheus, fillServiceChainService } = context;

  const fsConfig = config.tacRebalance!.fillService;
  if (!fsConfig.thresholdEnabled) {
    logger.debug('FS threshold rebalancing disabled', { requestId });
    return [];
  }

  // Convert config values from native decimals (6) to normalized (18)
  const thresholdNative = safeParseBigInt(fsConfig.threshold);
  const targetNative = safeParseBigInt(fsConfig.targetBalance);
  const minRebalanceNative = safeParseBigInt(config.tacRebalance!.bridge.minRebalanceAmount);
  const threshold18 = convertTo18Decimals(thresholdNative, usdtInfo.tacDecimals);
  const target18 = convertTo18Decimals(targetNative, usdtInfo.tacDecimals);
  const minRebalance18 = convertTo18Decimals(minRebalanceNative, usdtInfo.tacDecimals);

  // Get FS sender address (used for same-account flow)
  const fsSenderAddress = fsConfig.senderAddress ?? fsConfig.address;
  const allowCrossWallet = fsConfig.allowCrossWalletRebalancing ?? false;

  // Step 1: Check current FS balance on TAC
  const fsTacBalance = await getEvmBalance(
    config,
    TAC_CHAIN_ID.toString(),
    fsConfig.address!,
    usdtInfo.tacAddress,
    usdtInfo.tacDecimals,
    prometheus,
  );

  logger.debug('FS TAC balance check', {
    requestId,
    walletType: 'fill-service',
    fsAddress: fsConfig.address,
    fsTacBalance: fsTacBalance.toString(),
    threshold18: threshold18.toString(),
    target18: target18.toString(),
  });

  // If balance is above threshold, no rebalance needed
  if (fsTacBalance >= threshold18) {
    logger.debug('FS TAC balance above threshold, no rebalance needed', {
      requestId,
      walletType: 'fill-service',
      fsAddress: fsConfig.address,
      balance: fsTacBalance.toString(),
      threshold: threshold18.toString(),
    });
    return [];
  }

  // Calculate shortfall
  const shortfall = target18 - fsTacBalance;
  if (shortfall < minRebalance18) {
    logger.debug('FS shortfall below minimum rebalance amount', {
      requestId,
      shortfall: shortfall.toString(),
      minRebalance: minRebalance18.toString(),
    });
    return [];
  }

  // Step 2: Check for pending FS rebalancing operations
  const pendingFsOps = await db.getRebalanceOperationByRecipient(Number(TAC_CHAIN_ID), fsConfig.address!, [
    RebalanceOperationStatus.PENDING,
    RebalanceOperationStatus.AWAITING_CALLBACK,
  ]);

  // Step 3: Get FS sender's ETH USDT balance
  let fsSenderEthBalance = 0n;
  if (fsSenderAddress && fillServiceChainService) {
    try {
      fsSenderEthBalance = await getEvmBalance(
        config,
        MAINNET_CHAIN_ID.toString(),
        fsSenderAddress,
        USDT_ON_ETH_ADDRESS,
        usdtInfo.ethDecimals,
        prometheus,
      );
    } catch (error) {
      logger.warn('Failed to check FS sender ETH balance', {
        requestId,
        fsSenderAddress,
        error: jsonifyError(error),
      });
    }
  }

  logger.info('Evaluating FS rebalancing options', {
    requestId,
    walletType: 'fill-service',
    fsAddress: fsConfig.address,
    fsSenderAddress,
    fsTacBalance: fsTacBalance.toString(),
    shortfall: shortfall.toString(),
    fsSenderEthBalance: fsSenderEthBalance.toString(),
    mmAvailableEthUsdt: mmAvailableEthUsdt.toString(),
    allowCrossWallet,
    pendingFsOpsCount: pendingFsOps.length,
    hasFillServiceChainService: !!fillServiceChainService,
  });

  // PRIORITY 1: Same-Account Flow (FS → FS)
  // FS sender has enough funds to cover the shortfall
  if (fsSenderEthBalance >= minRebalance18 && fillServiceChainService) {
    const amountToBridge = fsSenderEthBalance < shortfall ? fsSenderEthBalance : shortfall;

    if (amountToBridge >= minRebalance18) {
      logger.info('PRIORITY 1: Using FS same-account flow (FS sender has funds)', {
        requestId,
        flowType: 'same-account',
        sender: fsSenderAddress,
        recipient: fsConfig.address,
        amountToBridge: amountToBridge.toString(),
        fsSenderEthBalance: fsSenderEthBalance.toString(),
        shortfall: shortfall.toString(),
      });

      return processThresholdRebalancing({
        context,
        recipientAddress: fsConfig.address!,
        threshold: threshold18,
        targetBalance: target18,
        availableEthUsdt: fsSenderEthBalance, // Only FS funds for same-account flow
        runState,
        tacUsdtAddress: usdtInfo.tacAddress,
        tacUsdtDecimals: usdtInfo.tacDecimals,
      });
    }
  }

  // PRIORITY 2: Cross-Wallet Flow (MM → FS)
  // FS sender doesn't have enough, check if cross-wallet is allowed
  if (!allowCrossWallet) {
    logger.info('Cross-wallet rebalancing disabled, FS has insufficient funds', {
      requestId,
      fsSenderEthBalance: fsSenderEthBalance.toString(),
      shortfall: shortfall.toString(),
      note: 'Enable allowCrossWalletRebalancing to use MM funds for FS',
    });
    return [];
  }

  // Cross-wallet safety check: no pending FS operations
  if (pendingFsOps.length > 0) {
    logger.info('Cross-wallet rebalancing blocked: pending FS operations exist', {
      requestId,
      pendingOpsCount: pendingFsOps.length,
      pendingOps: pendingFsOps.map((op) => ({
        id: op.id,
        status: op.status,
        bridge: op.bridge,
        amount: op.amount,
      })),
      note: 'Waiting for all Leg1 and Leg2 operations to complete before cross-wallet',
    });
    return [];
  }

  // Check if MM has funds available
  const mmRemainingBalance = mmAvailableEthUsdt - runState.committedEthUsdt;
  if (mmRemainingBalance < minRebalance18) {
    logger.info('Cross-wallet rebalancing: MM has insufficient available funds', {
      requestId,
      mmAvailableEthUsdt: mmAvailableEthUsdt.toString(),
      committed: runState.committedEthUsdt.toString(),
      mmRemainingBalance: mmRemainingBalance.toString(),
      minRebalance: minRebalance18.toString(),
    });
    return [];
  }

  // Calculate amount to bridge from MM
  const amountFromMm = mmRemainingBalance < shortfall ? mmRemainingBalance : shortfall;

  logger.info('PRIORITY 2: Using cross-wallet flow (MM → FS)', {
    requestId,
    flowType: 'cross-wallet',
    sender: config.ownAddress,
    recipient: fsConfig.address,
    amountToBridge: amountFromMm.toString(),
    mmRemainingBalance: mmRemainingBalance.toString(),
    shortfall: shortfall.toString(),
  });

  return processThresholdRebalancing({
    context,
    recipientAddress: fsConfig.address!,
    threshold: threshold18,
    targetBalance: target18,
    availableEthUsdt: mmRemainingBalance, // MM funds for cross-wallet flow
    runState,
    tacUsdtAddress: usdtInfo.tacAddress,
    tacUsdtDecimals: usdtInfo.tacDecimals,
  });
};

/**
 * Calculate the minimum expected amount after slippage
 * @param amount - Original amount
 * @param slippageBps - Slippage in basis points (e.g., 500 = 5%)
 * @returns Minimum expected amount after slippage
 */
const calculateMinExpectedAmount = (amount: bigint, slippageBps: number): bigint => {
  const slippage = BigInt(slippageBps);
  return amount - (amount * slippage) / BPS_MULTIPLIER;
};

/**
 * Execute callbacks for pending TAC rebalance operations
 *
 * This handles:
 * - Checking if Leg 1 (Stargate) is complete
 * - Executing Leg 2 (TAC Inner Bridge) when Leg 1 completes
 * - Checking if Leg 2 is complete
 *
 * IMPORTANT: Flow Isolation
 * - Only ONE Leg 2 operation can be in-flight at a time
 * - Each flow only bridges its own operation-specific amount
 * - This prevents mixing funds from multiple concurrent flows
 */
const executeTacCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, config, rebalance, database: db } = context;
  logger.info('Executing TAC USDT rebalance callbacks', { requestId });

  // Get operation TTL from config (with default fallback)
  const operationTtlMinutes = config.regularRebalanceOpTTLMinutes ?? DEFAULT_OPERATION_TTL_MINUTES;

  // Get all pending TAC operations
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  // Filter for TAC-related operations
  const tacOperations = operations.filter(
    (op) => op.bridge === 'stargate-tac' || op.bridge === SupportedBridge.TacInner,
  );

  // SERIALIZATION CHECK: Only allow one Leg 2 (TacInner) operation in-flight at a time
  // This prevents mixing funds from multiple flows when they complete close together
  const pendingTacInnerOps = tacOperations.filter(
    (op) =>
      op.bridge === SupportedBridge.TacInner &&
      (op.status === RebalanceOperationStatus.PENDING || op.status === RebalanceOperationStatus.AWAITING_CALLBACK),
  );

  const hasInFlightLeg2 = pendingTacInnerOps.length > 0;

  logger.debug('Found TAC rebalance operations', {
    count: tacOperations.length,
    pendingLeg2Count: pendingTacInnerOps.length,
    hasInFlightLeg2,
    requestId,
  });

  for (const operation of tacOperations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
      bridge: operation.bridge,
    };

    if (!operation.bridge) {
      logger.warn('Operation missing bridge type', logContext);
      continue;
    }

    // Check for operation timeout - operations stuck too long should be marked as cancelled
    if (operation.createdAt && isOperationTimedOut(operation.createdAt, operationTtlMinutes)) {
      const operationAgeMinutes = Math.round((Date.now() - operation.createdAt.getTime()) / (60 * 1000));
      logger.warn('TAC operation timed out - marking as cancelled', {
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
          logger.info('Earmark cancelled due to TAC operation timeout', {
            ...logContext,
            earmarkId: operation.earmarkId,
          });
        }
      } catch (error) {
        logger.error('Failed to cancel timed-out TAC operation', {
          ...logContext,
          error: jsonifyError(error),
        });
      }
      continue;
    }

    const isStargateToTon = operation.bridge === 'stargate-tac';
    const isTacInnerBridge = operation.bridge === SupportedBridge.TacInner;

    // Get transaction receipt
    const txHashes = operation.transactions;
    const originTx = txHashes?.[operation.originChainId] as
      | TransactionEntry<{ receipt: TransactionReceipt }>
      | undefined;

    if (!originTx && !isTacInnerBridge) {
      logger.warn('Operation missing origin transaction', { ...logContext, operation });
      continue;
    }

    const receipt = originTx?.metadata?.receipt;
    if (!receipt && !isTacInnerBridge) {
      logger.info('Origin transaction receipt not found', { ...logContext });
      continue;
    }

    // For TAC Inner Bridge (TON → TAC), get jetton address from config.ton.assets
    // since TON (chain 30826) isn't in the EVM chains config block
    let assetAddress: string;
    if (isTacInnerBridge) {
      const tonAsset = getTonAssetAddress(operation.tickerHash, config);
      if (!tonAsset) {
        logger.error('Could not find TON jetton address in config.ton.assets', {
          ...logContext,
          tickerHash: operation.tickerHash,
          note: 'Add asset to config.ton.assets with jettonAddress',
        });
        continue;
      }
      assetAddress = tonAsset;
    } else {
      const configAsset = getTokenAddressFromConfig(operation.tickerHash, operation.originChainId.toString(), config);
      if (!configAsset) {
        logger.error('Could not find asset address for ticker hash', {
          ...logContext,
          tickerHash: operation.tickerHash,
        });
        continue;
      }
      assetAddress = configAsset;
    }

    const route = {
      origin: operation.originChainId,
      destination: operation.destinationChainId,
      asset: assetAddress,
    };

    // Handle Stargate operations (Leg 1: Ethereum → TON)
    if (isStargateToTon) {
      const stargateAdapter = rebalance.getAdapter(SupportedBridge.Stargate);

      if (operation.status === RebalanceOperationStatus.PENDING) {
        try {
          const ready = await stargateAdapter.readyOnDestination(
            operation.amount,
            route,
            receipt as unknown as ViemTransactionReceipt,
          );

          if (ready) {
            await db.updateRebalanceOperation(operation.id, {
              status: RebalanceOperationStatus.AWAITING_CALLBACK,
            });
            logger.info('Stargate transfer ready, updated to AWAITING_CALLBACK', {
              ...logContext,
            });
            operation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
          } else {
            logger.info('Stargate transfer not yet ready', logContext);
          }
        } catch (e: unknown) {
          logger.error('Failed to check Stargate readiness', { ...logContext, error: jsonifyError(e) });
          continue;
        }
      }

      // Execute Leg 2: TON → TAC using TAC SDK
      if (operation.status === RebalanceOperationStatus.AWAITING_CALLBACK) {
        // SERIALIZATION: Only allow one Leg 2 in-flight at a time
        // This prevents mixing funds from multiple flows
        if (hasInFlightLeg2) {
          logger.info('Skipping Leg 2 execution - another Leg 2 is already in-flight', {
            ...logContext,
            pendingLeg2Count: pendingTacInnerOps.length,
            pendingLeg2Ids: pendingTacInnerOps.map((op) => op.id),
            note: 'Will retry when current Leg 2 completes to prevent fund mixing',
          });
          continue;
        }

        logger.info('Executing Leg 2: TON to TAC via TAC Inner Bridge (TAC SDK)', logContext);

        try {
          // Get the TAC Inner Bridge adapter (which has TAC SDK integration)
          const tacInnerAdapter = rebalance.getAdapter(SupportedBridge.TacInner) as unknown as {
            executeTacBridge: (
              tonMnemonic: string,
              recipient: string,
              amount: string,
              asset?: string,
            ) => Promise<unknown>;
          };

          // Get recipient address (TAC EVM address)
          // CRITICAL: Use the stored recipient from Leg 1 operation to ensure consistency
          // This is the same address as the original Ethereum sender
          const storedRecipient = operation.recipient;
          const recipient = storedRecipient || config.ownAddress;

          logger.debug('Leg 2 recipient address', {
            ...logContext,
            storedRecipient,
            fallbackRecipient: config.ownAddress,
            finalRecipient: recipient,
          });

          // Check if TON mnemonic is configured
          const tonMnemonic = config.ton?.mnemonic;

          if (!tonMnemonic) {
            logger.warn('TON mnemonic not configured, cannot execute Leg 2 via TAC SDK', {
              ...logContext,
              note: 'Add ton.mnemonic to config to enable TAC bridge execution',
            });

            // Still create the operation record for tracking
            // Link to the same earmark as Leg 1 for proper tracking
            await createRebalanceOperation({
              earmarkId: operation.earmarkId,
              originChainId: Number(TON_LZ_CHAIN_ID),
              destinationChainId: Number(TAC_CHAIN_ID),
              tickerHash: operation.tickerHash,
              amount: operation.amount,
              slippage: 100,
              status: RebalanceOperationStatus.PENDING,
              bridge: SupportedBridge.TacInner,
              recipient: recipient,
            });
          } else {
            // Query actual USDT balance on TON (Stargate may have taken fees)
            const tonWalletAddress = config.ownTonAddress;
            const tonApiKey = config.ton?.apiKey;

            if (!tonWalletAddress) {
              logger.error('TON wallet address not configured, cannot query balance', logContext);
              continue;
            }

            // Get jetton address from config
            const jettonAddress = getTonAssetAddress(operation.tickerHash, config);
            if (!jettonAddress) {
              logger.error('TON jetton address not found in config.ton.assets', {
                ...logContext,
                tickerHash: operation.tickerHash,
                note: 'Add asset to config.ton.assets with jettonAddress',
              });
              continue;
            }

            // Check TON native balance for gas
            const tonNativeBalance = await getTonNativeBalance(tonWalletAddress, tonApiKey);
            if (tonNativeBalance < MIN_TON_GAS_BALANCE) {
              logger.error('Insufficient TON balance for gas', {
                ...logContext,
                tonWalletAddress,
                tonBalance: tonNativeBalance.toString(),
                minRequired: MIN_TON_GAS_BALANCE.toString(),
                note: 'Fund the TON wallet with at least 0.5 TON for gas',
              });
              continue;
            }

            // Get actual USDT balance on TON
            const actualUsdtBalance = await getTonJettonBalance(tonWalletAddress, jettonAddress, tonApiKey);

            // CRITICAL: Use operation-specific amount, NOT the full wallet balance
            // This prevents mixing funds from multiple concurrent flows
            //
            // Logic:
            // 1. expectedAmount = operation.amount (what we sent in Leg 1)
            // 2. minExpectedAmount = expectedAmount * (1 - slippage) (account for Stargate fees)
            // 3. amountToBridge = min(expectedAmount, actualBalance) - never bridge more than expected
            //
            // Edge cases:
            // - If actualBalance < minExpectedAmount: Stargate might still be in transit, wait
            // - If actualBalance >= expectedAmount: Use expectedAmount (don't take other flows' funds)
            // - If minExpectedAmount <= actualBalance < expectedAmount: Use actualBalance (Stargate took fees)
            const expectedAmount = safeParseBigInt(operation.amount);
            // Config uses "slippageDbps" naming but values are actually basis points (500 = 5%)
            const slippageBps = config.tacRebalance?.bridge?.slippageDbps ?? 500; // Default 5%
            const minExpectedAmount = calculateMinExpectedAmount(expectedAmount, slippageBps);

            // Validate: TON wallet must have at least the minimum expected amount
            if (actualUsdtBalance < minExpectedAmount) {
              // Not enough funds yet - Stargate might still be in transit or another flow took funds
              logger.warn('Insufficient USDT on TON for this operation - waiting for Stargate delivery', {
                ...logContext,
                expectedAmount: expectedAmount.toString(),
                minExpectedAmount: minExpectedAmount.toString(),
                actualUsdtBalance: actualUsdtBalance.toString(),
                shortfall: (minExpectedAmount - actualUsdtBalance).toString(),
                note: 'Will retry when funds arrive. If persists, check Stargate bridge status.',
              });
              continue;
            }

            // Calculate amount to bridge: min(expectedAmount, actualBalance)
            // NEVER bridge more than the operation's expected amount
            const amountToBridgeBigInt = actualUsdtBalance < expectedAmount ? actualUsdtBalance : expectedAmount;
            const amountToBridge = amountToBridgeBigInt.toString();

            // Log if we're bridging less than expected (Stargate took fees)
            const tookFees = amountToBridgeBigInt < expectedAmount;

            logger.info('Executing TAC SDK bridge transaction', {
              ...logContext,
              recipient,
              expectedAmount: expectedAmount.toString(),
              minExpectedAmount: minExpectedAmount.toString(),
              actualUsdtBalance: actualUsdtBalance.toString(),
              amountToBridge,
              stargateFeesDeducted: tookFees,
              note: tookFees
                ? `Bridging ${amountToBridge} (Stargate took ${expectedAmount - amountToBridgeBigInt} in fees)`
                : 'Bridging expected amount',
            });

            const transactionLinker = await tacInnerAdapter.executeTacBridge(
              tonMnemonic,
              recipient,
              amountToBridge,
              jettonAddress, // CRITICAL: Pass the TON jetton address for the asset to bridge
            );

            // Generate a unique ID for the Leg 2 operation (used in placeholder receipt)
            const leg2OperationId = `leg2-${operation.id}-${Date.now()}`;

            // Create Leg 2 operation record with transaction info
            // CRITICAL: If bridge succeeded but DB write fails, we need to handle gracefully
            // to prevent funds from being stuck without tracking
            try {
              // Create placeholder receipt to store transactionLinker
              const placeholderReceipt = transactionLinker
                ? createTacPlaceholderReceipt(
                    leg2OperationId,
                    config.ownTonAddress || 'ton-sender',
                    recipient,
                    transactionLinker,
                  )
                : undefined;

              await createRebalanceOperation({
                earmarkId: operation.earmarkId,
                originChainId: Number(TON_LZ_CHAIN_ID),
                destinationChainId: Number(TAC_CHAIN_ID),
                tickerHash: operation.tickerHash,
                amount: amountToBridge, // Use actual amount, not original
                slippage: 100,
                // Use AWAITING_CALLBACK if we have transactionLinker (bridge submitted, awaiting completion)
                // Use PENDING if no transactionLinker (bridge failed to submit, will retry)
                status: transactionLinker
                  ? RebalanceOperationStatus.AWAITING_CALLBACK
                  : RebalanceOperationStatus.PENDING,
                bridge: SupportedBridge.TacInner,
                recipient: recipient,
                // Store transactionLinker for later status tracking and to prevent duplicate executions
                transactions: placeholderReceipt
                  ? {
                      [TON_LZ_CHAIN_ID]: placeholderReceipt as TransactionReceipt,
                    }
                  : undefined,
              });

              logger.info('TAC SDK bridge transaction submitted', {
                ...logContext,
                transactionLinker,
                transactionLinkerStored: !!transactionLinker,
                newStatus: transactionLinker
                  ? RebalanceOperationStatus.AWAITING_CALLBACK
                  : RebalanceOperationStatus.PENDING,
              });
            } catch (dbError) {
              // CRITICAL: Bridge succeeded but DB write failed
              // Log extensively so operators can manually reconcile if needed
              logger.error('CRITICAL: TAC bridge executed but failed to create Leg 2 operation record', {
                ...logContext,
                transactionLinker,
                recipient,
                amountToBridge,
                error: jsonifyError(dbError),
                note: 'Bridge funds were sent but operation is not tracked. Manual reconciliation may be needed.',
                recoveryHint: 'Check TON wallet and TAC recipient for the bridged funds.',
              });
              // Don't rethrow - we still need to mark Leg 1 complete to prevent re-execution
            }
          }

          // Mark Leg 1 as completed
          // Note: Earmark stays PENDING until Leg 2 completes (funds arrive on TAC)
          // The earmark will be updated to READY in the isTacInnerBridge section below
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.COMPLETED,
          });

          logger.info('Leg 2 operation created, Leg 1 marked complete', {
            ...logContext,
            leg2Status: RebalanceOperationStatus.PENDING,
          });
        } catch (e: unknown) {
          logger.error('Failed to execute Leg 2', { ...logContext, error: jsonifyError(e) });
          continue;
        }
      }
    }

    // Handle TAC Inner Bridge operations (Leg 2: TON → TAC)
    if (isTacInnerBridge) {
      const tacInnerAdapter = rebalance.getAdapter(SupportedBridge.TacInner) as unknown as {
        readyOnDestination: (
          amount: string,
          route: { origin: number; destination: number; asset: string },
          receipt: ViemTransactionReceipt,
          recipientOverride?: string,
        ) => Promise<boolean>;
        trackOperation: (transactionLinker: unknown) => Promise<string>;
        executeTacBridge: (tonMnemonic: string, recipient: string, amount: string, asset?: string) => Promise<unknown>;
      };

      // Handle both PENDING (needs bridge execution or tracking) and AWAITING_CALLBACK (needs tracking only)
      if (
        operation.status === RebalanceOperationStatus.PENDING ||
        operation.status === RebalanceOperationStatus.AWAITING_CALLBACK
      ) {
        try {
          // Check if we have a transaction linker from TAC SDK
          // The transactionLinker is stored in the transaction entry's metadata.receipt.transactionLinker
          const tonTxData = operation.transactions?.[TON_LZ_CHAIN_ID];
          const tonTxMetadata = tonTxData?.metadata as TacTransactionMetadata | undefined;
          let transactionLinker = tonTxMetadata?.receipt?.transactionLinker;

          // Get the stored recipient from operation
          const storedRecipient = operation.recipient;

          // If no transactionLinker and still PENDING, the bridge was never executed - try to execute it now
          // Skip this for AWAITING_CALLBACK (bridge was submitted, just need to track)
          if (!transactionLinker && storedRecipient && operation.status === RebalanceOperationStatus.PENDING) {
            const tonMnemonic = config.ton?.mnemonic;
            const tonWalletAddress = config.ownTonAddress;
            const tonApiKey = config.ton?.apiKey;

            // Get jetton address from config
            const jettonAddress = getTonAssetAddress(operation.tickerHash, config);
            if (!jettonAddress) {
              logger.error('TON jetton address not found in config.ton.assets', {
                ...logContext,
                tickerHash: operation.tickerHash,
                note: 'Add asset to config.ton.assets with jettonAddress',
              });
              continue;
            }

            if (tonMnemonic && tonWalletAddress) {
              // Get actual USDT balance on TON
              const actualUsdtBalance = await getTonJettonBalance(tonWalletAddress, jettonAddress, tonApiKey);

              if (actualUsdtBalance === 0n) {
                // No USDT on TON - bridge might have already succeeded!
                // Fall through to readyOnDestination check below
                logger.info('No USDT on TON - checking if funds already arrived on TAC', logContext);
              } else {
                // TON has USDT - try to execute the bridge
                // First check TON gas balance
                const tonNativeBalance = await getTonNativeBalance(tonWalletAddress, tonApiKey);
                if (tonNativeBalance < MIN_TON_GAS_BALANCE) {
                  logger.error('Insufficient TON balance for gas (retry)', {
                    ...logContext,
                    tonBalance: tonNativeBalance.toString(),
                    minRequired: MIN_TON_GAS_BALANCE.toString(),
                  });
                  continue;
                }

                // CRITICAL: Use operation-specific amount, NOT the full wallet balance
                // This prevents mixing funds from multiple concurrent flows
                const expectedAmount = safeParseBigInt(operation.amount);
                const slippageDbps = config.tacRebalance?.bridge?.slippageDbps ?? 500; // Default 5%
                const minExpectedAmount = calculateMinExpectedAmount(expectedAmount, slippageDbps);

                // Validate: Must have at least minimum expected amount
                if (actualUsdtBalance < minExpectedAmount) {
                  logger.warn('Insufficient USDT on TON for this operation (retry) - waiting', {
                    ...logContext,
                    expectedAmount: expectedAmount.toString(),
                    minExpectedAmount: minExpectedAmount.toString(),
                    actualUsdtBalance: actualUsdtBalance.toString(),
                    note: 'Another flow may have taken funds or Stargate still in transit',
                  });
                  continue;
                }

                // Calculate amount: min(expectedAmount, actualBalance) - never more than expected
                const amountToBridgeBigInt = actualUsdtBalance < expectedAmount ? actualUsdtBalance : expectedAmount;
                const amountToBridge = amountToBridgeBigInt.toString();

                logger.info('Retrying TAC SDK bridge execution (no transactionLinker)', {
                  ...logContext,
                  recipient: storedRecipient,
                  expectedAmount: expectedAmount.toString(),
                  actualUsdtBalance: actualUsdtBalance.toString(),
                  amountToBridge,
                  note: 'Using operation-specific amount to prevent fund mixing',
                });

                try {
                  transactionLinker = await tacInnerAdapter.executeTacBridge(
                    tonMnemonic,
                    storedRecipient,
                    amountToBridge,
                    jettonAddress, // CRITICAL: Pass the TON jetton address for the asset to bridge
                  );

                  // CRITICAL: If bridge executed successfully, store transactionLinker to prevent retry loops
                  if (transactionLinker) {
                    // Create placeholder receipt using helper function
                    const placeholderReceipt = createTacPlaceholderReceipt(
                      operation.id,
                      tonWalletAddress || 'ton-sender',
                      storedRecipient,
                      transactionLinker,
                    );

                    try {
                      // Update operation with transactionLinker so we don't retry on next poll
                      await db.updateRebalanceOperation(operation.id, {
                        // Use txHashes to store the receipt with transactionLinker
                        txHashes: {
                          [TON_LZ_CHAIN_ID]: placeholderReceipt as TransactionReceipt,
                        },
                        // Change to AWAITING_CALLBACK to indicate bridge submitted, awaiting completion
                        status: RebalanceOperationStatus.AWAITING_CALLBACK,
                      });

                      logger.info('TAC SDK bridge executed successfully, operation updated', {
                        ...logContext,
                        transactionLinker,
                        newStatus: RebalanceOperationStatus.AWAITING_CALLBACK,
                        note: 'TransactionLinker stored, will verify completion on next cycle',
                      });
                    } catch (dbError) {
                      // CRITICAL: Bridge succeeded but DB update failed
                      logger.error('CRITICAL: TAC bridge executed but failed to update operation', {
                        ...logContext,
                        transactionLinker,
                        storedRecipient,
                        amountToBridge,
                        error: jsonifyError(dbError),
                        note: 'Bridge funds were sent but transactionLinker not persisted. May cause retry.',
                      });
                      // Don't continue - fall through to readyOnDestination check
                    }
                    // Continue to next operation - this one is now tracked properly
                    continue;
                  }
                } catch (bridgeError) {
                  logger.error('Failed to execute TAC bridge (retry)', {
                    ...logContext,
                    error: jsonifyError(bridgeError),
                  });
                  continue;
                }
              }
            } else {
              logger.warn('Missing TON config for bridge retry', {
                ...logContext,
                hasMnemonic: !!tonMnemonic,
                hasWalletAddress: !!tonWalletAddress,
              });
              // Still fall through to readyOnDestination check
            }
          }

          let ready = false;

          if (transactionLinker) {
            // Use TAC SDK OperationTracker to check status
            try {
              const status = await tacInnerAdapter.trackOperation(transactionLinker);
              ready = status === 'SUCCESSFUL';

              if (status === 'FAILED') {
                logger.error('TAC SDK operation failed', {
                  ...logContext,
                  status,
                  transactionLinker,
                });
                await db.updateRebalanceOperation(operation.id, {
                  status: RebalanceOperationStatus.CANCELLED,
                });
                continue;
              }

              logger.debug('TAC SDK operation status', {
                ...logContext,
                status,
                ready,
              });
            } catch (trackError) {
              logger.warn('Failed to track via TAC SDK, falling back to balance check', {
                ...logContext,
                error: jsonifyError(trackError),
              });
            }
          }

          // Fallback: Check TAC balance if SDK tracking fails or no linker
          if (!ready && storedRecipient) {
            ready = await tacInnerAdapter.readyOnDestination(
              operation.amount,
              {
                origin: operation.originChainId,
                destination: operation.destinationChainId,
                asset: assetAddress,
              },
              {} as ViemTransactionReceipt,
              storedRecipient, // Use the stored recipient address
            );
          }

          if (ready) {
            await db.updateRebalanceOperation(operation.id, {
              status: RebalanceOperationStatus.COMPLETED,
            });

            // Update earmark to READY now that Leg 2 is complete (funds arrived on TAC)
            // This is the correct timing per spec: PENDING → (Leg 2 complete) → READY
            if (operation.earmarkId) {
              await db.updateEarmarkStatus(operation.earmarkId, EarmarkStatus.READY);
              logger.info('Earmark marked READY - funds arrived on TAC', {
                ...logContext,
                earmarkId: operation.earmarkId,
              });
            }

            logger.info('TAC Inner Bridge transfer complete', {
              ...logContext,
              recipient: storedRecipient,
            });
          } else {
            logger.info('TAC Inner Bridge transfer not yet complete', {
              ...logContext,
              recipient: storedRecipient,
            });
          }
        } catch (e: unknown) {
          logger.error('Failed to check TAC Inner Bridge status', { ...logContext, error: jsonifyError(e) });
          continue;
        }
      }
    }
  }
};
