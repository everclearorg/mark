/**
 * Shared EVM bridge execution helpers.
 *
 * Two-level API:
 *   Level 1 — submitBridgeTransactions: tx submission loop only
 *   Level 2 — executeEvmBridge: full quote → slippage → send → submit → DB record
 */

import { jsonifyError } from '@mark/logger';
import { RebalanceOperationStatus, RebalanceAction, SupportedBridge, WalletType, WalletConfig } from '@mark/core';
import { ProcessingContext } from '../init';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { MemoizedTransactionRequest, RebalanceTransactionMemo, BridgeAdapter } from '@mark/rebalance';
import { createRebalanceOperation, TransactionReceipt } from '@mark/database';
import { ChainService } from '@mark/chainservice';
import { SenderConfig } from './types';

// ---------------------------------------------------------------------------
// Level 1: submitBridgeTransactions — tx submission loop
// ---------------------------------------------------------------------------

export interface SubmitBridgeTxsParams {
  context: Pick<ProcessingContext, 'logger' | 'config' | 'requestId' | 'inventory'>;
  chainService: ChainService;
  route: { origin: number; destination: number; asset: string };
  bridgeType: SupportedBridge;
  bridgeTxRequests: MemoizedTransactionRequest[];
  amountToBridge: bigint;
  senderOverride?: SenderConfig;
  zodiacConfig?: WalletConfig;
}

export interface SubmitBridgeTxsResult {
  receipt?: TransactionReceipt;
  effectiveBridgedAmount: string;
}

/**
 * Loops through bridge transaction requests, submits each via `submitTransactionWithLogging`,
 * captures the receipt from the `Rebalance` memo tx, and tracks the effective amount.
 */
export const submitBridgeTransactions = async ({
  context,
  chainService,
  route,
  bridgeType,
  bridgeTxRequests,
  amountToBridge,
  senderOverride,
  zodiacConfig = { walletType: WalletType.EOA },
}: SubmitBridgeTxsParams): Promise<SubmitBridgeTxsResult> => {
  const { logger, config, requestId } = context;

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
      zodiacConfig,
      context: { requestId, route, bridgeType, transactionType: memo, sender: senderLabel },
      inventory: context.inventory,
      walletAddress: senderAddress,
      operationId: `rebalance-${bridgeType}-${route.origin}-${route.destination}`,
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

// ---------------------------------------------------------------------------
// Level 2: executeEvmBridge — full 5-step pattern
// ---------------------------------------------------------------------------

export interface ExecuteEvmBridgeParams {
  context: ProcessingContext;
  adapter: BridgeAdapter;
  route: {
    origin: number;
    destination: number;
    asset: string;
    maximum?: string;
    slippagesDbps?: number[];
    preferences?: SupportedBridge[];
    reserve?: string;
  };
  amount: bigint; // in adapter-expected units (caller converts)
  dbAmount?: bigint; // if set, overrides `amount` for DB record + action tracking (e.g. 18-decimal when amount is native-unit)
  sender: string;
  recipient: string; // used for adapter.send() and DB record
  dbRecipient?: string; // if set, overrides `recipient` in DB record only
  slippageTolerance: bigint;
  slippageMultiplier: bigint;
  chainService: ChainService;
  senderConfig?: SenderConfig;
  zodiacConfig?: WalletConfig;
  dbRecord: {
    earmarkId: string | null;
    tickerHash: string;
    bridgeTag: string;
    status: RebalanceOperationStatus;
  };
  label: string;
}

export interface ExecuteEvmBridgeResult {
  actions: RebalanceAction[];
  receipt?: TransactionReceipt;
  effectiveBridgedAmount: string;
}

/**
 * Full 5-step EVM bridge execution:
 *   1. Get quote from adapter
 *   2. Check slippage tolerance
 *   3. Get bridge transaction requests via adapter.send()
 *   4. Submit transactions via submitBridgeTransactions()
 *   5. Create DB rebalance operation record
 *
 * Returns empty `actions` on quote failure or slippage violation (no throw).
 * Throws on tx submission failure (caller catches).
 */
export const executeEvmBridge = async ({
  context,
  adapter,
  route,
  amount,
  dbAmount,
  sender,
  recipient,
  dbRecipient,
  slippageTolerance,
  slippageMultiplier,
  chainService,
  senderConfig,
  zodiacConfig,
  dbRecord,
  label,
}: ExecuteEvmBridgeParams): Promise<ExecuteEvmBridgeResult> => {
  const { logger, requestId } = context;
  const bridgeType = adapter.type();
  const effectiveDbRecipient = dbRecipient ?? recipient;
  // When adapter amount units differ from DB/tracking units (e.g. 6-decimal native vs 18-decimal normalized),
  // callers pass dbAmount to preserve the original tracking unit.
  const trackingAmount = dbAmount ?? amount;
  const empty: ExecuteEvmBridgeResult = { actions: [], effectiveBridgedAmount: '0' };

  // Step 1: Get quote
  let receivedAmountStr: string;
  try {
    receivedAmountStr = await adapter.getReceivedAmount(amount.toString(), route);
    logger.info(`Received ${label} quote`, {
      requestId,
      bridgeType,
      amountToBridge: amount.toString(),
      receivedAmount: receivedAmountStr,
    });
  } catch (quoteError) {
    logger.error(`Failed to get ${label} quote`, {
      requestId,
      bridgeType,
      amountToBridge: amount.toString(),
      error: jsonifyError(quoteError),
    });
    return empty;
  }

  // Step 2: Check slippage
  const receivedAmount = BigInt(receivedAmountStr);
  const minimumAcceptableAmount = amount - (amount * slippageTolerance) / slippageMultiplier;

  if (receivedAmount < minimumAcceptableAmount) {
    logger.warn(`${label} quote does not meet slippage requirements`, {
      requestId,
      bridgeType,
      amountToBridge: amount.toString(),
      receivedAmount: receivedAmount.toString(),
      minimumAcceptableAmount: minimumAcceptableAmount.toString(),
      slippageTolerance: slippageTolerance.toString(),
    });
    return empty;
  }

  // Step 3: Get bridge transaction requests
  let bridgeTxRequests: MemoizedTransactionRequest[];
  try {
    bridgeTxRequests = await adapter.send(sender, recipient, amount.toString(), route);
    if (!bridgeTxRequests.length) {
      logger.error(`No bridge transactions returned from ${label} adapter`, { requestId });
      return empty;
    }
    logger.info(`Prepared ${label} bridge transactions`, {
      requestId,
      transactionCount: bridgeTxRequests.length,
    });
  } catch (sendError) {
    logger.error(`Failed to get ${label} bridge transactions`, {
      requestId,
      bridgeType,
      error: jsonifyError(sendError),
    });
    return empty;
  }

  // Step 4: Submit bridge transactions
  // Use trackingAmount (18-decimal normalized) as default for effectiveBridgedAmount,
  // not the adapter-unit amount, so DB records and committed-funds tracking stay consistent.
  const { receipt, effectiveBridgedAmount } = await submitBridgeTransactions({
    context,
    chainService,
    route,
    bridgeType,
    bridgeTxRequests,
    amountToBridge: trackingAmount,
    senderOverride: senderConfig,
    zodiacConfig,
  });

  // Step 5: Create database record
  await createRebalanceOperation({
    earmarkId: dbRecord.earmarkId,
    originChainId: route.origin,
    destinationChainId: route.destination,
    tickerHash: dbRecord.tickerHash,
    amount: effectiveBridgedAmount,
    slippage: Number(slippageTolerance),
    status: dbRecord.status,
    bridge: dbRecord.bridgeTag,
    transactions: receipt ? { [route.origin]: receipt } : undefined,
    recipient: effectiveDbRecipient,
  });

  logger.info(`Successfully created ${label} rebalance operation`, {
    requestId,
    originTxHash: receipt?.transactionHash,
    amountToBridge: effectiveBridgedAmount,
    bridge: dbRecord.bridgeTag,
  });

  const actions: RebalanceAction[] = [
    {
      bridge: bridgeType,
      amount: trackingAmount.toString(),
      origin: route.origin,
      destination: route.destination,
      asset: route.asset,
      transaction: receipt?.transactionHash || '',
      recipient: effectiveDbRecipient,
    },
  ];

  return { actions, receipt, effectiveBridgedAmount };
};
