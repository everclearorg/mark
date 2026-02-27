import { jsonifyError, jsonifyMap } from '@mark/logger';
import { Invoice, EarmarkStatus } from '@mark/core';
import { ProcessingContext } from '@mark/poller/src/init';
import {
  getMarkBalances,
  getCustodiedBalances,
  getSupportedDomainsForTicker,
  isXerc20Supported,
} from '@mark/poller/src/helpers';
import { isValidInvoice } from '@mark/poller/src/invoice/validation';
import * as onDemand from '@mark/poller/src/rebalance/onDemand';
import { InvalidPurchaseReasons } from '@mark/core';
import { InvoiceLabels } from '@mark/prometheus';
import { QueuedEvent } from '#/queue';
import { processPendingEarmark, getTimeSeconds, splitAndSendIntents } from '#/helpers';

// Permanent validation reasons - invoice won't become valid.
// We store these in the invalid invoice cache.
const PERMANENT_INVALID_REASONS = new Set([
  InvalidPurchaseReasons.InvalidAmount,
  InvalidPurchaseReasons.InvalidFormat,
  InvalidPurchaseReasons.InvalidOwner,
  InvalidPurchaseReasons.InvalidDestinations,
  InvalidPurchaseReasons.InvalidTickers,
  InvalidPurchaseReasons.InvalidTokenConfiguration,
  InvalidPurchaseReasons.DestinationXerc20,
]);

export enum EventProcessingResultType {
  Success = 'Success',
  Failure = 'Failure',
  Invalid = 'Invalid',
  Continue = 'Continue',
}

export interface EventProcessingResult {
  result: EventProcessingResultType;
  eventId: string;
  processedAt: number;
  duration: number;
  error?: string;
  retryAfter?: number;
}

export class EventProcessor {
  constructor(private readonly processingContext: ProcessingContext) {}

  /**
   * Process invoice enqueued event
   */
  async processInvoiceEnqueued(event: QueuedEvent): Promise<EventProcessingResult> {
    const startTime = Date.now();
    const { config, everclear, chainService, purchaseCache, logger, prometheus, requestId, database } =
      this.processingContext;
    let start = getTimeSeconds();

    try {
      logger.info('Processing invoice enqueued event', {
        requestId,
        invoiceId: event.id,
      });

      let invoice: Invoice;
      try {
        invoice = await everclear.fetchInvoiceById(event.id);
        logger.debug('Fetched invoice data', {
          requestId,
          invoice,
          ticker: invoice.ticker_hash,
        });
      } catch (e) {
        logger.error('Invoice not found', {
          requestId,
          invoiceId: event.id,
          error: jsonifyError(e),
        });
        await onDemand.cleanupStaleEarmarks([event.id], this.processingContext);
        return {
          result: EventProcessingResultType.Success,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
        };
      }

      // Validate invoice early - before expensive operations
      const ticker = invoice.ticker_hash;
      const labels: InvoiceLabels = { origin: invoice.origin, id: invoice.intent_id, ticker };
      const validationReason = isValidInvoice(invoice, config, start);
      if (validationReason) {
        logger.warn('Invoice is invalid, skipping.', {
          requestId,
          invoiceId: event.id,
          ticker,
          invoice,
          reason: validationReason,
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(validationReason, labels);
        const invalid = (PERMANENT_INVALID_REASONS as Set<string>).has(validationReason);
        return {
          result: invalid ? EventProcessingResultType.Invalid : EventProcessingResultType.Failure,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
          retryAfter: 60000,
        };
      }

      // Skip this invoice if XERC20 is supported
      if (await isXerc20Supported(invoice.ticker_hash, invoice.destinations, config)) {
        logger.info('XERC20 strategy enabled for invoice destination, skipping', {
          requestId,
          invoiceId: event.id,
          destinations: invoice.destinations,
          invoice,
          ticker: invoice.ticker_hash,
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.DestinationXerc20, labels);
        return {
          result: EventProcessingResultType.Invalid,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
        };
      }

      // Get the minimum amounts for the invoice
      let minAmounts: Record<string, string>;
      try {
        const response = await everclear.getMinAmounts(event.id);
        minAmounts = response.minAmounts;
        logger.debug('Got minimum amounts for invoice', {
          requestId,
          invoiceId: event.id,
          invoice,
          minAmounts,
          duration: getTimeSeconds() - start,
        });
      } catch (e) {
        logger.error('Failed to get min amounts for invoice, skipping', {
          requestId,
          invoiceId: event.id,
          invoice,
          error: jsonifyError(e),
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.TransactionFailed, labels);
        return {
          result: EventProcessingResultType.Failure,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
          retryAfter: 60000,
        };
      }

      start = getTimeSeconds();

      try {
        await processPendingEarmark(invoice, minAmounts, this.processingContext);

        // Get an active earmark for this specific invoice
        const pendingEarmarks = await database.getEarmarks({
          status: [EarmarkStatus.INITIATING, EarmarkStatus.PENDING, EarmarkStatus.READY],
          invoiceId: invoice.intent_id,
        });

        if (pendingEarmarks.length > 0) {
          const earmark = pendingEarmarks[0];
          if (earmark.status === EarmarkStatus.PENDING || earmark.status === EarmarkStatus.INITIATING) {
            logger.debug('Skipping invoice with pending earmark', {
              requestId,
              invoiceId: event.id,
              ticker: invoice.ticker_hash,
            });
            return {
              result: EventProcessingResultType.Continue,
              eventId: event.id,
              processedAt: Date.now(),
              duration: Date.now() - startTime,
              retryAfter: 10000,
            };
          }

          // Only use the designated origin for this earmarked invoice
          if (minAmounts[earmark.designatedPurchaseChain.toString()]) {
            minAmounts = {
              [earmark.designatedPurchaseChain.toString()]: minAmounts[earmark.designatedPurchaseChain.toString()],
            };
          } else {
            logger.warn('Earmarked invoice designated origin not available in minAmounts', {
              requestId,
              invoiceId: event.id,
              designatedOrigin: earmark.designatedPurchaseChain,
              availableOrigins: Object.keys(minAmounts),
              originalMinAmounts: Object.keys(minAmounts),
            });
            return {
              result: EventProcessingResultType.Failure,
              eventId: event.id,
              processedAt: Date.now(),
              duration: Date.now() - startTime,
              retryAfter: 60000,
            };
          }
        }

        logger.debug('Processed earmark for invoice', {
          requestId,
          invoiceId: event.id,
          duration: getTimeSeconds() - start,
        });
      } catch (error) {
        logger.error('Failed to process pending earmark for invoice', {
          requestId,
          invoiceId: event.id,
          error: jsonifyError(error),
          duration: getTimeSeconds() - start,
        });
        // Do not continue without earmark state — an earmark may exist and
        // processing without it could skip the designated purchase chain or
        // attempt a purchase while rebalancing is in-flight.
        return {
          result: EventProcessingResultType.Failure,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
          retryAfter: 30000,
        };
      }

      const isPaused = await purchaseCache.isPaused();
      if (isPaused) {
        logger.warn('Purchase loop is paused, skipping invoice', {
          invoiceId: event.id,
        });
        return {
          result: EventProcessingResultType.Failure,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
          retryAfter: 60000,
        };
      }

      // Query all of Mark's balances across chains
      logger.info('Getting mark balances', { requestId, chains: Object.keys(config.chains) });
      start = getTimeSeconds();
      const balances = await getMarkBalances(config, chainService, prometheus);
      logger.debug('Retrieved balances', {
        requestId,
        invoiceId: event.id,
        balances: jsonifyMap(balances),
        duration: getTimeSeconds() - start,
      });

      // Get all custodied assets
      logger.info('Getting custodied assets', {
        requestId,
        invoiceId: event.id,
        chains: Object.keys(config.chains),
      });
      start = getTimeSeconds();
      const custodiedAssets = await getCustodiedBalances(config);
      logger.debug('Retrieved custodied assets', {
        requestId,
        invoiceId: event.id,
        custodiedAssets: jsonifyMap(custodiedAssets),
        duration: getTimeSeconds() - start,
      });

      // Get existing purchase actions
      logger.debug('Getting cached purchases', { requestId, invoiceId: event.id });
      start = getTimeSeconds();
      const cachedPurchases = await purchaseCache.getPurchases([event.id]);
      logger.debug('Retrieved cached purchases', {
        requestId,
        invoiceId: event.id,
        cachedCount: cachedPurchases.length,
        duration: getTimeSeconds() - start,
      });

      // Skip if we already have a purchase for this invoice
      if (cachedPurchases.length > 0) {
        logger.debug('Found existing purchase, skipping invoice', {
          requestId,
          invoiceId: event.id,
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.PendingPurchaseRecord, labels);
        return {
          result: EventProcessingResultType.Success,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
        };
      }

      start = getTimeSeconds();

      // Process the economy data to adjust custodied assets
      const adjustedCustodied = new Map(custodiedAssets);
      if (!adjustedCustodied.has(ticker)) {
        adjustedCustodied.set(ticker, new Map<string, bigint>());
      }

      const supportedDomains = getSupportedDomainsForTicker(ticker, config);

      logger.info('Fetching economy data for ticker', {
        requestId,
        ticker,
        supportedDomains,
      });
      start = getTimeSeconds();

      const economyResults = await Promise.all(
        supportedDomains.map(async (domain) => {
          try {
            const data = await everclear.fetchEconomyData(domain, ticker);
            return { domain, data, success: true };
          } catch (error) {
            // Don't need to fail here, economy data is not required for processing
            logger.warn('Failed to fetch economy data for domain, continuing without it', {
              requestId,
              domain,
              ticker,
              error: jsonifyError(error),
            });
            return { domain, data: null, success: false };
          }
        }),
      );

      for (const { domain, data, success } of economyResults) {
        if (!success || !data || !data.incomingIntents) continue;

        let pendingAmount = BigInt(0);

        for (const chainIntents of Object.values(data.incomingIntents)) {
          for (const intent of chainIntents) {
            pendingAmount += BigInt(intent.amount);
          }
        }

        if (pendingAmount > 0n) {
          const currentCustodied = adjustedCustodied.get(ticker)?.get(domain) || BigInt(0);

          // Add pending amount, as it should increase custodied when arrived on hub
          const newCustodied = currentCustodied + pendingAmount;
          adjustedCustodied.get(ticker)!.set(domain, newCustodied);

          logger.info('Adjusted custodied assets for domain based on pending intents', {
            requestId,
            domain,
            ticker,
            pendingAmount: pendingAmount.toString(),
            originalCustodied: currentCustodied.toString(),
            adjustedCustodied: newCustodied.toString(),
          });
        }
      }

      logger.debug('Economy data processing completed', {
        requestId,
        ticker,
        duration: getTimeSeconds() - start,
      });

      const purchases = await splitAndSendIntents(
        invoice,
        balances,
        adjustedCustodied,
        minAmounts,
        this.processingContext,
      );

      // Store purchases in the cache
      if (purchases.length > 0) {
        try {
          await purchaseCache.addPurchases(purchases);
          logger.info(`Stored ${purchases.length} purchase(s) in cache`, { requestId, invoiceId: event.id, purchases });

          // Clean up completed earmarks
          try {
            await onDemand.cleanupCompletedEarmarks([event.id], this.processingContext);
            logger.info('Cleaned up completed earmarks', {
              requestId,
              invoiceId: event.id,
            });
          } catch (error) {
            logger.error('Failed to cleanup completed earmarks', {
              requestId,
              invoiceId: event.id,
              error: jsonifyError(error),
            });
          }
        } catch (e) {
          logger.error('Failed to add purchases to cache', {
            requestId,
            invoiceId: event.id,
            error: jsonifyError(e, { purchases }),
          });
          throw e;
        }
      } else {
        logger.info('Method complete with 0 purchases', {
          requestId,
          invoiceId: event.id,
          invoice,
          duration: getTimeSeconds() - startTime,
        });

        return {
          result: EventProcessingResultType.Failure,
          eventId: event.id,
          processedAt: Date.now(),
          duration: Date.now() - startTime,
          retryAfter: 10000,
        };
      }

      logger.info(`Method complete with ${purchases.length} purchase(s)`, {
        requestId,
        invoiceId: event.id,
        purchases,
        invoice,
        duration: getTimeSeconds() - startTime,
      });

      return {
        result: EventProcessingResultType.Success,
        eventId: event.id,
        processedAt: Date.now(),
        duration: Date.now() - startTime,
      };
    } catch (error) {
      logger.error('Failed to process invoice enqueued event', {
        requestId,
        invoiceId: event.id,
        error: jsonifyError(error),
      });

      return {
        result: EventProcessingResultType.Failure,
        eventId: event.id,
        processedAt: Date.now(),
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryAfter: 60000,
      };
    }
  }

  /**
   * Process settlement enqueued event
   * This event signals that an invoice has been settled/paid, so we should remove it from the purchase cache
   */
  async processSettlementEnqueued(event: QueuedEvent): Promise<EventProcessingResult> {
    const { purchaseCache, logger, prometheus } = this.processingContext;
    const startTime = Date.now();

    try {
      logger.info('Processing settlement enqueued event', {
        eventId: event.id,
        invoiceId: event.id,
      });

      const cachedPurchases = await purchaseCache.getPurchases([event.id]);
      if (cachedPurchases.length > 0) {
        const purchase = cachedPurchases[0];
        for (const destination of purchase.target.destinations) {
          prometheus.recordPurchaseClearanceDuration(
            {
              origin: purchase.target.origin,
              ticker: purchase.target.ticker_hash,
              destination,
            },
            getTimeSeconds() - purchase.target.hub_invoice_enqueued_timestamp,
          );
        }
        logger.info(`Completed purchase`, { purchase });

        // Remove the invoice from the purchase cache since it has been settled
        await purchaseCache.removePurchases([event.id]);
      }

      logger.info('Settlement enqueued event processed successfully', {
        invoiceId: event.id,
        duration: Date.now() - startTime,
      });

      return {
        result: EventProcessingResultType.Success,
        eventId: event.id,
        processedAt: Date.now(),
        duration: Date.now() - startTime,
      };
    } catch (error) {
      logger.error('Failed to process settlement enqueued event', {
        eventId: event.id,
        error: jsonifyError(error),
      });

      return {
        result: EventProcessingResultType.Failure,
        eventId: event.id,
        processedAt: Date.now(),
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryAfter: 60000,
      };
    }
  }
}
