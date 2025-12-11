import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { getTickerForAsset, convertToNativeUnits, getMarkBalancesForTicker, getTonAssetAddress, getEvmBalance } from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import {
  getDecimalsFromConfig,
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
} from '@mark/core';
import { ProcessingContext } from '../init';
import { getActualAddress } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { MemoizedTransactionRequest, RebalanceTransactionMemo } from '@mark/rebalance';
import {
  createEarmark,
  createRebalanceOperation,
  Earmark,
  getActiveEarmarkForInvoice,
  getEarmarkById,
  getEarmarks,
  TransactionEntry,
  TransactionReceipt,
} from '@mark/database';
import { IntentStatus } from '@mark/everclear';

// USDT token addresses
// Reference: https://raw.githubusercontent.com/connext/chaindata/main/everclear.json
const USDT_ON_ETH_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';

// Minimum TON balance required for gas (0.5 TON in nanotons)
const MIN_TON_GAS_BALANCE = 500000000n;

// TODO: Change back to 100000000n (100 USDT) for production - temporarily set to 1 USDT for testing
const MIN_REBALANCE_AMOUNT = 1000000n; // 1 USDT in 6 decimals

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
}

interface ExecuteBridgeResult {
  receipt?: TransactionReceipt;
  effectiveBridgedAmount: string;
}

/**
 * Submits a sequence of bridge transactions and returns the final receipt and effective bridged amount.
 */
const executeBridgeTransactions = async ({
  context,
  route,
  bridgeType,
  bridgeTxRequests,
  amountToBridge,
}: ExecuteBridgeParams): Promise<ExecuteBridgeResult> => {
  const { logger, chainService, config, requestId } = context;

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
        from: config.ownAddress,
        funcSig: transaction.funcSig || '',
      },
      zodiacConfig: {
        walletType: WalletType.EOA,
      },
      context: { requestId, route, bridgeType, transactionType: memo },
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
}

/**
 * Main TAC USDT rebalancing function
 *
 * Workflow:
 * 1. Check for settled invoices destined for TAC with USDT output
 * 2. If USDT balance on TAC is insufficient, initiate rebalancing
 * 3. Leg 1: Bridge USDT from Ethereum to TON via Stargate
 * 4. Leg 2: Bridge USDT from TON to TAC via TAC Inner Bridge
 */
export async function rebalanceTacUsdt(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, chainService, rebalance, everclear } = context;
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

  logger.info('Starting TAC USDT rebalancing', { requestId });

    // 3. Evaluate Market Maker path  
  const mmActions = await evaluateMarketMakerRebalance(context);  
  actions.push(...mmActions);

  // 4. Evaluate Fill Service path  
  const fsActions = await evaluateFillServiceRebalance(context);  
  actions.push(...fsActions);  
  return actions;


  // Get USDT balances across all chains
  const balances = await getMarkBalancesForTicker(USDT_TICKER_HASH, config, chainService, context.prometheus);
  logger.debug('Retrieved USDT balances', { balances: jsonifyMap(balances) });

  if (!balances) {
    logger.warn('No USDT balances found, skipping', { requestId });
    return actions;
  }

  // Get intents destined for TAC
  // Note: outputAsset is NOT supported by the Everclear API - we use tickerHash instead
  // and filter by output_asset in the results if needed
  const intents = await everclear.fetchIntents({
    limit: 20,
    statuses: [IntentStatus.SETTLED_AND_COMPLETED],
    destinations: [TAC_CHAIN_ID],
    tickerHash: USDT_TICKER_HASH,
    isFastPath: true,
  });

  logger.info('Fetched TAC USDT intents', {
    requestId,
    intentCount: intents.length,
  });

  for (const intent of intents) {
    logger.info('Processing TAC USDT intent', { requestId, intent });

    // Validate intent
    if (!intent.hub_settlement_domain) {
      logger.warn('Intent does not have a hub settlement domain, skipping', { requestId, intent });
      continue;
    }

    if (intent.destinations.length !== 1 || intent.destinations[0] !== TAC_CHAIN_ID) {
      logger.warn('Intent does not have TAC as destination, skipping', { requestId, intent });
      continue;
    }

    // Check if earmark already exists
    const existingActive = await getActiveEarmarkForInvoice(intent.intent_id);
    if (existingActive) {
      logger.warn('Active earmark already exists for intent, skipping', {
        requestId,
        invoiceId: intent.intent_id,
        existingEarmarkId: existingActive.id,
      });
      continue;
    }

    const origin = Number(MAINNET_CHAIN_ID); // Always start from Ethereum mainnet
    const destination = Number(TAC_CHAIN_ID);
    const ticker = USDT_TICKER_HASH;
    const decimals = getDecimalsFromConfig(ticker, origin.toString(), config);

    // MIN_REBALANCE_AMOUNT is already in native units (6 decimals for USDT)
    // No conversion needed
    const minAmount = MIN_REBALANCE_AMOUNT;

    // intent.amount_out_min is already in native units (from the API/chain)
    // No conversion needed
    const intentAmount = BigInt(intent.amount_out_min);

    if (intentAmount < minAmount) {
      logger.warn('Intent amount is less than minimum, skipping', {
        requestId,
        intent,
        intentAmount: intentAmount.toString(),
        minAmount: minAmount.toString(),
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
        intentId: intent.intent_id,
        currentDestBalance: currentDestBalance.toString(),
        intentAmount: intentAmount.toString(),
        note: 'On-demand rebalancing only triggers when destination lacks funds',
      });
      continue;
    }

    if (currentOriginBalance <= minAmount) {
      logger.info('Origin balance is at or below minimum, skipping', {
        requestId,
        currentOriginBalance: currentOriginBalance.toString(),
        minAmount: minAmount.toString(),
      });
      continue;
    }

    // Calculate amount to bridge - only bridge what's needed
    // (intentAmount - currentDestBalance) = shortfall that needs to be filled
    const shortfall = intentAmount - currentDestBalance;

    // Don't bridge if shortfall is below minimum threshold
    if (shortfall < minAmount) {
      logger.info('Shortfall is below minimum rebalance threshold, skipping', {
        requestId,
        intentId: intent.intent_id,
        shortfall: shortfall.toString(),
        minAmount: minAmount.toString(),
      });
      continue;
    }

    const amountToBridge = currentOriginBalance < shortfall ? currentOriginBalance : shortfall;

    logger.info('On-demand rebalancing triggered - destination lacks funds', {
      requestId,
      intentId: intent.intent_id,
      intentAmount: intentAmount.toString(),
      currentDestBalance: currentDestBalance.toString(),
      shortfall: shortfall.toString(),
      amountToBridge: amountToBridge.toString(),
    });

    // Create earmark
    let earmark: Earmark;
    try {
      earmark = await createEarmark({
        invoiceId: intent.intent_id,
        designatedPurchaseChain: destination,
        tickerHash: ticker,
        minAmount: amountToBridge.toString(),
        status: EarmarkStatus.PENDING,
      });
    } catch (error: unknown) {
      logger.error('Failed to create earmark for TAC intent', {
        requestId,
        intent,
        error: jsonifyError(error),
      });
      throw error;
    }

    logger.info('Created earmark for TAC intent', {
      requestId,
      earmarkId: earmark.id,
      invoiceId: intent.intent_id,
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
    const tacRecipient = evmSender;

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

    const route = {
      asset: USDT_ON_ETH_ADDRESS,
      origin: origin,
      destination: Number(TON_LZ_CHAIN_ID), // First leg goes to TON
      maximum: amountToBridge.toString(),
      slippagesDbps: [500], // 0.5% slippage
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
      actions.push(rebalanceAction);

      rebalanceSuccessful = true;
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

  logger.info('Completed TAC USDT rebalancing cycle', { requestId });
  return actions;
}

const evaluateMarketMakerRebalance = async (
  context: ProcessingContext
): Promise<RebalanceAction[]> => {
  const { config, logger, requestId } = context;  
  const mmConfig = config.tacRebalance!.marketMaker;  
  const actions: RebalanceAction[] = [];  
  // A) On-demand: Invoice-triggered (existing logic, modified)  
  if (mmConfig.onDemandEnabled) {
    const invoiceActions = await processOnDemandRebalancing(context, mmConfig.address);    
    actions.push(...invoiceActions);  
  }
  // B) Threshold-based: Balance check  
  if (mmConfig.thresholdEnabled) {
    const thresholdActions = await processThresholdRebalancing(context, mmConfig.address, BigInt(mmConfig.threshold!), BigInt(mmConfig.targetBalance!));    
    actions.push(...thresholdActions);  
  }

  return actions;
}

const processOnDemandRebalancing = async (
  context: ProcessingContext,  
  recipientAddress: string): Promise<RebalanceAction[]> => {
  // Existing intent-fetching logic from current tacUsdt.ts  
  // Key change: use recipientAddress instead of config.ownAddress  
  // Create earmark linked to invoice  
  // Execute bridge with earmarkId
  return [];
}

const processThresholdRebalancing = async (
  context: ProcessingContext,
  recipientAddress: string,
  threshold: bigint,
  targetBalance: bigint,
): Promise<RebalanceAction[]> => {
  const { config, database: db, logger, requestId, prometheus } = context;
  const bridgeConfig = config.tacRebalance!.bridge;

  // 1. Get current USDT balance on TAC for this recipient
  const tacBalance = await getEvmBalance(config, TAC_CHAIN_ID.toString(), recipientAddress, USDT_TICKER_HASH, 6, prometheus);
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
  const pendingOps = await db.getRebalanceOperationByRecipient(Number(TAC_CHAIN_ID), recipientAddress, [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK]);
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
  const maxAmount = bridgeConfig.maxRebalanceAmount
    ? BigInt(bridgeConfig.maxRebalanceAmount)
    : shortfall;

  if (shortfall < minAmount) {
    logger.debug('Shortfall below minimum, skipping', {
      requestId,
      shortfall: shortfall.toString(),
    });
    return [];
  }

  // 4. Check origin (ETH) balance
  const ethUsdtBalance = await getEvmBalance(config, MAINNET_CHAIN_ID.toString(), config.ownAddress, USDT_TICKER_HASH, 6, prometheus);
  // const amountToBridge = min(shortfall, maxAmount, ethUsdtBalance);
  const amountToBridge = shortfall < maxAmount && shortfall < ethUsdtBalance
    ? shortfall
    : maxAmount < ethUsdtBalance
      ? maxAmount
      : ethUsdtBalance;

  if (amountToBridge < minAmount) {
    logger.warn('Insufficient origin balance for threshold rebalance', {
      requestId,
      ethBalance: ethUsdtBalance.toString(),
      needed: amountToBridge.toString(),
    });
    return [];
  }

  // 5. Execute bridge (no earmark for threshold-based)
  return executeTacBridge(context, recipientAddress, amountToBridge, null);
}

const executeTacBridge = async (
  context: ProcessingContext,
  recipientAddress: string, // Final TAC recipient
  amount: bigint,
  earmarkId: string | null, // null for threshold-based
): Promise<RebalanceAction[]> => {
  const { config, chainService, logger, requestId, rebalance, prometheus} = context;
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

  // Get addresses for the bridging flow
  // evmSender: The Ethereum address that holds USDT and will initiate the bridge
  const evmSender = getActualAddress(origin, config, logger, { requestId });

  // tonRecipient: TON wallet address that receives USDT on TON (intermediate step)
  const tonRecipient = config.ownTonAddress;

  // tacRecipient: Final EVM address on TAC that should receive USDT
  // CRITICAL: This MUST be the same as evmSender to satisfy the "same address" requirement
  // Both Ethereum and TAC are EVM chains, so the same address can receive on both
  const tacRecipient = evmSender;

  if(tacRecipient !== recipientAddress) {
    logger.error('Recipient Address is not same as config.ownAddress, cannot execute Stargate bridge', {
      requestId,
      evmSender,
      recipientAddress,
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

  logger.debug('Address flow for two-leg bridge', {
    requestId,
    evmSender,
    tonRecipient,
    tacRecipient,
  });

  const route = {
    asset: USDT_ON_ETH_ADDRESS,
    origin: origin,
    destination: Number(TON_LZ_CHAIN_ID), // First leg goes to TON
    maximum: amount.toString(),
    slippagesDbps: [500], // 0.5% slippage
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

    // Execute bridge transactions
    const { receipt, effectiveBridgedAmount } = await executeBridgeTransactions({
      context: { requestId, logger, chainService, config },
      route,
      bridgeType,
      bridgeTxRequests,
      amountToBridge: amount,
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
}

const evaluateFillServiceRebalance = async (
  context: ProcessingContext
): Promise<RebalanceAction[]> => {
  const { config } = context;  

  const fsConfig = config.tacRebalance!.fillService;  // FS only supports threshold-based rebalancing  
  if (!fsConfig.thresholdEnabled) {
    return [];  
  }

  return processThresholdRebalancing(context, fsConfig.address, BigInt(fsConfig.threshold), BigInt(fsConfig.targetBalance));
}

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
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.COMPLETED,
          });

          if (operation.earmarkId) {
            await db.updateEarmarkStatus(operation.earmarkId, EarmarkStatus.READY);
          }

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
