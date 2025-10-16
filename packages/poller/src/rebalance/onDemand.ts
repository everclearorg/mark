import { ProcessingContext } from '../init';
import { Invoice, EarmarkStatus, RebalanceOperationStatus, SupportedBridge, DBPS_MULTIPLIER } from '@mark/core';
import { OnDemandRouteConfig } from '@mark/core';
import * as database from '@mark/database';
import type { earmarks, Earmark } from '@mark/database';
import { getMarkBalances, convertToNativeUnits, convertTo18Decimals, getTickerForAsset } from '../helpers';
import { getDecimalsFromConfig } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import { RebalanceTransactionMemo } from '@mark/rebalance';
import { getValidatedZodiacConfig, getActualAddress } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';

interface OnDemandRebalanceResult {
  canRebalance: boolean;
  destinationChain?: number;
  rebalanceOperations?: {
    originChain: number;
    amount: string;
    bridge: SupportedBridge;
    slippage: number;
  }[];
  totalAmount?: string;
  minAmount?: string;
}

interface EarmarkedFunds {
  chainId: number;
  tickerHash: string;
  amount: bigint;
}

export async function evaluateOnDemandRebalancing(
  invoice: Invoice,
  minAmounts: Record<string, string>,
  context: ProcessingContext,
): Promise<OnDemandRebalanceResult> {
  const { logger, requestId, config } = context;

  logger.info('Evaluating on-demand rebalancing for invoice', {
    requestId,
    invoiceId: invoice.intent_id,
    amount: invoice.amount,
    destinations: invoice.destinations,
    minAmounts,
  });

  // Get on-demand routes from config
  const onDemandRoutes = config.onDemandRoutes || [];
  if (onDemandRoutes.length === 0) {
    logger.info('No on-demand routes configured', {
      requestId,
      invoiceId: invoice.intent_id,
    });
    return { canRebalance: false };
  }

  const balances = await getMarkBalances(config, context.chainService, context.prometheus);

  // Get active earmarks to exclude from available balance
  const activeEarmarks = await database.getEarmarks({ status: [EarmarkStatus.PENDING, EarmarkStatus.READY] });
  const earmarkedFunds = calculateEarmarkedFunds(activeEarmarks);

  // For each potential destination chain, evaluate if we can aggregate enough funds
  const evaluationResults: Map<number, OnDemandRebalanceResult & { minAmount: string }> = new Map();

  for (const destinationStr of invoice.destinations) {
    const destination = parseInt(destinationStr);

    // Skip if no minAmount for this destination
    if (!minAmounts[destinationStr]) {
      logger.debug('No minAmount for destination, skipping', {
        requestId,
        invoiceId: invoice.intent_id,
        destination,
      });
      continue;
    }

    const result = await evaluateDestinationChain(
      invoice,
      destination,
      minAmounts[destinationStr],
      onDemandRoutes,
      balances,
      earmarkedFunds,
      context,
    );

    if (result.canRebalance) {
      evaluationResults.set(destination, { ...result, minAmount: minAmounts[destinationStr] });
    }
  }

  // Select the best destination
  const bestDestination = selectBestDestination(evaluationResults);

  if (!bestDestination) {
    logger.info('No viable destination found for on-demand rebalancing', {
      requestId,
      invoiceId: invoice.intent_id,
      evaluatedDestinations: evaluationResults.size,
    });
    return { canRebalance: false };
  }

  return bestDestination;
}

async function evaluateDestinationChain(
  invoice: Invoice,
  destination: number,
  minAmount: string,
  routes: OnDemandRouteConfig[],
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  context: ProcessingContext,
): Promise<OnDemandRebalanceResult> {
  const { logger, config } = context;

  // Find routes that can send to this destination
  const applicableRoutes = routes.filter((route) => {
    if (route.destination !== destination) return false;
    const routeTickerHash = getTickerForAsset(route.asset, route.origin, config);
    return routeTickerHash && routeTickerHash.toLowerCase() === invoice.ticker_hash.toLowerCase();
  });

  if (applicableRoutes.length === 0) {
    return { canRebalance: false };
  }

  const ticker = invoice.ticker_hash.toLowerCase();

  // minAmount from API is already in standardized 18 decimals
  const requiredAmount = BigInt(minAmount);

  if (!requiredAmount) {
    logger.error('Invalid minAmount', { minAmount, destination });
    return { canRebalance: false };
  }

  // Check current balance on destination (already in 18 decimals from getMarkBalances)
  const destinationBalance = balances.get(ticker)?.get(destination.toString()) || 0n;
  const earmarkedOnDestination = earmarkedFunds
    .filter((e) => e.chainId === destination && e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + e.amount, 0n);

  // Calculate available balance, ensuring it doesn't go negative
  const availableOnDestination =
    destinationBalance > earmarkedOnDestination ? destinationBalance - earmarkedOnDestination : 0n;

  // Calculate the amount needed to fulfill the invoice (both values now in 18 decimals)
  const amountNeeded = requiredAmount > availableOnDestination ? requiredAmount - availableOnDestination : 0n;

  // If destination already has enough, no need to rebalance
  if (amountNeeded <= 0n) {
    return { canRebalance: false };
  }

  // Calculate rebalancing operations
  const { operations, canFulfill, totalAchievable } = await calculateRebalancingOperations(
    amountNeeded,
    applicableRoutes,
    balances,
    earmarkedFunds,
    invoice.ticker_hash,
    context,
  );

  // Check if we can fulfill the invoice after all rebalancing
  if (canFulfill) {
    logger.debug('Can fulfill invoice for destination', {
      destination,
      requiredAmount: requiredAmount.toString(),
      operations: operations.length,
      totalAchievable: totalAchievable.toString(),
    });
    return {
      canRebalance: true,
      destinationChain: destination,
      rebalanceOperations: operations,
      totalAmount: requiredAmount.toString(),
    };
  }

  logger.debug('Cannot fulfill invoice for destination', {
    destination,
    requiredAmount: requiredAmount.toString(),
    destinationBalance: destinationBalance.toString(),
    earmarkedOnDestination: earmarkedOnDestination.toString(),
    availableOnDestination: availableOnDestination.toString(),
    amountNeeded: amountNeeded.toString(),
    operations: operations.length,
    totalAchievable: totalAchievable.toString(),
  });
  return { canRebalance: false };
}

function getAvailableBalance(
  chainId: number,
  tickerHash: string,
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  reserve: string,
): bigint {
  const ticker = tickerHash.toLowerCase();
  const balance = balances.get(ticker)?.get(chainId.toString()) || 0n;

  // Subtract earmarked funds
  const earmarked = earmarkedFunds
    .filter((e) => e.chainId === chainId && e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + e.amount, 0n);

  // Subtract reserve amount (already in standardized 18 decimals)
  const reserveAmount = BigInt(reserve);

  const available = balance - earmarked - reserveAmount;
  return available > 0n ? available : 0n;
}

function calculateEarmarkedFunds(earmarks: database.CamelCasedProperties<earmarks>[]): EarmarkedFunds[] {
  const fundsMap = new Map<string, EarmarkedFunds>();

  for (const earmark of earmarks) {
    const key = `${earmark.designatedPurchaseChain}-${earmark.tickerHash}`;

    // earmark.minAmount is already stored in standardized 18 decimals from the API
    const amount = BigInt(earmark.minAmount) || 0n;

    const existing = fundsMap.get(key);
    if (existing) {
      existing.amount += amount;
    } else {
      fundsMap.set(key, {
        chainId: earmark.designatedPurchaseChain,
        tickerHash: earmark.tickerHash,
        amount,
      });
    }
  }

  return Array.from(fundsMap.values());
}

/**
 * Calculates rebalancing operations needed to achieve a target amount
 * @param amountNeeded - Amount needed in standardized 18 decimals
 * @param routes - Available routes for rebalancing
 * @param balances - Current balances across chains
 * @param earmarkedFunds - Funds already earmarked for other operations
 * @param tickerHash - Asset ticker hash
 * @param context - Processing context with access to adapters
 * @returns Array of rebalancing operations and total amount that can be achieved
 */
async function calculateRebalancingOperations(
  amountNeeded: bigint,
  routes: OnDemandRouteConfig[],
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  tickerHash: string,
  context: ProcessingContext,
): Promise<{
  operations: { originChain: number; amount: string; bridge: SupportedBridge; slippage: number }[];
  totalAchievable: bigint;
  canFulfill: boolean;
}> {
  const { logger, rebalance, config } = context;
  const ticker = tickerHash.toLowerCase();
  const operations: { originChain: number; amount: string; bridge: SupportedBridge; slippage: number }[] = [];
  let remainingNeeded = amountNeeded;
  let totalAchievable = 0n;

  // Sort routes by available balance (descending) to minimize number of operations
  const sortedRoutes = routes.sort((a, b) => {
    const balanceA = getAvailableBalance(a.origin, ticker, balances, earmarkedFunds, a.reserve || '0');
    const balanceB = getAvailableBalance(b.origin, ticker, balances, earmarkedFunds, b.reserve || '0');
    return balanceB > balanceA ? 1 : -1;
  });

  for (const route of sortedRoutes) {
    if (remainingNeeded <= 0n) break;

    const availableOnOrigin = getAvailableBalance(route.origin, ticker, balances, earmarkedFunds, route.reserve || '0');

    if (availableOnOrigin <= 0n) continue;

    // Try each bridge preference to find one that works
    let operationAdded = false;

    for (let bridgeIndex = 0; bridgeIndex < route.preferences.length; bridgeIndex++) {
      const bridgeType = route.preferences[bridgeIndex];
      const adapter = rebalance.getAdapter(bridgeType);

      if (!adapter) {
        logger.debug('Adapter not found for bridge type during planning', {
          bridgeType,
          route,
        });
        continue;
      }

      try {
        // Calculate how much to send - we need to account for slippage
        // so that we receive at least remainingNeeded after slippage
        // If we need X and slippage is S%, we need to send X / (1 - S/100000)
        const maxSlippageDbps = route.slippagesDbps?.[bridgeIndex] ?? 1000; // Default 1% = 1000 DBPS
        const slippageDivisor = DBPS_MULTIPLIER - BigInt(maxSlippageDbps);
        const estimatedAmountToSend = (remainingNeeded * DBPS_MULTIPLIER) / slippageDivisor;

        // Use the minimum of our estimate and what's available
        const amountToTry = estimatedAmountToSend < availableOnOrigin ? estimatedAmountToSend : availableOnOrigin;

        // Convert from 18 decimals to native decimals for the quote
        const originDecimals = getDecimalsFromConfig(ticker, route.origin.toString(), config);
        const destDecimals = getDecimalsFromConfig(ticker, route.destination.toString(), config);
        const nativeAmountBigInt = convertToNativeUnits(amountToTry, originDecimals);
        const nativeAmount = nativeAmountBigInt.toString();

        // Get quote from adapter
        const receivedAmountStr = await adapter.getReceivedAmount(nativeAmount, route);

        // Check if quote meets slippage requirements
        const sentIn18Decimals = convertTo18Decimals(nativeAmountBigInt, originDecimals);
        const receivedIn18Decimals = convertTo18Decimals(BigInt(receivedAmountStr), destDecimals);
        const slippageDbps = ((sentIn18Decimals - receivedIn18Decimals) * DBPS_MULTIPLIER) / sentIn18Decimals;

        logger.debug('Quote evaluation during planning', {
          bridgeType,
          bridgeIndex,
          sentAmount: nativeAmount,
          receivedAmount: receivedAmountStr,
          sentIn18Decimals: sentIn18Decimals.toString(),
          receivedIn18Decimals: receivedIn18Decimals.toString(),
          slippageDbps: slippageDbps.toString(),
          maxSlippageDbps: maxSlippageDbps,
          passesSlippage: slippageDbps <= BigInt(maxSlippageDbps),
        });

        if (slippageDbps > BigInt(maxSlippageDbps)) {
          continue;
        }

        // Quote is acceptable, add this operation
        operations.push({
          originChain: route.origin,
          amount: nativeAmount,
          bridge: bridgeType,
          slippage: maxSlippageDbps,
        });

        // Update remaining needed and total achievable
        remainingNeeded -= receivedIn18Decimals;
        totalAchievable += receivedIn18Decimals;
        operationAdded = true;
        break; // Found a working bridge for this route
      } catch (error) {
        // Check if it's an Axios error and extract useful information
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const isAxiosError = errorMessage.includes('AxiosError') || errorMessage.includes('status code');

        if (isAxiosError) {
          // Extract status code if available
          const statusMatch = errorMessage.match(/status code (\d+)/);
          const statusCode = statusMatch ? statusMatch[1] : 'unknown';

          logger.debug('Bridge API request failed', {
            bridgeType,
            origin: route.origin,
            destination: route.destination,
            statusCode,
            errorType: 'API_ERROR',
            message: `Failed to get quote from ${bridgeType} bridge (HTTP ${statusCode})`,
          });
        } else {
          logger.debug('Failed to get quote during planning', {
            bridgeType,
            route,
            error: jsonifyError(error),
          });
        }
        continue;
      }
    }

    if (!operationAdded) {
      logger.debug('No viable bridge found for route during planning', {
        route,
        availableBalance: availableOnOrigin.toString(),
      });
    }
  }

  // Allow for tiny rounding errors (1 unit in native decimals)
  // This is 0.000001 USDC for 6-decimal tokens, 0.00000001 for 8-decimal tokens
  const roundingTolerance = BigInt(10 ** 12); // 1 unit in 6 decimals = 1e12 in 18 decimals
  const canFulfill = remainingNeeded <= roundingTolerance;

  logger.debug('calculateRebalancingOperations result', {
    operations: operations.length,
    totalAchievable: totalAchievable.toString(),
    remainingNeeded: remainingNeeded.toString(),
    canFulfill,
  });

  return {
    operations,
    totalAchievable,
    canFulfill,
  };
}

function selectBestDestination(
  evaluationResults: Map<number, OnDemandRebalanceResult & { minAmount: string }>,
): OnDemandRebalanceResult | null {
  if (evaluationResults.size === 0) return null;

  // Primary criteria: minimize number of rebalancing operations
  // Secondary criteria: minimize total amount to rebalance
  let bestResult: OnDemandRebalanceResult | null = null;
  let minOperations = Infinity;
  let minAmount = BigInt(Number.MAX_SAFE_INTEGER);

  for (const [, result] of evaluationResults) {
    const numOps = result.rebalanceOperations?.length || 0;
    const totalAmount =
      result.rebalanceOperations?.reduce((sum, op) => {
        return sum + (BigInt(op.amount) || 0n);
      }, 0n) || 0n;

    if (numOps < minOperations || (numOps === minOperations && totalAmount < minAmount)) {
      bestResult = result;
      minOperations = numOps;
      minAmount = totalAmount;
    }
  }

  return bestResult;
}

export async function executeOnDemandRebalancing(
  invoice: Invoice,
  evaluationResult: OnDemandRebalanceResult,
  context: ProcessingContext,
): Promise<string | null> {
  const { logger, requestId, config } = context;

  if (!evaluationResult.canRebalance) {
    return null;
  }

  const { destinationChain, rebalanceOperations, minAmount } = evaluationResult;

  // Check if an active earmark already exists for this invoice before executing operations
  const existingActive = await database.getActiveEarmarkForInvoice(invoice.intent_id);

  if (existingActive) {
    logger.warn('Active earmark already exists for invoice, skipping rebalance operations', {
      requestId,
      invoiceId: invoice.intent_id,
      existingEarmarkId: existingActive.id,
      existingStatus: existingActive.status,
    });
    return existingActive.status === EarmarkStatus.PENDING ? existingActive.id : null;
  }

  // Track successful operations to create database records later
  const successfulOperations: Array<{
    originChainId: number;
    amount: string;
    slippage: number;
    bridge: string;
    receipt: database.TransactionReceipt;
    recipient: string;
  }> = [];

  try {
    // Execute all rebalancing operations first
    for (const operation of rebalanceOperations!) {
      try {
        // Find the appropriate route config
        const route = (config.onDemandRoutes || []).find((r) => {
          if (r.origin !== operation.originChain || r.destination !== destinationChain) return false;
          const routeTickerHash = getTickerForAsset(r.asset, r.origin, config);
          return routeTickerHash && routeTickerHash.toLowerCase() === invoice.ticker_hash.toLowerCase();
        });

        if (!route) {
          logger.error('Route not found for rebalancing operation', { operation });
          continue;
        }

        // Get recipient address (could be different for Zodiac setup)
        const recipient = getActualAddress(destinationChain!, config, logger, { requestId });

        // Execute the rebalancing with the pre-determined bridge
        const result = await executeRebalanceTransactionWithBridge(
          route,
          operation.amount,
          recipient,
          operation.bridge,
          context,
        );

        if (result) {
          logger.info('On-demand rebalance transaction confirmed', {
            requestId,
            transactionHash: result.receipt.transactionHash,
            bridgeType: operation.bridge,
            originChain: operation.originChain,
            amount: result.effectiveAmount || operation.amount,
            originalAmount:
              result.effectiveAmount && result.effectiveAmount !== operation.amount ? operation.amount : undefined,
          });

          // Track successful operation for later database insertion
          successfulOperations.push({
            originChainId: operation.originChain,
            amount: result.effectiveAmount || operation.amount, // Use effective amount if adjusted
            slippage: operation.slippage,
            bridge: operation.bridge,
            receipt: result.receipt,
            recipient,
          });
        } else {
          logger.warn('Failed to execute rebalancing operation, no transaction returned', {
            requestId,
            operation,
          });
        }
      } catch (error) {
        logger.error('Failed to execute rebalancing operation', {
          requestId,
          operation,
          error: jsonifyError(error),
        });
      }
    }

    // Check if we have any successful operations
    if (successfulOperations.length === 0) {
      logger.error('No rebalancing operations succeeded, not creating earmark', {
        requestId,
        invoiceId: invoice.intent_id,
        totalOperations: rebalanceOperations!.length,
      });
      return null;
    }

    const allSucceeded = successfulOperations.length === rebalanceOperations!.length;
    if (allSucceeded) {
      logger.info('All rebalancing operations succeeded, creating earmark', {
        requestId,
        invoiceId: invoice.intent_id,
        successfulOperations: successfulOperations.length,
        totalOperations: rebalanceOperations!.length,
      });
    } else {
      logger.warn('Partial failure in rebalancing, creating FAILED earmark', {
        requestId,
        invoiceId: invoice.intent_id,
        successfulOperations: successfulOperations.length,
        totalOperations: rebalanceOperations!.length,
      });
    }

    // Create earmark with appropriate status
    let earmark: Earmark;
    try {
      earmark = await database.createEarmark({
        invoiceId: invoice.intent_id,
        designatedPurchaseChain: destinationChain!,
        tickerHash: invoice.ticker_hash,
        minAmount: minAmount!,
        status: allSucceeded ? EarmarkStatus.PENDING : EarmarkStatus.FAILED,
      });
    } catch (error: unknown) {
      // PostgreSQL unique constraint violation error code
      const dbError = error as { code?: string; constraint?: string };
      if (dbError.code === '23505' && dbError.constraint === 'unique_active_earmark_per_invoice') {
        logger.warn('Race condition: Active earmark created by another process', {
          requestId,
          invoiceId: invoice.intent_id,
        });
        const existing = await database.getActiveEarmarkForInvoice(invoice.intent_id);
        return existing?.status === EarmarkStatus.PENDING ? existing.id : null;
      }
      throw error;
    }

    logger.info('Created earmark for invoice', {
      requestId,
      earmarkId: earmark.id,
      invoiceId: invoice.intent_id,
      status: earmark.status,
    });

    // Create rebalance operation records for all successful operations
    for (const op of successfulOperations) {
      try {
        await database.createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: op.originChainId,
          destinationChainId: destinationChain!,
          tickerHash: invoice.ticker_hash,
          amount: op.amount,
          slippage: op.slippage,
          status: RebalanceOperationStatus.PENDING,
          bridge: op.bridge,
          transactions: { [op.originChainId]: op.receipt },
          recipient: op.recipient,
        });

        logger.info('Created rebalance operation record', {
          requestId,
          earmarkId: earmark.id,
          originChain: op.originChainId,
          txHash: op.receipt.transactionHash,
          bridge: op.bridge,
        });
      } catch (error) {
        // This is a critical error - we have a transaction on-chain but failed to record it
        logger.error('CRITICAL: Failed to create rebalance operation record for confirmed transaction', {
          requestId,
          earmarkId: earmark.id,
          operation: op,
          error: jsonifyError(error),
        });
      }
    }

    // Only return earmark ID if status is PENDING (successful)
    // FAILED earmarks should not be processed further
    return earmark.status === EarmarkStatus.PENDING ? earmark.id : null;
  } catch (error) {
    logger.error('Failed to execute on-demand rebalancing', {
      requestId,
      invoiceId: invoice.intent_id,
      error: jsonifyError(error),
      successfulOperations: successfulOperations.length,
    });
    return null;
  }
}

/**
 * Helper function to get minAmounts for an invoice with error handling
 */
async function getMinAmountsForInvoice(
  invoiceId: string,
  context: ProcessingContext,
): Promise<Record<string, string> | null> {
  const { logger, requestId, everclear } = context;

  try {
    const response = await everclear.getMinAmounts(invoiceId);
    return response.minAmounts;
  } catch (error) {
    logger.error('Failed to get minAmounts for earmarked invoice', {
      requestId,
      invoiceId,
      error: jsonifyError(error),
    });
    return null;
  }
}

/**
 * Check if all rebalance operations for an earmark are complete
 */
async function checkAllOperationsComplete(earmarkId: string): Promise<boolean> {
  const operations = await database.getRebalanceOperationsByEarmark(earmarkId);
  return operations.length > 0 && operations.every((op) => op.status === RebalanceOperationStatus.COMPLETED);
}

/**
 * Handle the case when minAmount has increased for an earmarked invoice
 */
async function handleMinAmountIncrease(
  earmark: database.CamelCasedProperties<earmarks>,
  invoice: Invoice,
  currentMinAmount: string,
  context: ProcessingContext,
): Promise<boolean> {
  const { logger, requestId, config } = context;
  const ticker = earmark.tickerHash.toLowerCase();

  const currentRequiredAmount = BigInt(currentMinAmount);
  const earmarkedAmount = BigInt(earmark.minAmount);

  if (!currentRequiredAmount || !earmarkedAmount) {
    return false;
  }

  // Both values are already in standardized 18 decimals from the API
  const additionalAmount = currentRequiredAmount - earmarkedAmount;

  logger.info('MinAmount increased, evaluating additional rebalancing', {
    requestId,
    invoiceId: earmark.invoiceId,
    oldMinAmount: earmark.minAmount,
    newMinAmount: currentMinAmount,
    difference: additionalAmount.toString(),
  });

  // Get current balances and earmarked funds
  const balances = await getMarkBalances(config, context.chainService, context.prometheus);
  const activeEarmarks = await database.getEarmarks({ status: [EarmarkStatus.PENDING, EarmarkStatus.READY] });
  const earmarkedFunds = calculateEarmarkedFunds(activeEarmarks);

  // Check if destination already has enough available balance
  const destinationBalance = balances.get(ticker)?.get(earmark.designatedPurchaseChain.toString()) || 0n;
  const earmarkedOnDestination = earmarkedFunds
    .filter((e) => e.chainId === earmark.designatedPurchaseChain && e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + e.amount, 0n);
  const availableBalance = destinationBalance - earmarkedOnDestination;

  if (availableBalance >= additionalAmount) {
    logger.info('Sufficient balance already available for increased minAmount', {
      requestId,
      invoiceId: earmark.invoiceId,
      additionalAmount: additionalAmount.toString(),
      availableBalance: availableBalance.toString(),
    });
    return true;
  }

  // Evaluate if we can rebalance the additional amount
  const onDemandRoutes = config.onDemandRoutes || [];
  const applicableRoutes = onDemandRoutes.filter((route) => {
    if (route.destination !== earmark.designatedPurchaseChain) return false;
    const routeTickerHash = getTickerForAsset(route.asset, route.origin, config);
    return routeTickerHash && routeTickerHash.toLowerCase() === earmark.tickerHash.toLowerCase();
  });

  const { operations: additionalOperations, canFulfill: canRebalanceAdditional } = await calculateRebalancingOperations(
    additionalAmount,
    applicableRoutes,
    balances,
    earmarkedFunds,
    earmark.tickerHash,
    context,
  );

  if (!canRebalanceAdditional || additionalOperations.length === 0) {
    logger.warn('Cannot rebalance additional amount for increased minAmount', {
      requestId,
      invoiceId: earmark.invoiceId,
      additionalAmount: additionalAmount.toString(),
    });
    return false;
  }

  logger.info('Can rebalance additional amount for increased minAmount', {
    requestId,
    invoiceId: earmark.invoiceId,
    additionalAmount: additionalAmount.toString(),
    operations: additionalOperations.length,
  });

  // Track successful additional operations
  const successfulAdditionalOps: Array<{
    originChainId: number;
    amount: string;
    slippage: number;
    bridge: string;
    receipt: database.TransactionReceipt;
    recipient: string;
  }> = [];

  // Execute additional rebalancing operations
  for (const operation of additionalOperations) {
    try {
      const route = onDemandRoutes.find((r) => {
        if (r.origin !== operation.originChain || r.destination !== earmark.designatedPurchaseChain) return false;
        const routeTickerHash = getTickerForAsset(r.asset, r.origin, config);
        return routeTickerHash && routeTickerHash.toLowerCase() === invoice.ticker_hash.toLowerCase();
      });

      if (!route) {
        logger.error('Route not found for additional rebalancing operation', { operation });
        continue;
      }

      const recipient = getActualAddress(earmark.designatedPurchaseChain, config, logger, { requestId });

      // Execute the additional rebalancing with pre-determined bridge
      const result = await executeRebalanceTransactionWithBridge(
        route,
        operation.amount,
        recipient,
        operation.bridge,
        context,
      );

      if (result) {
        logger.info('Additional rebalance transaction confirmed', {
          requestId,
          transactionHash: result.receipt.transactionHash,
          bridgeType: operation.bridge,
          originChain: operation.originChain,
          amount: result.effectiveAmount || operation.amount,
          originalAmount:
            result.effectiveAmount && result.effectiveAmount !== operation.amount ? operation.amount : undefined,
        });

        // Track successful operation
        successfulAdditionalOps.push({
          originChainId: operation.originChain,
          amount: result.effectiveAmount || operation.amount, // Use effective amount if adjusted
          slippage: operation.slippage,
          bridge: operation.bridge,
          receipt: result.receipt,
          recipient,
        });
      }
    } catch (error) {
      logger.error('Failed to execute additional rebalancing operation', {
        requestId,
        operation,
        error: jsonifyError(error),
      });
    }
  }

  // Create database records for successful additional operations
  if (successfulAdditionalOps.length > 0) {
    logger.info('Creating database records for additional rebalancing operations', {
      requestId,
      earmarkId: earmark.id,
      successfulOperations: successfulAdditionalOps.length,
    });

    for (const op of successfulAdditionalOps) {
      try {
        await database.createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: op.originChainId,
          destinationChainId: earmark.designatedPurchaseChain,
          tickerHash: invoice.ticker_hash,
          amount: op.amount,
          slippage: op.slippage,
          status: RebalanceOperationStatus.PENDING,
          bridge: op.bridge,
          transactions: { [op.originChainId]: op.receipt },
          recipient: op.recipient,
        });

        logger.info('Created additional rebalance operation record', {
          requestId,
          earmarkId: earmark.id,
          originChain: op.originChainId,
          txHash: op.receipt.transactionHash,
          bridge: op.bridge,
        });
      } catch (error) {
        // This is a critical error - we have a transaction on-chain but failed to record it
        logger.error('CRITICAL: Failed to create additional rebalance operation record for confirmed transaction', {
          requestId,
          earmarkId: earmark.id,
          operation: op,
          error: jsonifyError(error),
        });
      }
    }
  }

  // Update earmark with new minAmount
  const pool = database.getPool();
  await pool.query('UPDATE earmarks SET "min_amount" = $1, "updated_at" = $2 WHERE id = $3', [
    currentMinAmount,
    new Date(),
    earmark.id,
  ]);

  logger.info('Successfully handled minAmount increase', {
    requestId,
    invoiceId: earmark.invoiceId,
    newMinAmount: currentMinAmount,
  });

  return true;
}

interface RebalanceTransactionResult {
  receipt: database.TransactionReceipt;
  effectiveAmount?: string;
}

/**
 * Execute rebalance transaction with a pre-determined bridge
 */
async function executeRebalanceTransactionWithBridge(
  route: OnDemandRouteConfig,
  amount: string,
  recipient: string,
  bridgeType: SupportedBridge,
  context: ProcessingContext,
): Promise<RebalanceTransactionResult | undefined> {
  const { logger, rebalance, requestId, config } = context;

  try {
    const sender = getActualAddress(route.origin, config, logger, { requestId });
    const originChainConfig = config.chains[route.origin];
    const zodiacConfig = getValidatedZodiacConfig(originChainConfig, logger, { requestId, route });

    const adapter = rebalance.getAdapter(bridgeType);
    if (!adapter) {
      logger.error('Bridge adapter not found', {
        requestId,
        bridgeType,
      });
      return undefined;
    }

    logger.info('Executing on-demand rebalance with pre-determined bridge', {
      requestId,
      route,
      bridgeType,
      amount,
      sender,
      recipient,
    });

    // Execute the rebalance transaction
    const bridgeTxRequests = await adapter.send(sender, recipient, amount, route);

    if (bridgeTxRequests && bridgeTxRequests.length > 0) {
      let receipt: database.TransactionReceipt | undefined = undefined;
      let effectiveBridgedAmount = amount; // Default to requested amount

      for (const { transaction, memo, effectiveAmount } of bridgeTxRequests) {
        logger.info('Submitting on-demand rebalance transaction', {
          requestId,
          bridgeType,
          memo,
          transaction,
          useZodiac: zodiacConfig.walletType,
        });

        try {
          const result = await submitTransactionWithLogging({
            chainService: context.chainService,
            logger,
            chainId: route.origin.toString(),
            txRequest: {
              to: transaction.to!,
              data: transaction.data!,
              value: (transaction.value || 0).toString(),
              chainId: route.origin,
              from: context.config.ownAddress,
              funcSig: transaction.funcSig || '',
            },
            zodiacConfig,
            context: { requestId, bridgeType, transactionType: memo },
          });

          logger.info('Successfully submitted on-demand rebalance transaction', {
            requestId,
            bridgeType,
            memo,
            transactionHash: result.hash,
            useZodiac: zodiacConfig.walletType,
          });

          if (memo === RebalanceTransactionMemo.Rebalance) {
            receipt = result.receipt as unknown as database.TransactionReceipt;
            // Track effective amount if it was capped
            if (effectiveAmount) {
              effectiveBridgedAmount = effectiveAmount;
              logger.info('Using effective bridged amount from adapter', {
                requestId,
                originalAmount: amount,
                effectiveAmount: effectiveBridgedAmount,
                bridgeType,
              });
            }
          }
        } catch (txError) {
          logger.error('Failed to submit on-demand rebalance transaction', {
            requestId,
            bridgeType,
            memo,
            error: jsonifyError(txError),
          });
          throw txError;
        }
      }

      if (receipt) {
        logger.info('Successfully completed on-demand rebalance transaction', {
          requestId,
          bridgeType,
          amount: effectiveBridgedAmount,
          originalAmount: amount !== effectiveBridgedAmount ? amount : undefined,
          route,
          transactionHash: receipt.transactionHash,
          transactionCount: bridgeTxRequests.length,
        });
        return { receipt, effectiveAmount: effectiveBridgedAmount };
      }
    }

    return undefined;
  } catch (error) {
    logger.error('Failed to execute rebalance transaction with bridge', {
      requestId,
      bridgeType,
      error: jsonifyError(error),
    });
    return undefined;
  }
}

/**
 * Process pending earmarked invoices
 * - Validates pending earmarks still have valid invoices
 * - Handles minAmount changes (increases/decreases)
 * - Updates earmark statuses based on rebalancing operation completion
 */
export async function processPendingEarmarks(context: ProcessingContext, currentInvoices: Invoice[]): Promise<void> {
  const { logger, requestId } = context;

  try {
    const pendingEarmarks = await database.getEarmarks({ status: EarmarkStatus.PENDING });
    const invoiceMap = new Map<string, Invoice>(currentInvoices.map((inv) => [inv.intent_id, inv]));

    // Process pending earmarks
    for (const earmark of pendingEarmarks) {
      try {
        // Validate invoice still exists
        const invoice = invoiceMap.get(earmark.invoiceId);
        if (!invoice) {
          logger.info('Earmarked invoice not valid anymore', {
            requestId,
            invoiceId: earmark.invoiceId,
          });
          await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);
          continue;
        }

        // Get current minAmount for the designated purchase chain
        const currentMinAmounts = await getMinAmountsForInvoice(earmark.invoiceId, context);
        if (!currentMinAmounts) continue;
        const currentMinAmount = currentMinAmounts[earmark.designatedPurchaseChain.toString()];

        const currentRequiredAmount = BigInt(currentMinAmount);
        const earmarkedAmount = BigInt(earmark.minAmount);

        if (currentRequiredAmount && earmarkedAmount && currentRequiredAmount > earmarkedAmount) {
          // MinAmount increased - see if additional rebalaning is needed
          const handled = await handleMinAmountIncrease(earmark, invoice, currentMinAmount, context);
          if (!handled) {
            await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);
            continue;
          }
        } else if (currentRequiredAmount && earmarkedAmount && currentRequiredAmount < earmarkedAmount) {
          // MinAmount decreased - don't need to do anything
          logger.info('MinAmount decreased, proceeding with original plan', {
            requestId,
            invoiceId: earmark.invoiceId,
            oldMinAmount: earmark.minAmount,
            newMinAmount: currentMinAmount,
          });
        }

        // Check if all operations are complete and update if so
        if (await checkAllOperationsComplete(earmark.id)) {
          logger.info('All rebalance operations complete for earmark', {
            requestId,
            earmarkId: earmark.id,
            invoiceId: earmark.invoiceId,
          });
          await database.updateEarmarkStatus(earmark.id, EarmarkStatus.READY);
        }
      } catch (error) {
        logger.error('Error processing earmarked invoice', {
          requestId,
          earmarkId: earmark.id,
          error: jsonifyError(error),
        });
      }
    }
  } catch (error) {
    logger.error('Failed to process pending earmarks due to database error', {
      requestId,
      error: jsonifyError(error),
    });
  }
}

export async function cleanupCompletedEarmarks(
  purchasedInvoiceIds: string[],
  context: ProcessingContext,
): Promise<void> {
  const { logger, requestId } = context;

  for (const invoiceId of purchasedInvoiceIds) {
    try {
      const earmark = await database.getActiveEarmarkForInvoice(invoiceId);

      if (earmark && earmark.status === EarmarkStatus.READY) {
        await database.updateEarmarkStatus(earmark.id, EarmarkStatus.COMPLETED);

        logger.info('Marked earmark as completed', {
          requestId,
          earmarkId: earmark.id,
          invoiceId,
        });
      }
    } catch (error) {
      logger.error('Error cleaning up earmark', {
        requestId,
        invoiceId,
        error: jsonifyError(error),
      });
    }
  }
}

export async function cleanupStaleEarmarks(invoiceIds: string[], context: ProcessingContext): Promise<void> {
  const { logger, requestId } = context;

  for (const invoiceId of invoiceIds) {
    try {
      const earmark = await database.getActiveEarmarkForInvoice(invoiceId);

      if (earmark) {
        // Mark earmark as cancelled since the invoice is no longer available
        await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);

        logger.info('Marked stale earmark as cancelled', {
          requestId,
          earmarkId: earmark.id,
          invoiceId,
          previousStatus: earmark.status,
        });
      }
    } catch (error) {
      logger.error('Error cleaning up stale earmark', {
        requestId,
        invoiceId,
        error: jsonifyError(error),
      });
    }
  }
}

export async function getAvailableBalanceLessEarmarks(
  chainId: number,
  tickerHash: string,
  context: ProcessingContext,
): Promise<bigint> {
  const { config, chainService, prometheus } = context;

  // Get total balance
  const balances = await getMarkBalances(config, chainService, prometheus);
  const ticker = tickerHash.toLowerCase();
  const totalBalance = balances.get(ticker)?.get(chainId.toString()) || 0n;

  // Get earmarked amounts (both pending and ready)
  const earmarks = await database.getEarmarks({
    designatedPurchaseChain: chainId,
    status: [EarmarkStatus.PENDING, EarmarkStatus.READY],
  });
  const earmarkedAmount = earmarks
    .filter((e: database.Earmark) => e.tickerHash.toLowerCase() === ticker)
    .reduce((sum: bigint, e: database.Earmark) => {
      // earmark.minAmount is already stored in standardized 18 decimals from the API
      const amount = BigInt(e.minAmount) || 0n;
      return sum + amount;
    }, 0n);

  // Exclude funds from on-demand operations associated with active earmarks
  // Note: This query loads all operations matching the status filter. Performance is optimized with
  // the idx_rebalance_operations_status_earmark_dest composite index. At expected scale (< 1,000 operations),
  // this performs well (~10-15ms). If scale exceeds 10,000 operations, consider adding chainId filter here.
  const activeEarmarkIds = new Set(earmarks.map((e: database.Earmark) => e.id));
<<<<<<< HEAD
  const { operations: onDemandOps } = await database.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK, RebalanceOperationStatus.COMPLETED],
=======
  const onDemandOps = await database.getRebalanceOperations({
    status: [
      RebalanceOperationStatus.PENDING,
      RebalanceOperationStatus.AWAITING_CALLBACK,
      RebalanceOperationStatus.COMPLETED,
    ],
>>>>>>> 651040d (fix: lint)
  });

  const onDemandFunds = onDemandOps
    .filter(
      (op: database.RebalanceOperation) =>
        op.destinationChainId === chainId &&
        op.tickerHash.toLowerCase() === ticker &&
        op.earmarkId !== null &&
        activeEarmarkIds.has(op.earmarkId),
    )
    .reduce((sum: bigint, op: database.RebalanceOperation) => {
      const decimals = getDecimalsFromConfig(ticker, op.originChainId.toString(), config);
      return sum + convertTo18Decimals(BigInt(op.amount), decimals);
    }, 0n);

  return totalBalance - (earmarkedAmount > onDemandFunds ? earmarkedAmount : onDemandFunds);
}
