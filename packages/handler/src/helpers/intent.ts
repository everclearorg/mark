import { ProcessingContext } from '@mark/poller/src/init';
import {
  AddressFormat,
  BPS_MULTIPLIER,
  getTokenAddressFromConfig,
  InvalidPurchaseReasons,
  Invoice,
  isSvmChain,
} from '@mark/core';
import { PurchaseAction } from '@mark/cache';
import { getTimeSeconds } from './utils';
import { InvoiceLabels } from '@mark/prometheus';
import { calculateSplitIntents, sendIntents } from '@mark/poller/src/helpers';
import * as onDemand from '@mark/poller/src/rebalance/onDemand';
import { jsonifyError } from '@mark/logger';

/**
 * Calculate split intents for an invoice and send them:
 * - Calculates split intents based on available balances and minAmounts.
 * - Evaluates and executes on-demand rebalancing if no valid allocation found.
 * - Sends intents in a batch and creates purchase actions.
 * - Records metrics for successful purchases.
 * @returns Array of purchase actions created from the intents that were sent.
 */
export async function splitAndSendIntents(
  invoice: Invoice,
  remainingBalances: Map<string, Map<string, bigint>>,
  remainingCustodied: Map<string, Map<string, bigint>>,
  minAmounts: Record<string, string>,
  processingContext: ProcessingContext,
): Promise<PurchaseAction[]> {
  const { config, logger, prometheus, requestId, database } = processingContext;
  const start = getTimeSeconds();
  const invoiceId = invoice.intent_id;
  const ticker = invoice.ticker_hash;
  const labels: InvoiceLabels = { origin: invoice.origin, id: invoice.intent_id, ticker: invoice.ticker_hash };

  // Calculate split intents
  const { intents, originDomain, totalAllocated, remainder } = await calculateSplitIntents(
    processingContext,
    invoice,
    minAmounts,
    remainingBalances,
    remainingCustodied,
  );

  logger.debug('Calculated split intents', {
    requestId,
    invoiceId,
    intents,
    originDomain,
    totalAllocated,
    remainder,
  });

  // Check if on-demand rebalancing can settle the invoice if no valid allocation found
  if (!originDomain) {
    // Check if on-demand rebalancing is paused
    const isOnDemandPaused = await database.isPaused('ondemand');
    if (isOnDemandPaused) {
      logger.warn('On-demand rebalancing is paused, skipping', {
        requestId,
        invoiceId,
        ticker: invoice.ticker_hash,
      });
      return [];
    } else {
      logger.info('No valid allocation found, evaluating on-demand rebalancing', {
        requestId,
        invoiceId,
        ticker: invoice.ticker_hash,
      });

      try {
        const evaluationResult = await onDemand.evaluateOnDemandRebalancing(invoice, minAmounts, processingContext);

        if (evaluationResult.canRebalance) {
          const earmarkId = await onDemand.executeOnDemandRebalancing(invoice, evaluationResult, processingContext);

          if (earmarkId) {
            logger.info('Successfully created earmark for on-demand rebalancing', {
              requestId,
              invoiceId,
              earmarkId,
            });

            // This earmarked invoice will be processed later once all its rebalancing ops are done
            return [];
          }
        }
      } catch (error) {
        logger.error('Failed to evaluate/execute on-demand rebalancing', {
          requestId,
          invoiceId,
          error: jsonifyError(error),
        });
      }
    }
  }

  if (intents.length === 0) {
    return [];
  }

  logger.info('Processed invoice intents', {
    requestId,
    invoiceId,
    origin: originDomain,
    totalAllocated: totalAllocated.toString(),
    splitIntentCount: intents.length,
    isMultiIntent: intents.length > 1,
    duration: getTimeSeconds() - start,
  });

  // Send all intents in one batch
  let purchases: PurchaseAction[] = [];
  try {
    const intentResults = await sendIntents(invoice.intent_id, intents, processingContext, config, requestId);

    // Create purchases maintaining the invoice-intent relationship
    purchases = intentResults.map((result, index) => ({
      target: invoice,
      purchase: {
        intentId: result.intentId,
        params: intents[index],
      },
      transactionHash: result.transactionHash,
      transactionType: result.type,
      cachedAt: getTimeSeconds(),
    }));

    // Record metrics
    prometheus.recordSuccessfulPurchase({
      origin: invoice.origin,
      id: invoice.intent_id,
      ticker: invoice.ticker_hash,
      destination: intents[0].origin,
      isSplit: intents.length > 1 ? 'true' : 'false',
      splitCount: intents.length.toString(),
    });

    for (const intent of intents) {
      prometheus.recordInvoicePurchaseDuration(
        {
          origin: invoice.origin,
          ticker: invoice.ticker_hash,
          destination: intent.origin,
        },
        getTimeSeconds() - invoice.hub_invoice_enqueued_timestamp,
      );
    }

    const format = isSvmChain(invoice.origin) ? AddressFormat.Base58 : AddressFormat.Hex;
    let assetAddr = getTokenAddressFromConfig(invoice.ticker_hash, invoice.origin, config, format);
    if (!assetAddr) {
      logger.error('Failed to get token address from config', {
        requestId,
        intentId: invoice.intent_id,
        ticker: invoice.ticker_hash,
        origin: invoice.origin,
      });
      assetAddr = 'unknown';
    }
    prometheus.updateRewards(
      {
        chain: invoice.origin,
        asset: assetAddr,
        id: invoice.intent_id,
        ticker: invoice.ticker_hash,
      },
      Number((BigInt(invoice.discountBps) * BigInt(invoice.amount)) / BPS_MULTIPLIER),
    );

    logger.info('Successful purchase', { invoice });
    logger.info(`Created purchases for invoice`, {
      requestId,
      ticker,
      origin: originDomain,
      totalIntents: intents.length,
      invoiceId,
      allIntentResults: intentResults.map((result, index) => ({
        intentIndex: index,
        intentId: result.intentId,
        transactionHash: result.transactionHash,
        params: intents[index],
      })),
      transactionHashes: intentResults.map((result) => result.transactionHash),
      duration: getTimeSeconds() - start,
    });
  } catch (error) {
    prometheus.recordInvalidPurchase(InvalidPurchaseReasons.TransactionFailed, labels);

    logger.error('Failed to send intents for invoice', {
      requestId,
      ticker,
      origin: originDomain,
      invoiceId,
      error: jsonifyError(error),
      duration: getTimeSeconds() - start,
    });

    throw error;
  }

  return purchases;
}
