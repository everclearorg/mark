import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import {
  getTickerForAsset,
  getMarkBalancesForTicker,
  getTonAssetAddress,
  getEvmBalance,
  convertToNativeUnits,
} from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import {
  RebalanceOperationStatus,
  DBPS_MULTIPLIER,
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

// Minimum TON balance required for gas (0.5 TON in nanotons)
const MIN_TON_GAS_BALANCE = 500000000n;
/**
 * Query TON wallet USDT balance from TONCenter API
 * @param walletAddress - TON wallet address (user-friendly format)
 * @param jettonAddress - TON jetton master address (from config.ton.assets)
 * @param apiKey - TONCenter API key
 * @param rpcUrl - TONCenter API base URL (optional)
 * @returns USDT balance in micro-units (6 decimals), or 0 if query fails
 */
async function getTonUsdtBalance(
  walletAddress: string,
  jettonAddress: string,
  apiKey?: string,
  rpcUrl: string = 'https://toncenter.com',
): Promise<bigint> {
  try {
    const url = `${rpcUrl}/api/v3/jetton/wallets?owner_address=${walletAddress}&jetton_address=${jettonAddress}`;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return 0n;
    }

    const data = (await response.json()) as { jetton_wallets?: Array<{ balance: string }> };
    if (!data.jetton_wallets || data.jetton_wallets.length === 0) {
      return 0n;
    }

    return BigInt(data.jetton_wallets[0].balance);
  } catch {
    return 0n;
  }
}

/**
 * Query TON wallet native balance from TONCenter API
 * @param walletAddress - TON wallet address
 * @param apiKey - TONCenter API key
 * @param rpcUrl - TONCenter API base URL
 * @returns TON balance in nanotons, or 0 if query fails
 */
async function getTonNativeBalance(
  walletAddress: string,
  apiKey?: string,
  rpcUrl: string = 'https://toncenter.com',
): Promise<bigint> {
  try {
    const url = `${rpcUrl}/api/v2/getAddressInformation?address=${walletAddress}`;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return 0n;
    }

    const data = (await response.json()) as { result?: { balance: string } };
    if (!data.result?.balance) {
      return 0n;
    }

    return BigInt(data.result.balance);
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

  // Get initial ETH USDT balance (shared pool for both MM and FS)
  const initialEthUsdtBalance = await getEvmBalance(
    config,
    MAINNET_CHAIN_ID.toString(),
    config.ownAddress,
    USDT_TICKER_HASH,
    6,
    prometheus,
  );

  logger.info('Starting TAC USDT rebalancing', {
    requestId,
    initialEthUsdtBalance: initialEthUsdtBalance.toString(),
    mmConfig: {
      address: tacRebalanceConfig.marketMaker.address,
      onDemandEnabled: tacRebalanceConfig.marketMaker.onDemandEnabled,
      thresholdEnabled: tacRebalanceConfig.marketMaker.thresholdEnabled,
    },
    fsConfig: {
      address: tacRebalanceConfig.fillService.address,
      thresholdEnabled: tacRebalanceConfig.fillService.thresholdEnabled,
    },
  });

  // Track committed funds to prevent over-committing in this run
  const runState: RebalanceRunState = {
    committedEthUsdt: 0n,
  };

  // Calculate available balance for MM (no deductions yet)
  const mmAvailableBalance = initialEthUsdtBalance;

  // Evaluate Market Maker path first (invoice-triggered takes priority)
  const mmActions = await evaluateMarketMakerRebalance(context, mmAvailableBalance, runState);
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
  const fsActions = await evaluateFillServiceRebalance(context, fsAvailableBalance, runState);
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
): Promise<RebalanceAction[]> => {
  const { config, logger, requestId } = context;
  const mmConfig = config.tacRebalance!.marketMaker;
  const actions: RebalanceAction[] = [];

  // MM uses EITHER invoice-triggered OR threshold-based rebalancing, NOT BOTH
  // Priority: Invoice-triggered takes precedence (funds needed for specific intents)
  // Only fall back to threshold-based if no invoices require rebalancing

  // A) On-demand: Invoice-triggered (higher priority)
  if (mmConfig.onDemandEnabled) {
    const invoiceActions = await processOnDemandRebalancing(context, mmConfig.address, availableEthUsdt, runState);
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
    logger.debug('No invoice-triggered rebalancing needed, checking MM threshold', {
      requestId,
      threshold: mmConfig.threshold,
      targetBalance: mmConfig.targetBalance,
      availableEthUsdt: availableEthUsdt.toString(),
    });
    const thresholdActions = await processThresholdRebalancing(
      context,
      mmConfig.address,
      BigInt(mmConfig.threshold!),
      BigInt(mmConfig.targetBalance!),
      availableEthUsdt,
      runState,
    );
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

  // Get USDT balances across all chains
  const balances = await getMarkBalancesForTicker(USDT_TICKER_HASH, config, chainService, context.prometheus);
  logger.debug('Retrieved USDT balances', { balances: jsonifyMap(balances) });

  if (!balances) {
    logger.warn('No USDT balances found, skipping', { requestId });
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

    // intent.amount_out_min is already in native units (from the API/chain)
    // No conversion needed
    const intentAmount = BigInt(invoice.amount);
    const minRebalanceAmount = BigInt(config.tacRebalance!.bridge.minRebalanceAmount);

    if (intentAmount < minRebalanceAmount) {
      logger.warn('Invoice amount is less than minimum rebalance amount, skipping', {
        requestId,
        invoiceId: invoice.intent_id.toString(),
        invoiceAmount: invoice.amount,
        minRebalanceAmount: minRebalanceAmount.toString(),
      });
      continue;
    }

    // Balances from getMarkBalancesForTicker are in 18 decimals (standardized)
    // Convert to native units (6 decimals for USDT)
    const availableOriginBalance = balances.get(origin.toString()) || 0n;
    const currentOriginBalance = convertToNativeUnits(availableOriginBalance, decimals);

    // CRITICAL: Check if TAC (destination) already has sufficient balance
    // On-demand rebalancing should ONLY trigger when the destination lacks funds
    const availableDestBalance = balances.get(destination.toString()) || 0n;
    const currentDestBalance = convertToNativeUnits(availableDestBalance, decimals);

    logger.debug('Current USDT balances', {
      requestId,
      originBalance: currentOriginBalance.toString(),
      destinationBalance: currentDestBalance.toString(),
      intentAmount: intentAmount.toString(),
    });

    // If TAC already has enough to fulfill the intent, no rebalance needed
    if (currentDestBalance >= intentAmount) {
      logger.info('TAC already has sufficient balance for intent, skipping rebalance', {
        requestId,
        invoiceId: invoice.intent_id.toString(),
        currentDestBalance: currentDestBalance.toString(),
        intentAmount: intentAmount.toString(),
        note: 'On-demand rebalancing only triggers when destination lacks funds',
      });
      continue;
    }

    // Use remaining available balance (accounts for previously committed funds in this run)
    if (remainingEthUsdt <= minRebalanceAmount) {
      logger.info('Remaining ETH USDT is at or below minimum, skipping', {
        requestId,
        remainingEthUsdt: remainingEthUsdt.toString(),
        minRebalanceAmount: minRebalanceAmount.toString(),
        note: 'Some balance may be committed to other operations in this run',
      });
      continue;
    }

    // Calculate amount to bridge - only bridge what's needed
    // (intentAmount - currentDestBalance) = shortfall that needs to be filled
    const shortfall = intentAmount - currentDestBalance;

    // Don't bridge if shortfall is below minimum threshold
    if (shortfall < minRebalanceAmount) {
      logger.info('Shortfall is below minimum rebalance threshold, skipping', {
        requestId,
        invoiceId: invoice.intent_id.toString(),
        shortfall: shortfall.toString(),
        minRebalanceAmount: minRebalanceAmount.toString(),
      });
      continue;
    }

    // Use remaining available balance (not the on-chain balance, which doesn't account for this run's commits)
    const amountToBridge = remainingEthUsdt < shortfall ? remainingEthUsdt : shortfall;

    logger.info('On-demand rebalancing triggered - destination lacks funds', {
      requestId,
      invoiceId: invoice.intent_id.toString(),
      intentAmount: intentAmount.toString(),
      currentDestBalance: currentDestBalance.toString(),
      shortfall: shortfall.toString(),
      amountToBridge: amountToBridge.toString(),
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
    // CRITICAL: This MUST be the same as evmSender to satisfy the "same address" requirement
    // Both Ethereum and TAC are EVM chains, so the same address can receive on both
    // TODO confirm
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
      // Get quote
      const receivedAmountStr = await adapter.getReceivedAmount(amountToBridge.toString(), route);
      logger.info('Received Stargate quote', {
        requestId,
        route,
        amountToBridge: amountToBridge.toString(),
        receivedAmount: receivedAmountStr,
      });

      // Check slippage
      const receivedAmount = BigInt(receivedAmountStr);
      const slippageDbps = BigInt(route.slippagesDbps[0]);
      const minimumAcceptableAmount = amountToBridge - (amountToBridge * slippageDbps) / DBPS_MULTIPLIER;

      if (receivedAmount < minimumAcceptableAmount) {
        logger.warn('Stargate quote does not meet slippage requirements', {
          requestId,
          route,
          amountToBridge: amountToBridge.toString(),
          receivedAmount: receivedAmount.toString(),
          minimumAcceptableAmount: minimumAcceptableAmount.toString(),
        });
        continue;
      }

      // Get bridge transactions
      // Sender is EVM address, recipient is TON address (for Stargate to deliver to)
      const bridgeTxRequests = await adapter.send(evmSender, tonRecipient, amountToBridge.toString(), route);

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
      await createRebalanceOperation({
        earmarkId: earmark.id,
        originChainId: route.origin,
        destinationChainId: route.destination,
        tickerHash: getTickerForAsset(route.asset, route.origin, config) || route.asset,
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
      const bridgedAmount = BigInt(effectiveBridgedAmount);
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

const processThresholdRebalancing = async (
  context: ProcessingContext,
  recipientAddress: string,
  threshold: bigint,
  targetBalance: bigint,
  availableEthUsdt: bigint,
  runState: RebalanceRunState,
): Promise<RebalanceAction[]> => {
  const { config, database: db, logger, requestId, prometheus } = context;
  const bridgeConfig = config.tacRebalance!.bridge;

  // 1. Get current USDT balance on TAC for this recipient
  const tacBalance = await getEvmBalance(
    config,
    TAC_CHAIN_ID.toString(),
    recipientAddress,
    USDT_TICKER_HASH,
    6,
    prometheus,
  );
  if (tacBalance >= threshold) {
    logger.debug('TAC balance above threshold, skipping', {
      requestId,
      recipient: recipientAddress,
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
      recipient: recipientAddress,
      pendingOps: pendingOps.length,
    });
    return [];
  }

  // 3. Calculate amount needed
  const shortfall = targetBalance - tacBalance;
  const minAmount = BigInt(bridgeConfig.minRebalanceAmount);
  const maxAmount = bridgeConfig.maxRebalanceAmount ? BigInt(bridgeConfig.maxRebalanceAmount) : shortfall;

  if (shortfall < minAmount) {
    logger.debug('Shortfall below minimum, skipping', {
      requestId,
      shortfall: shortfall.toString(),
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
  // TODO: Get receipt from transaction submission
  // Get USDT balances across all chains
  const actions: RebalanceAction[] = [];

  const balances = await getMarkBalancesForTicker(USDT_TICKER_HASH, config, chainService, prometheus);
  logger.debug('Retrieved USDT balances', { balances: jsonifyMap(balances) });

  if (!balances) {
    logger.warn('No USDT balances found, skipping', { requestId });
    return [];
  }

  const origin = Number(MAINNET_CHAIN_ID); // Always start from Ethereum mainnet

  // --- Leg 1: Bridge USDT from Ethereum to TON via Stargate ---
  let rebalanceSuccessful = false;
  const bridgeType = SupportedBridge.Stargate;

  // Determine sender for the bridge based on recipient type
  // For Fill Service recipient: prefer filler as sender, fallback to MM
  // For Market Maker recipient: always use MM
  const isFillServiceRecipient =
    recipientAddress.toLowerCase() === config.tacRebalance?.fillService?.address?.toLowerCase();
  // Use senderAddress if explicitly set, otherwise default to address (same key = same address on ETH and TAC)
  const fillerSenderAddress =
    config.tacRebalance?.fillService?.senderAddress ?? config.tacRebalance?.fillService?.address;

  let evmSender: string;
  let senderConfig: TacSenderConfig | undefined;
  let selectedChainService = chainService;

  if (isFillServiceRecipient && fillerSenderAddress && fillServiceChainService) {
    // Check if filler has enough USDT on ETH to send
    // USDT has 6 decimals
    const fillerBalance = await getEvmBalance(
      config,
      MAINNET_CHAIN_ID.toString(),
      fillerSenderAddress,
      USDT_ON_ETH_ADDRESS,
      6, // USDT decimals
      prometheus,
    );

    logger.debug('Checking filler balance for FS rebalancing', {
      requestId,
      fillerAddress: fillerSenderAddress,
      fillerBalance: fillerBalance.toString(),
      requiredAmount: amount.toString(),
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
    // Get quote
    const receivedAmountStr = await adapter.getReceivedAmount(amount.toString(), route);
    logger.info('Received Stargate quote', {
      requestId,
      route,
      amountToBridge: amount.toString(),
      receivedAmount: receivedAmountStr,
    });

    // Check slippage
    const receivedAmount = BigInt(receivedAmountStr);
    const slippageDbps = BigInt(route.slippagesDbps[0]);
    const minimumAcceptableAmount = amount - (amount * slippageDbps) / DBPS_MULTIPLIER;

    if (receivedAmount < minimumAcceptableAmount) {
      logger.warn('Stargate quote does not meet slippage requirements', {
        requestId,
        route,
        amountToBridge: amount.toString(),
        receivedAmount: receivedAmount.toString(),
        minimumAcceptableAmount: minimumAcceptableAmount.toString(),
      });
      return [];
    }

    // Get bridge transactions
    // Sender is EVM address, recipient is TON address (for Stargate to deliver to)
    const bridgeTxRequests = await adapter.send(evmSender, tonRecipient, amount.toString(), route);

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
    await createRebalanceOperation({
      earmarkId: earmarkId,
      originChainId: route.origin,
      destinationChainId: route.destination,
      tickerHash: getTickerForAsset(route.asset, route.origin, config) || route.asset,
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

const evaluateFillServiceRebalance = async (
  context: ProcessingContext,
  availableEthUsdt: bigint,
  runState: RebalanceRunState,
): Promise<RebalanceAction[]> => {
  const { config, logger, requestId } = context;

  const fsConfig = config.tacRebalance!.fillService; // FS only supports threshold-based rebalancing
  if (!fsConfig.thresholdEnabled) {
    logger.debug('FS threshold rebalancing disabled', { requestId });
    return [];
  }

  logger.debug('Evaluating FS threshold rebalancing', {
    requestId,
    fsAddress: fsConfig.address,
    threshold: fsConfig.threshold,
    targetBalance: fsConfig.targetBalance,
    availableEthUsdt: availableEthUsdt.toString(),
  });

  return processThresholdRebalancing(
    context,
    fsConfig.address,
    BigInt(fsConfig.threshold),
    BigInt(fsConfig.targetBalance),
    availableEthUsdt,
    runState,
  );
};

/**
 * Execute callbacks for pending TAC rebalance operations
 *
 * This handles:
 * - Checking if Leg 1 (Stargate) is complete
 * - Executing Leg 2 (TAC Inner Bridge) when Leg 1 completes
 * - Checking if Leg 2 is complete
 */
const executeTacCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, config, rebalance, database: db } = context;
  logger.info('Executing TAC USDT rebalance callbacks', { requestId });

  // Get all pending TAC operations
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  // Filter for TAC-related operations
  const tacOperations = operations.filter(
    (op) => op.bridge === 'stargate-tac' || op.bridge === SupportedBridge.TacInner,
  );

  logger.debug('Found TAC rebalance operations', {
    count: tacOperations.length,
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

            // Get actual USDT balance (may be less than operation.amount due to Stargate fees)
            const actualUsdtBalance = await getTonUsdtBalance(tonWalletAddress, jettonAddress, tonApiKey);

            // Use the actual balance, not the expected amount
            // This accounts for Stargate bridge fees
            const amountToBridge = actualUsdtBalance > 0n ? actualUsdtBalance.toString() : operation.amount;

            logger.info('Executing TAC SDK bridge transaction', {
              ...logContext,
              recipient,
              originalAmount: operation.amount,
              actualUsdtBalance: actualUsdtBalance.toString(),
              amountToBridge,
              note:
                actualUsdtBalance.toString() !== operation.amount
                  ? 'Using actual balance (Stargate took fees)'
                  : 'Using original amount',
            });

            const transactionLinker = await tacInnerAdapter.executeTacBridge(tonMnemonic, recipient, amountToBridge);

            // Create Leg 2 operation record with transaction info
            // Link to the same earmark as Leg 1 for proper tracking
            // Use actual bridged amount (accounts for Stargate fees)
            await createRebalanceOperation({
              earmarkId: operation.earmarkId,
              originChainId: Number(TON_LZ_CHAIN_ID),
              destinationChainId: Number(TAC_CHAIN_ID),
              tickerHash: operation.tickerHash,
              amount: amountToBridge, // Use actual amount, not original
              slippage: 100,
              status: RebalanceOperationStatus.PENDING,
              bridge: SupportedBridge.TacInner,
              recipient: recipient,
              // Note: TAC SDK transactionLinker is stored in recipient field as JSON for later tracking
              // Format: recipient|JSON(transactionLinker)
              transactions: undefined,
            });

            logger.info('TAC SDK bridge transaction submitted', {
              ...logContext,
              transactionLinker,
            });
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

      if (operation.status === RebalanceOperationStatus.PENDING) {
        try {
          // Check if we have a transaction linker from TAC SDK
          const tonTxData = operation.transactions?.[TON_LZ_CHAIN_ID] as { transactionLinker?: unknown } | undefined;
          let transactionLinker = tonTxData?.transactionLinker;

          // Get the stored recipient from operation
          const storedRecipient = operation.recipient;

          // If no transactionLinker, the bridge was never executed - try to execute it now
          if (!transactionLinker && storedRecipient) {
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
              const actualUsdtBalance = await getTonUsdtBalance(tonWalletAddress, jettonAddress, tonApiKey);

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

                const amountToBridge = actualUsdtBalance.toString();

                logger.info('Retrying TAC SDK bridge execution (no transactionLinker)', {
                  ...logContext,
                  recipient: storedRecipient,
                  actualUsdtBalance: amountToBridge,
                });

                try {
                  transactionLinker = await tacInnerAdapter.executeTacBridge(
                    tonMnemonic,
                    storedRecipient,
                    amountToBridge,
                  );

                  // Log success - transaction linker tracking done via TAC SDK
                  if (transactionLinker) {
                    logger.info('TAC SDK bridge executed successfully', {
                      ...logContext,
                      transactionLinker,
                      note: 'Bridge submitted, will verify completion on next cycle',
                    });
                    // Don't mark as complete yet - let it be verified on next cycle
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
