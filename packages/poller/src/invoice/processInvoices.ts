import { getTokenAddressFromConfig, InvalidPurchaseReasons, Invoice, NewIntentParams } from '@mark/core';
import { jsonifyError, jsonifyMap } from '@mark/logger';
import { IntentStatus } from '@mark/everclear';
import { InvoiceLabels } from '@mark/prometheus';
import { ProcessingContext } from '../init';
import {
  getMarkBalances,
  getMarkGasBalances,
  logGasThresholds,
  sendIntents,
  isXerc20Supported,
  calculateSplitIntents,
  getCustodiedBalances,
  getSupportedDomainsForTicker,
} from '../helpers';
import { isValidInvoice } from './validation';
import { PurchaseAction } from '@mark/cache';

export const MAX_DESTINATIONS = 10; // enforced onchain at 10
export const TOP_N_DESTINATIONS = 7; // mark's preferred top-N domains ordered in his config
export const BPS_MULTIPLIER = BigInt(10 ** 4);

const getTimeSeconds = () => Math.floor(Date.now() / 1000);

export interface TickerGroup {
  ticker: string;
  invoices: Invoice[];
  remainingBalances: Map<string, Map<string, bigint>>;
  remainingCustodied: Map<string, Map<string, bigint>>;
  chosenOrigin: string | null;
}

interface ProcessTickerGroupResult {
  purchases: PurchaseAction[];
  remainingBalances: Map<string, Map<string, bigint>>;
  remainingCustodied: Map<string, Map<string, bigint>>;
}

interface InvoiceWithIntents {
  invoice: Invoice;
  intents: NewIntentParams[];
  totalAllocated: bigint;
}

interface BatchedTickerGroup {
  ticker: string;
  origin: string;
  invoicesWithIntents: InvoiceWithIntents[];
  totalIntents: number;
}

/**
 * Groups invoices by ticker hash
 * @param context - The processing context
 * @param invoices - The invoices to group
 * @returns A map of ticker hash to invoices, sorted by oldest first
 */
export function groupInvoicesByTicker(context: ProcessingContext, invoices: Invoice[]): Map<string, Invoice[]> {
  const { prometheus } = context;

  const invoiceQueues = new Map<string, Invoice[]>();

  invoices
    .sort((a, b) => {
      // Primary sort by entry_epoch
      if (a.entry_epoch !== b.entry_epoch) {
        return a.entry_epoch - b.entry_epoch;
      }
      // Secondary sort for deterministic ordering
      return a.hub_invoice_enqueued_timestamp - b.hub_invoice_enqueued_timestamp;
    })
    .forEach((invoice) => {
      if (!invoiceQueues.has(invoice.ticker_hash)) {
        invoiceQueues.set(invoice.ticker_hash, []);
      }
      invoiceQueues.get(invoice.ticker_hash)!.push(invoice);

      // Record invoice as seen
      const labels: InvoiceLabels = {
        origin: invoice.origin,
        id: invoice.intent_id,
        ticker: invoice.ticker_hash,
      };
      prometheus.recordPossibleInvoice(labels);
    });

  return invoiceQueues;
}

/**
 * Processes a group of invoices grouped by ticker hash
 * @param context - The processing context
 * @param group - The ticker group to process
 * @param pendingPurchases - The pending purchases to check against
 * @returns The purchase actions that were created
 */
export async function processTickerGroup(
  context: ProcessingContext,
  group: TickerGroup,
  pendingPurchases: PurchaseAction[],
): Promise<ProcessTickerGroupResult> {
  const { config, everclear, logger, prometheus, requestId, startTime } = context;
  let start = startTime;

  logger.debug('Processing ticker group', {
    requestId,
    ticker: group.ticker,
    invoiceCount: group.invoices.length,
  });

  const toEvaluate = group.invoices
    .map((i) => {
      const reason = isValidInvoice(i, config, start);
      if (reason) {
        logger.warn('Invoice is invalid, skipping.', {
          requestId,
          invoiceId: i.intent_id,
          ticker: group.ticker,
          invoice: i,
          reason,
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(reason, { origin: i.origin, id: i.intent_id, ticker: i.ticker_hash });
        return undefined;
      }
      return i;
    })
    .filter((x) => !!x);

  // Track the batch state for this ticker group
  const batchedGroup: BatchedTickerGroup = {
    ticker: group.ticker,
    origin: '',
    invoicesWithIntents: [],
    totalIntents: 0,
  };

  // Track remaining balances
  let remainingBalances = new Map(group.remainingBalances);
  let remainingCustodied = new Map(group.remainingCustodied);

  // Incremental minAmounts for all invoices in this ticker group
  const incrementalAmounts = new Map<string, bigint>();

  for (const invoice of toEvaluate) {
    start = getTimeSeconds();
    const invoiceId = invoice.intent_id;
    const labels: InvoiceLabels = { origin: invoice.origin, id: invoice.intent_id, ticker: invoice.ticker_hash };

    // Skip entire ticker group if we already have a purchase for this invoice
    // TODO: relax this condition to improve purchase times for multiple sequential invoices on the same ticker
    if (pendingPurchases.find(({ target }) => target.intent_id === invoiceId)) {
      logger.debug('Found existing purchase, stopping ticker processing', {
        requestId,
        ticker: invoice.ticker_hash,
        invoiceId,
        invoice,
        duration: getTimeSeconds() - start,
      });
      prometheus.recordInvalidPurchase(InvalidPurchaseReasons.PendingPurchaseRecord, labels);
      break;
    }

    // Skip this invoice if XERC20 is supported
    if (await isXerc20Supported(invoice.ticker_hash, invoice.destinations, config)) {
      logger.info('XERC20 strategy enabled for invoice destination, skipping', {
        requestId,
        invoiceId,
        destinations: invoice.destinations,
        invoice,
        ticker: invoice.ticker_hash,
        duration: getTimeSeconds() - start,
      });
      prometheus.recordInvalidPurchase(InvalidPurchaseReasons.DestinationXerc20, labels);
      continue;
    }

    // Get the minimum amounts for invoice
    const minAmounts = await (async () => {
      try {
        const { minAmounts: _minAmounts } = await everclear.getMinAmounts(invoiceId);
        logger.debug('Got minimum amounts for invoice', {
          requestId,
          invoiceId,
          invoice,
          minAmounts: _minAmounts,
          duration: getTimeSeconds() - start,
        });
        return _minAmounts;
      } catch (e) {
        logger.error('Failed to get min amounts for invoice, skipping', {
          requestId,
          invoiceId,
          invoice,
          error: jsonifyError(e),
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.TransactionFailed, labels);
        return null;
      }
    })();

    // Skip this invoice if we couldn't get min amounts
    if (!minAmounts) {
      continue;
    }

    // Set for ticker-destination pair lookup
    const existingDestinations = new Set(
      pendingPurchases.filter((p) => p.target.ticker_hash === invoice.ticker_hash).map((p) => p.purchase.params.origin),
    );

    // Filter out origins that already have pending purchases for this destination-ticker combo
    let filteredMinAmounts = Object.fromEntries(
      Object.entries(minAmounts).filter(([destination]) => {
        if (existingDestinations.has(destination)) {
          logger.info('Action exists for destination-ticker combo, removing from consideration', {
            requestId,
            invoiceId,
            destination,
            duration: getTimeSeconds() - start,
          });
          prometheus.recordInvalidPurchase(InvalidPurchaseReasons.PendingPurchaseRecord, { ...labels, destination });
          return false;
        }
        return true;
      }),
    );

    // Skip if no valid origins remain
    if (Object.keys(filteredMinAmounts).length === 0) {
      logger.info('No valid origins remain after filtering existing purchases', {
        requestId,
        invoiceId,
        duration: getTimeSeconds() - start,
      });
      continue;
    }

    // Use all candidate origins in split calc for the first invoice of this ticker.
    // For subsequent invoices, only use the chosen origin.
    filteredMinAmounts = batchedGroup.origin
      ? { [batchedGroup.origin]: filteredMinAmounts[batchedGroup.origin] || '0' }
      : filteredMinAmounts;

    let incrementalAmount = BigInt('0');
    if (batchedGroup.origin) {
      const currentCumulative = BigInt(filteredMinAmounts[batchedGroup.origin] || '0');

      // Amount from previously batched invoices
      const previousCumulative = batchedGroup.invoicesWithIntents.reduce(
        (sum, item) => sum + incrementalAmounts.get(item.invoice.intent_id)!,
        BigInt('0'),
      );

      incrementalAmount = currentCumulative - previousCumulative;

      // Validate that cumulative amounts are monotonic (increasing)
      if (incrementalAmount < BigInt('0')) {
        logger.warn('API returned non-monotonic cumulative amount, skipping invoice', {
          requestId,
          invoiceId,
          ticker: invoice.ticker_hash,
          origin: batchedGroup.origin,
          currentCumulative: currentCumulative.toString(),
          previousCumulative: previousCumulative.toString(),
          calculatedIncremental: incrementalAmount.toString(),
          duration: getTimeSeconds() - start,
        });
        continue;
      }

      incrementalAmounts.set(invoiceId, incrementalAmount);

      // Check if adding this invoice would exceed available balance
      const availableBalance = remainingBalances.get(invoice.ticker_hash)?.get(batchedGroup.origin) || BigInt('0');
      const currentBatchTotal = previousCumulative;

      if (currentBatchTotal + incrementalAmount > availableBalance) {
        logger.info('Adding invoice to batch would exceed balance', {
          requestId,
          invoiceId,
          ticker: invoice.ticker_hash,
          origin: batchedGroup.origin,
          incrementalAmount: incrementalAmount.toString(),
          currentBatchTotal: currentBatchTotal.toString(),
          availableBalance: availableBalance.toString(),
          duration: getTimeSeconds() - start,
        });
        continue;
      }
    } else {
      // First invoice in batch, incremental will be set after calculateSplitIntents determines the actual origin
      incrementalAmount = BigInt('0');
    }

    const { intents, originDomain, totalAllocated, remainder } = await calculateSplitIntents(
      context,
      invoice,
      filteredMinAmounts,
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

    // Oldest invoice, prio enabled, and couldn't find a valid allocation
    if (!originDomain && batchedGroup.invoicesWithIntents.length === 0 && config.forceOldestInvoice) {
      logger.info('Cannot settle oldest invoice in ticker group with prioritization enabled, skipping group', {
        requestId,
        invoiceId,
        ticker: invoice.ticker_hash,
        duration: getTimeSeconds() - start,
      });
      break;
    }

    if (intents.length > 0) {
      // First purchased invoice in the group sets the origin for all subsequent invoices
      if (!batchedGroup.origin) {
        batchedGroup.origin = originDomain;
        // Origin determined for batch; set the incremental amount for the first invoice
        incrementalAmount = BigInt(filteredMinAmounts[originDomain] || '0');
        incrementalAmounts.set(invoiceId, incrementalAmount);
        logger.info('Selected origin for ticker group', {
          requestId,
          ticker: group.ticker,
          origin: batchedGroup.origin,
          firstInvoiceId: invoiceId,
        });
      }

      // Add this invoice and its intents to the batch
      batchedGroup.invoicesWithIntents.push({
        invoice,
        intents,
        totalAllocated,
      });
      batchedGroup.totalIntents += intents.length;

      // Update remaining custodied - handle allocated intents (up to totalAllocated)
      let runningSum = BigInt('0');
      let targetIdx = 0;
      const allocatedIntents = [];
      for (const intent of intents) {
        const amount = BigInt(intent.amount);

        // Get target destination of the allocation
        const targetDestination = intents[targetIdx].destinations[0];

        const currentCustodied = remainingCustodied.get(invoice.ticker_hash)?.get(targetDestination) || BigInt('0');
        const decrementAmount = currentCustodied < amount ? currentCustodied : amount;
        remainingCustodied.get(invoice.ticker_hash)?.set(targetDestination, currentCustodied - decrementAmount);

        runningSum += amount;
        allocatedIntents.push(intent);
        targetIdx++;

        // Break after processing the intent that puts us over totalAllocated
        if (runningSum > totalAllocated) {
          break;
        }
      }

      // Update remaining custodied - handle remainder intents by distributing across destinations
      // This is best effort to make sure we don't over-allocate in subsequent invoices
      const remainderIntents = intents.slice(allocatedIntents.length);
      if (remainderIntents.length > 0) {
        const destinations = remainderIntents[0].destinations;

        // Distribute remainder across destinations until depleted
        let remaining = remainder;
        for (const destination of destinations) {
          if (remaining <= BigInt('0')) break;

          const currentCustodied = remainingCustodied.get(invoice.ticker_hash)?.get(destination) || BigInt('0');
          if (currentCustodied > BigInt('0')) {
            const decrementAmount = currentCustodied < remaining ? currentCustodied : remaining;
            remainingCustodied.get(invoice.ticker_hash)?.set(destination, currentCustodied - decrementAmount);
            remaining -= decrementAmount;
          }
        }
      }

      logger.info('Added invoice to batch', {
        requestId,
        invoiceId,
        origin: originDomain,
        totalAllocated: totalAllocated.toString(),
        splitIntentCount: intents.length,
        isMultiIntent: intents.length > 1,
        batchSize: batchedGroup.invoicesWithIntents.length,
        duration: getTimeSeconds() - start,
      });
    }
  }

  if (batchedGroup.totalIntents === 0) {
    incrementalAmounts.clear();
    return {
      purchases: [],
      remainingBalances: group.remainingBalances,
      remainingCustodied: group.remainingCustodied,
    };
  }

  // Flatten all intents while maintaining their invoice association
  const allIntents = batchedGroup.invoicesWithIntents.flatMap(({ invoice, intents }) =>
    intents.map((intent) => ({ params: intent, invoice })),
  );

  // Send all intents in one batch
  let purchases: PurchaseAction[] = [];
  try {
    const intentResults = await sendIntents(
      allIntents[0].invoice.intent_id,
      allIntents.map((i) => i.params),
      context,
      config,
      requestId,
    );

    // Create purchases maintaining the invoice-intent relationship
    purchases = intentResults.map((result, index) => ({
      target: allIntents[index].invoice,
      purchase: {
        intentId: result.intentId,
        params: allIntents[index].params,
      },
      transactionHash: result.transactionHash,
      transactionType: result.type,
    }));

    // Record metrics per invoice, properly handling split intents
    for (const { invoice, intents } of batchedGroup.invoicesWithIntents) {
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

      let assetAddr = getTokenAddressFromConfig(invoice.ticker_hash, invoice.origin, config);
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
    }

    logger.info(`Created purchases for batched ticker group`, {
      requestId,
      ticker: batchedGroup.ticker,
      origin: batchedGroup.origin,
      invoiceCount: batchedGroup.invoicesWithIntents.length,
      totalIntents: batchedGroup.totalIntents,
      invoiceIds: batchedGroup.invoicesWithIntents.map((i) => i.invoice.intent_id),
      allIntentResults: intentResults.map((result, index) => ({
        intentIndex: index,
        intentId: result.intentId,
        transactionHash: result.transactionHash,
        invoiceId: allIntents[index].invoice.intent_id,
        params: allIntents[index].params,
      })),
      transactionHashes: intentResults.map((result) => result.transactionHash),
      duration: getTimeSeconds() - start,
    });
  } catch (error) {
    // Record invalid purchase for each invoice in the batch
    for (const { invoice } of batchedGroup.invoicesWithIntents) {
      prometheus.recordInvalidPurchase(InvalidPurchaseReasons.TransactionFailed, {
        origin: invoice.origin,
        id: invoice.intent_id,
        ticker: invoice.ticker_hash,
      });
    }

    logger.error('Failed to send intents for ticker group', {
      requestId,
      ticker: batchedGroup.ticker,
      origin: batchedGroup.origin,
      invoiceCount: batchedGroup.invoicesWithIntents.length,
      invoiceIds: batchedGroup.invoicesWithIntents.map((i) => i.invoice.intent_id),
      error: jsonifyError(error),
      duration: getTimeSeconds() - start,
    });

    incrementalAmounts.clear();
    throw error;
  }

  incrementalAmounts.clear();
  return {
    purchases,
    remainingBalances,
    remainingCustodied,
  };
}

/**
 * Processes given invoices against Mark's balances and custodied assets
 * @param context - The processing context
 * @param invoices - The invoices to process
 */
export async function processInvoices(context: ProcessingContext, invoices: Invoice[]): Promise<void> {
  const { config, everclear, purchaseCache: cache, logger, prometheus, requestId, startTime } = context;
  let start = startTime;

  logger.info('Starting invoice processing', {
    requestId,
    invoiceCount: invoices.length,
    invoices: invoices.map((i) => i.intent_id),
  });

  // Query all of Mark's balances across chains
  logger.info('Getting mark balances', { requestId, chains: Object.keys(config.chains) });
  start = getTimeSeconds();
  const balances = await getMarkBalances(config, prometheus);
  logger.debug('Retrieved balances', { requestId, balances: jsonifyMap(balances), duration: getTimeSeconds() - start });

  // Query all of Mark's gas balances across chains
  logger.info('Getting mark gas balances', { requestId, chains: Object.keys(config.chains) });
  start = getTimeSeconds();
  const gasBalances = await getMarkGasBalances(config, prometheus);
  logGasThresholds(gasBalances, config, logger);
  logger.debug('Retrieved gas balances', {
    requestId,
    gasBalances: jsonifyMap(gasBalances),
    duration: getTimeSeconds() - start,
  });

  // Get all custodied assets
  logger.info('Getting custodied assets', { requestId, chains: Object.keys(config.chains) });
  start = getTimeSeconds();
  const custodiedAssets = await getCustodiedBalances(config);
  logger.debug('Retrieved custodied assets', {
    requestId,
    custodiedAssets: jsonifyMap(custodiedAssets),
    duration: getTimeSeconds() - start,
  });

  // Get existing purchase actions
  logger.debug('Getting cached purchases', { requestId });
  start = getTimeSeconds();
  const allCachedPurchases = await cache.getAllPurchases();
  logger.debug('Retrieved cached purchases', { requestId, duration: getTimeSeconds() - start });
  start = getTimeSeconds();

  // Remove cached purchases that no longer apply to an invoice.
  const targetsToRemove = (
    await Promise.all(
      allCachedPurchases.map(async (purchase: PurchaseAction) => {
        if (!purchase.purchase.intentId) {
          return undefined;
        }
        // Remove purchases that are invoiced or settled
        const status = await everclear.intentStatus(purchase.purchase.intentId!);
        const spentStatuses = [
          IntentStatus.INVOICED,
          IntentStatus.SETTLED_AND_MANUALLY_EXECUTED,
          IntentStatus.SETTLED,
          IntentStatus.SETTLED_AND_COMPLETED,
          IntentStatus.DISPATCHED_HUB,
          IntentStatus.DISPATCHED_UNSUPPORTED,
          IntentStatus.UNSUPPORTED,
          IntentStatus.UNSUPPORTED_RETURNED,
        ];
        if (!spentStatuses.includes(status)) {
          // Purchase intent could still be used to pay down target invoice
          return undefined;
        }
        return purchase.target.intent_id;
      }),
    )
  ).filter((x: string | undefined) => !!x);

  const pendingPurchases = allCachedPurchases.filter(
    ({ target }: PurchaseAction) => !targetsToRemove.includes(target.intent_id),
  );

  try {
    await cache.removePurchases([...new Set(targetsToRemove)] as string[]);
    logger.info(`Removed stale purchase(s)`, {
      requestId,
      removed: targetsToRemove.length,
      targetsToRemove,
      duration: getTimeSeconds() - start,
    });

    const completedPurchases = allCachedPurchases.filter(({ target }: PurchaseAction) =>
      targetsToRemove.includes(target.intent_id),
    );

    for (const purchase of completedPurchases) {
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
    }
  } catch (e) {
    logger.warn('Failed to clear pending cache', { requestId, error: jsonifyError(e, { targetsToRemove }) });
  }

  const invoiceQueues = groupInvoicesByTicker(context, invoices);
  let remainingBalances = new Map(balances);
  let remainingCustodied = new Map(custodiedAssets);
  const allPurchases: PurchaseAction[] = [];

  // Process each ticker group
  for (const [ticker, invoiceQueue] of invoiceQueues.entries()) {
    const adjustedCustodied = new Map(remainingCustodied);
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

    // Process the economy data to adjust custodied assets
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

    // Use adjusted custodied assets
    const group: TickerGroup = {
      ticker,
      invoices: invoiceQueue,
      remainingBalances,
      remainingCustodied: adjustedCustodied,
      chosenOrigin: null,
    };

    try {
      const {
        purchases,
        remainingBalances: newBalances,
        remainingCustodied: newCustodied,
      } = await processTickerGroup(context, group, pendingPurchases);

      remainingBalances = newBalances;
      remainingCustodied = newCustodied;
      allPurchases.push(...purchases);
    } catch (error) {
      logger.error('Failed to process ticker group', {
        requestId,
        ticker,
        error: jsonifyError(error),
        duration: getTimeSeconds() - start,
      });
      continue;
    }
  }

  // Store purchases in cache
  if (allPurchases.length > 0) {
    try {
      await cache.addPurchases(allPurchases);
      logger.info(`Stored ${allPurchases.length} purchase(s) in cache`, { requestId, purchases: allPurchases });
    } catch (e) {
      logger.error('Failed to add purchases to cache', {
        requestId,
        error: jsonifyError(e, { purchases: allPurchases }),
      });
      throw e;
    }
  } else {
    logger.info('Method complete with 0 purchases', { requestId, invoices, duration: getTimeSeconds() - startTime });
  }

  logger.info(`Method complete with ${allPurchases.length} purchase(s)`, {
    requestId,
    purchases: allPurchases,
    invoices,
    duration: getTimeSeconds() - startTime,
  });
}
