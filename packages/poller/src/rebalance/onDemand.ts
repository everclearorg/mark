import { ProcessingContext } from '../init';
import { Invoice, EarmarkStatus, RebalanceOperationStatus } from '@mark/core';
import { RouteRebalancingConfig, MarkConfiguration } from '@mark/core';
import * as database from '@mark/database';
import type { earmarks } from '@mark/database';
import { getMarkBalances, safeStringToBigInt } from '../helpers';
import { formatUnits } from 'viem';
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
    slippages: number[];
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
  const earmarkedFunds = calculateEarmarkedFunds(activeEarmarks, config);

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
  const bestDestination = selectBestDestination(evaluationResults, invoice.ticker_hash, config);

  if (!bestDestination) {
    logger.info('No viable destination found for on-demand rebalancing', {
      requestId,
      invoiceId: invoice.intent_id,
    });
    return { canRebalance: false };
  }

  return bestDestination;
}

async function evaluateDestinationChain(
  invoice: Invoice,
  destination: number,
  minAmount: string,
  routes: RouteRebalancingConfig[],
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  context: ProcessingContext,
): Promise<OnDemandRebalanceResult> {
  const { logger, config } = context;

  // Find routes that can send to this destination
  const applicableRoutes = routes.filter(
    (route) => route.destination === destination && route.asset.toLowerCase() === invoice.ticker_hash.toLowerCase(),
  );

  if (applicableRoutes.length === 0) {
    return { canRebalance: false };
  }

  const ticker = invoice.ticker_hash.toLowerCase();
  const decimals = getDecimalsFromConfig(ticker, destination.toString(), config);
  const scaleFactor = BigInt(10 ** (decimals ?? 18));
  const requiredAmount = safeStringToBigInt(minAmount, scaleFactor);
  if (!requiredAmount) {
    logger.error('Invalid minAmount', { minAmount, destination });
    return { canRebalance: false };
  }

  // Check current balance on destination
  const destinationBalance = balances.get(ticker)?.get(destination.toString()) || 0n;
  const earmarkedOnDestination = earmarkedFunds
    .filter((e) => e.chainId === destination && e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + e.amount, 0n);

  const availableOnDestination = destinationBalance - earmarkedOnDestination;

  // If destination already has enough, no need to rebalance
  if (availableOnDestination >= requiredAmount) {
    return { canRebalance: false };
  }

  // Calculate how much we need to rebalance
  const amountNeeded = requiredAmount - availableOnDestination;

  // Calculate rebalancing operations
  const { operations, canFulfill } = calculateRebalancingOperations(
    amountNeeded,
    applicableRoutes,
    balances,
    earmarkedFunds,
    invoice.ticker_hash,
    config,
  );

  // Check if we can fulfill the invoice after all rebalancing
  if (canFulfill) {
    return {
      canRebalance: true,
      destinationChain: destination,
      rebalanceOperations: operations,
      totalAmount: requiredAmount.toString(),
    };
  }

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

function calculateEarmarkedFunds(earmarks: earmarks[], config: MarkConfiguration): EarmarkedFunds[] {
  const fundsMap = new Map<string, EarmarkedFunds>();

  for (const earmark of earmarks) {
    const key = `${earmark.designatedPurchaseChain}-${earmark.tickerHash}`;
    const existing = fundsMap.get(key);

    if (existing) {
      const ticker = earmark.tickerHash.toLowerCase();
      const decimals = getDecimalsFromConfig(ticker, earmark.designatedPurchaseChain.toString(), config);
      const scaleFactor = BigInt(10 ** (decimals ?? 18));
      existing.amount += safeStringToBigInt(earmark.minAmount, scaleFactor) || 0n;
    } else {
      fundsMap.set(key, {
        chainId: earmark.designatedPurchaseChain,
        tickerHash: earmark.tickerHash,
        amount: (() => {
          const ticker = earmark.tickerHash.toLowerCase();
          const decimals = getDecimalsFromConfig(ticker, earmark.designatedPurchaseChain.toString(), config);
          const scaleFactor = BigInt(10 ** (decimals ?? 18));
          return safeStringToBigInt(earmark.minAmount, scaleFactor) || 0n;
        })(),
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
 * @param config - Mark configuration
 * @returns Array of rebalancing operations and total amount that can be achieved
 */
function calculateRebalancingOperations(
  amountNeeded: bigint,
  routes: RouteRebalancingConfig[],
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  tickerHash: string,
  config: MarkConfiguration,
): {
  operations: { originChain: number; amount: string; slippages: number[] }[];
  totalAchievable: bigint;
  canFulfill: boolean;
} {
  const ticker = tickerHash.toLowerCase();
  const operations: { originChain: number; amount: string; slippages: number[] }[] = [];
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

    // Calculate amount to send accounting for slippage
    const slippageMultiplier = BigInt(10000 + (route.slippages?.[0] || 100)); // route.slippages[0] is in basis points
    const amountToSend = (remainingNeeded * slippageMultiplier) / 10000n;

    // Use the minimum of what's needed and what's available
    const actualSend = amountToSend < availableOnOrigin ? amountToSend : availableOnOrigin;
    const expectedReceived = (actualSend * 10000n) / slippageMultiplier;

    if (actualSend > 0n) {
      // Convert from 18 decimals to native decimals for the bridge adapter
      const originDecimals = getDecimalsFromConfig(ticker, route.origin.toString(), config);
      const nativeAmount = formatUnits(actualSend, 18 - (originDecimals ?? 18));

      operations.push({
        originChain: route.origin,
        amount: nativeAmount,
        slippages: route.slippages || [100],
      });

      remainingNeeded -= expectedReceived;
      totalAchievable += expectedReceived;
    }
  }

  return {
    operations,
    totalAchievable,
    canFulfill: remainingNeeded <= 0n,
  };
}

function selectBestDestination(
  evaluationResults: Map<number, OnDemandRebalanceResult & { minAmount: string }>,
  tickerHash: string,
  config: MarkConfiguration,
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
        const opTicker = tickerHash.toLowerCase();
        const opDecimals = getDecimalsFromConfig(opTicker, op.originChain.toString(), config);
        const opScaleFactor = BigInt(10 ** (opDecimals ?? 18));
        return sum + (safeStringToBigInt(op.amount, opScaleFactor) || 0n);
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

  // Track successful operations to create database records later
  const successfulOperations: Array<{
    originChainId: number;
    amount: string;
    slippage: number;
    bridge: string;
    txHash: string;
  }> = [];

  try {
    // Execute all rebalancing operations first
    for (const operation of rebalanceOperations!) {
      try {
        // Find the appropriate route config
        const route = (config.onDemandRoutes || []).find(
          (r) =>
            r.origin === operation.originChain &&
            r.destination === destinationChain &&
            r.asset.toLowerCase() === invoice.ticker_hash.toLowerCase(),
        );

        if (!route) {
          logger.error('Route not found for rebalancing operation', { operation });
          continue;
        }

        // Get recipient address (could be different for Zodiac setup)
        const recipient = getActualAddress(destinationChain!, config, logger, { requestId });

        // Execute the actual rebalancing through the rebalance adapter
        // This will use the configured bridge preferences
        const result = await executeRebalanceTransaction(route, operation.amount, recipient, context);

        if (result) {
          logger.info('On-demand rebalance transaction confirmed', {
            requestId,
            transactionHash: result.txHash,
            bridgeType: result.bridgeType,
            originChain: operation.originChain,
            amount: operation.amount,
          });

          // Track successful operation for later database insertion
          successfulOperations.push({
            originChainId: operation.originChain,
            amount: operation.amount,
            slippage: operation.slippages[0],
            bridge: result.bridgeType,
            txHash: result.txHash,
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

    // Only create earmark if we have at least one successful operation
    logger.info('Creating earmark after successful rebalancing operations', {
      requestId,
      invoiceId: invoice.intent_id,
      successfulOperations: successfulOperations.length,
      totalOperations: rebalanceOperations!.length,
    });

    // Create earmark in database
    const earmark = await database.createEarmark({
      invoiceId: invoice.intent_id,
      designatedPurchaseChain: destinationChain!,
      tickerHash: invoice.ticker_hash,
      minAmount: minAmount!,
    });

    logger.info('Created earmark for invoice', {
      requestId,
      earmarkId: earmark.id,
      invoiceId: invoice.intent_id,
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
          txHashes: { originTxHash: op.txHash },
        });

        logger.info('Created rebalance operation record', {
          requestId,
          earmarkId: earmark.id,
          originChain: op.originChainId,
          txHash: op.txHash,
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

    return earmark.id;
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
  return operations.every((op) => op.status === RebalanceOperationStatus.COMPLETED);
}

/**
 * Handle the case when minAmount has increased for an earmarked invoice
 */
async function handleMinAmountIncrease(
  earmark: earmarks,
  invoice: Invoice,
  currentMinAmount: string,
  context: ProcessingContext,
): Promise<boolean> {
  const { logger, requestId, config } = context;
  const ticker = earmark.tickerHash.toLowerCase();
  const decimals = getDecimalsFromConfig(ticker, earmark.designatedPurchaseChain.toString(), config);
  const scaleFactor = BigInt(10 ** (decimals ?? 18));

  const currentRequiredAmount = safeStringToBigInt(currentMinAmount, scaleFactor);
  const earmarkedAmount = safeStringToBigInt(earmark.minAmount, scaleFactor);

  if (!currentRequiredAmount || !earmarkedAmount) {
    return false;
  }

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
  const earmarkedFunds = calculateEarmarkedFunds(activeEarmarks, config);

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
  const applicableRoutes = onDemandRoutes.filter(
    (route) =>
      route.destination === earmark.designatedPurchaseChain &&
      route.asset.toLowerCase() === earmark.tickerHash.toLowerCase(),
  );

  const { operations: additionalOperations, canFulfill: canRebalanceAdditional } = calculateRebalancingOperations(
    additionalAmount,
    applicableRoutes,
    balances,
    earmarkedFunds,
    earmark.tickerHash,
    config,
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
    txHash: string;
  }> = [];

  // Execute additional rebalancing operations
  for (const operation of additionalOperations) {
    try {
      const route = onDemandRoutes.find(
        (r) =>
          r.origin === operation.originChain &&
          r.destination === earmark.designatedPurchaseChain &&
          r.asset.toLowerCase() === invoice.ticker_hash.toLowerCase(),
      );

      if (!route) {
        logger.error('Route not found for additional rebalancing operation', { operation });
        continue;
      }

      const recipient = getActualAddress(earmark.designatedPurchaseChain, config, logger, { requestId });

      // Execute the additional rebalancing
      const result = await executeRebalanceTransaction(route, operation.amount, recipient, context);

      if (result) {
        logger.info('Additional rebalance transaction confirmed', {
          requestId,
          transactionHash: result.txHash,
          bridgeType: result.bridgeType,
          originChain: operation.originChain,
          amount: operation.amount,
        });

        // Track successful operation
        successfulAdditionalOps.push({
          originChainId: operation.originChain,
          amount: operation.amount,
          slippage: operation.slippages[0],
          bridge: result.bridgeType,
          txHash: result.txHash,
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
          txHashes: { originTxHash: op.txHash },
        });

        logger.info('Created additional rebalance operation record', {
          requestId,
          earmarkId: earmark.id,
          originChain: op.originChainId,
          txHash: op.txHash,
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
  await pool.query('UPDATE earmarks SET "minAmount" = $1, "updatedAt" = $2 WHERE id = $3', [
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

async function executeRebalanceTransaction(
  route: RouteRebalancingConfig,
  amount: string,
  recipient: string,
  context: ProcessingContext,
): Promise<{ txHash: string; bridgeType: string } | null> {
  const { logger, rebalance, requestId, config } = context;

  // Use the regular rebalance adapter logic
  try {
    // Get sender address (could be Safe address for Zodiac-enabled chains)
    const sender = getActualAddress(route.origin, config, logger, { requestId });

    // Get Zodiac configuration for origin chain
    const originChainConfig = config.chains[route.origin];
    const zodiacConfig = getValidatedZodiacConfig(originChainConfig, logger, { requestId, route });

    // Try each bridge preference in order
    for (const bridgeType of route.preferences) {
      logger.info('Attempting to execute on-demand rebalance via bridge', {
        requestId,
        route,
        bridgeType,
        amount,
        sender,
        recipient,
      });

      const adapter = rebalance.getAdapter(bridgeType);
      if (!adapter) {
        logger.warn('Bridge adapter not found, trying next preference', {
          requestId,
          bridgeType,
        });
        continue;
      }

      try {
        // Get quote to verify the transaction is viable
        const receivedAmount = await adapter.getReceivedAmount(amount, route);

        // Calculate if slippage is acceptable
        const sentAmount = BigInt(amount);
        const received = BigInt(receivedAmount);
        const slippageBps = ((sentAmount - received) * 10000n) / sentAmount;

        if (slippageBps > BigInt(route.slippages?.[0] || 100)) {
          logger.warn('Quote exceeds acceptable slippage for on-demand rebalance', {
            requestId,
            bridgeType,
            sentAmount: amount,
            receivedAmount,
            slippageBps: slippageBps.toString(),
            maxSlippage: route.slippages?.[0] || 100,
          });
          continue;
        }

        // Execute the rebalance transaction - returns array of transaction requests
        const bridgeTxRequests = await adapter.send(sender, recipient, amount, route);

        if (bridgeTxRequests && bridgeTxRequests.length > 0) {
          // Submit all transactions in order (approval + bridge)
          let transactionHash: string | null = null;

          for (const { transaction, memo } of bridgeTxRequests) {
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

              // Keep track of the actual rebalance transaction hash
              if (memo === RebalanceTransactionMemo.Rebalance) {
                transactionHash = result.hash;
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

          if (transactionHash) {
            logger.info('Successfully completed on-demand rebalance transaction', {
              requestId,
              bridgeType,
              amount,
              route,
              transactionHash,
              transactionCount: bridgeTxRequests.length,
            });
            return { txHash: transactionHash, bridgeType };
          }
        }
      } catch (bridgeError) {
        logger.error('Failed to execute rebalance via bridge', {
          requestId,
          bridgeType,
          error: jsonifyError(bridgeError),
        });
        continue;
      }
    }

    logger.error('All bridge preferences exhausted for on-demand rebalance', {
      requestId,
      route,
      amount,
    });
    return null;
  } catch (error) {
    logger.error('Failed to execute rebalance transaction', {
      requestId,
      error: jsonifyError(error),
    });
    return null;
  }
}

/**
 * Process pending earmarked invoices
 * - Validates pending earmarks still have valid invoices
 * - Handles minAmount changes (increases/decreases)
 * - Updates earmark statuses based on rebalancing operation completion
 */
export async function processPendingEarmarks(context: ProcessingContext, currentInvoices: Invoice[]): Promise<void> {
  const { logger, requestId, config } = context;

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

        // Check if minAmount has changed
        const ticker = earmark.tickerHash.toLowerCase();
        const decimals = getDecimalsFromConfig(ticker, earmark.designatedPurchaseChain.toString(), config);
        const scaleFactor = BigInt(10 ** (decimals ?? 18));
        const currentRequiredAmount = safeStringToBigInt(currentMinAmount, scaleFactor);
        const earmarkedAmount = safeStringToBigInt(earmark.minAmount, scaleFactor);

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
      const earmark = await database.getEarmarkForInvoice(invoiceId);

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
      const earmark = await database.getEarmarkForInvoice(invoiceId);

      if (earmark) {
        // Mark earmark as cancelled since the invoice is no longer available
        await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);

        logger.info('Marked stale earmark as failed', {
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
  const decimals = getDecimalsFromConfig(ticker, chainId.toString(), config);
  const scaleFactor = BigInt(10 ** (decimals ?? 18));
  const earmarkedAmount = earmarks
    .filter((e) => e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + (safeStringToBigInt(e.minAmount, scaleFactor) || 0n), 0n);

  return totalBalance - earmarkedAmount;
}
