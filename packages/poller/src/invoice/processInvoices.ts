import { InvalidPurchaseReasons, Invoice, NewIntentParams } from '@mark/core';
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
} from '../helpers';
import { isValidInvoice } from './validation';
import { PurchaseAction } from '@mark/cache';

export const MAX_DESTINATIONS = 10; // enforced onchain at 10
export const TOP_N_DESTINATIONS = 7; // mark's preferred top-N domains ordered in his config

const getTimeSeconds = () => Math.floor(Date.now() / 1000);

export interface TickerGroup {
  ticker: string;
  invoices: Invoice[];
  remainingBalances: Map<string, Map<string, bigint>>;
  remainingCustodied: Map<string, Map<string, bigint>>;
  chosenOrigin: string | null;
}

/**
 * Groups invoices by ticker hash
 * @param context - The processing context
 * @param invoices - The invoices to group
 * @returns A map of ticker hash to invoices, sorted by oldest first
 */
export function groupInvoicesByTicker(
  context: ProcessingContext,
  invoices: Invoice[]
): Map<string, Invoice[]> {
  const { prometheus } = context;

  const invoiceQueues = new Map<string, Invoice[]>();
  
  invoices
    .sort((a, b) => a.hub_invoice_enqueued_timestamp - b.hub_invoice_enqueued_timestamp)
    .forEach((invoice) => {
      if (!invoiceQueues.has(invoice.ticker_hash)) {
        invoiceQueues.set(invoice.ticker_hash, []);
      }
      invoiceQueues.get(invoice.ticker_hash)!.push(invoice);

      // Record invoice as seen
      const labels: InvoiceLabels = { 
        origin: invoice.origin, 
        id: invoice.intent_id, 
        ticker: invoice.ticker_hash 
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
  pendingPurchases: PurchaseAction[]
): Promise<{
  purchases: PurchaseAction[];
  remainingBalances: Map<string, Map<string, bigint>>;
  remainingCustodied: Map<string, Map<string, bigint>>;
}> {
  const { config, everclear, cache, logger, prometheus, chainService, web3Signer, requestId, startTime } = context;
  let start = startTime;

  logger.debug('Processing ticker group', { 
    requestId, 
    ticker: group.ticker, 
    invoiceCount: group.invoices.length 
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

  // Track for batching invoice purchases
  let remainingBalances = new Map(group.remainingBalances);
  let remainingCustodied = new Map(group.remainingCustodied);
  let batchedInvoices: Invoice[] = [];
  let batchedIntents: NewIntentParams[] = [];
  let chosenOrigin: string | null = null;
  
  for (const invoice of toEvaluate) {
    start = getTimeSeconds();
    const invoiceId = invoice.intent_id;
    const labels: InvoiceLabels = { origin: invoice.origin, id: invoice.intent_id, ticker: invoice.ticker_hash };

    // Skip entire ticker group if we already have a purchase for this invoice
    if (pendingPurchases.find(({ target }) => target.intent_id === invoiceId)) {
      logger.debug('Found existing purchase, stopping ticker processing', {
        requestId, ticker: invoice.ticker_hash, invoiceId, invoice, duration: getTimeSeconds() - start,
      });
      prometheus.recordInvalidPurchase(InvalidPurchaseReasons.PendingPurchaseRecord, labels);
      break;
    }

    // Skip this invoice if XERC20 is supported
    if (await isXerc20Supported(invoice.ticker_hash, invoice.destinations, config)) {
      logger.info('XERC20 strategy enabled for invoice destination, skipping', {
        requestId, invoiceId, destinations: invoice.destinations, invoice, ticker: invoice.ticker_hash,
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
          requestId, invoiceId, invoice, minAmounts: _minAmounts, duration: getTimeSeconds() - start,
        });
        return _minAmounts;
      } catch (e) {
        logger.error('Failed to get min amounts for invoice', {
          requestId, invoiceId, invoice, error: jsonifyError(e), duration: getTimeSeconds() - start,
        });
        return Object.fromEntries(invoice.destinations.map((d) => [d, '0']));
      }
    })();

    // Set for ticker-destination pair lookup
    const existingDestinations = new Set(
      pendingPurchases.filter((p) => p.target.ticker_hash === invoice.ticker_hash).map((p) => p.purchase.params.origin),
    );

    // Filter out origins that already have pending purchases for this destination-ticker combo
    let filteredMinAmounts = Object.fromEntries(
      Object.entries(minAmounts).filter(([destination]) => {
        if (existingDestinations.has(destination)) {
          logger.info('Action exists for destination-ticker combo, removing from consideration', {
            requestId, invoiceId, destination, duration: getTimeSeconds() - start,
          });
          prometheus.recordInvalidPurchase(InvalidPurchaseReasons.PendingPurchaseRecord, { ...labels, destination });
          return false;
        }
        return true;
      })
    );

    // Skip if no valid origins remain
    if (Object.keys(filteredMinAmounts).length === 0) {
      logger.info('No valid origins remain after filtering existing purchases', {
        requestId, invoiceId, duration: getTimeSeconds() - start,
      });
      continue;
    }

    // Use all candidate origins in split calc for the first invoice of this ticker.
    // For subsequent invoices, only use the chosen origin.
    filteredMinAmounts = chosenOrigin ? 
      { [chosenOrigin]: filteredMinAmounts[chosenOrigin] || '0' } : 
      filteredMinAmounts;

    const { intents, originDomain } = await calculateSplitIntents(
      invoice,
      filteredMinAmounts,
      config,
      remainingBalances,
      remainingCustodied,
      logger,
      requestId,
    );

    // Oldest invoice, prio enabled, and couldn't find a valid allocation
    if (!originDomain && batchedInvoices.length === 0 && config.prioritizeOldestInvoice) {
      logger.info('Cannot settle oldest invoice in ticker group with prioritization enabled, skipping group', {
        requestId, invoiceId, ticker: invoice.ticker_hash, duration: getTimeSeconds() - start,
      });
      break;
    }

    if (intents.length > 0) {
      // First purchase of the ticker group, use this origin for subsequent invoices
      if (!chosenOrigin) {
        chosenOrigin = originDomain;
        logger.info('Selected origin for ticker group', { requestId, ticker: invoice.ticker_hash, origin: chosenOrigin });
      }

      batchedInvoices.push(invoice);
      batchedIntents.push(...intents);

      // Update remaining balance for the chosen origin
      const currentBalance = remainingBalances.get(invoice.ticker_hash)?.get(originDomain) || BigInt('0');
      const requiredAmount = BigInt(minAmounts[originDomain]);
      remainingBalances.get(invoice.ticker_hash)?.set(originDomain, currentBalance - requiredAmount);

      // Update remaining custodied for the target destination
      // First dest is the actual target of the intent (we pad the others for backup)
      const targetDestination = intents[0].destinations[0];
      const currentCustodied = remainingCustodied.get(invoice.ticker_hash)?.get(targetDestination) || BigInt('0');
      const totalAllocated = intents.reduce((sum, intent) => sum + BigInt(intent.amount), BigInt('0'));
      remainingCustodied.get(invoice.ticker_hash)?.set(targetDestination, currentCustodied - totalAllocated);

      logger.info('Added invoice to batch', {
        requestId, invoiceId, origin: originDomain, targetDestination, totalAllocated: totalAllocated.toString(),
        intentCount: intents.length, duration: getTimeSeconds() - start,
      });
    }
  }

  // Send all batched intents for this ticker group
  if (batchedInvoices.length > 0 && batchedIntents.length > 0) {
    try {
      const intentResults = await sendIntents(
        batchedInvoices[0].intent_id,
        batchedIntents,
        { everclear, logger, cache, prometheus, chainService, web3Signer },
        config,
        requestId
      );

      // Record metrics for all batched invoices
      batchedInvoices.forEach(batchedInvoice => {
        prometheus.recordSuccessfulPurchase({
          origin: batchedInvoice.origin,
          id: batchedInvoice.intent_id,
          ticker: batchedInvoice.ticker_hash,
          destination: batchedIntents[0].origin,
          isSplit: batchedIntents.length > 1 ? 'true' : 'false',
          splitCount: batchedIntents.length.toString(),
        });
        prometheus.recordInvoicePurchaseDuration(
          Math.floor(Date.now()) - batchedInvoice.hub_invoice_enqueued_timestamp
        );
      });

      logger.info(`Created purchases for batched invoices`, {
        requestId,
        batchedInvoiceIds: batchedInvoices.map(inv => inv.intent_id),
        allIntentResults: intentResults.map((result, index) => ({
          intentIndex: index,
          intentId: result.intentId,
          transactionHash: result.transactionHash,
          params: batchedIntents[index],
        })),
        intentCount: batchedIntents.length,
        transactionHashes: intentResults.map((result) => result.transactionHash),
        duration: getTimeSeconds() - start,
      });

      // Return the purchases with intent IDs and transaction hashes
      return {
        purchases: intentResults.map((result, index) => ({
          target: batchedInvoices[index],
          purchase: {
            intentId: result.intentId,
            params: batchedIntents[index],
          },
          transactionHash: result.transactionHash,
        })),
        remainingBalances,
        remainingCustodied,
      };
    } catch (error) {
      // Record invalid purchase for each invoice in the batch
      batchedInvoices.forEach(invoice => {
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.TransactionFailed, {
          origin: invoice.origin,
          id: invoice.intent_id,
          ticker: invoice.ticker_hash
        });
      });

      logger.error(`Failed to submit purchase transaction(s) for batch`, {
        error: jsonifyError(error),
        batchedInvoiceIds: batchedInvoices.map(inv => inv.intent_id),
        intentCount: batchedIntents.length,
        duration: getTimeSeconds() - start,
      });
      
      throw error;
    }
  }

  return {
    purchases: [],
    remainingBalances,
    remainingCustodied,
  };
}

/**
 * Processes given invoices against Mark's balances and custodied assets
 * @param context - The processing context
 * @param invoices - The invoices to process
 */
export async function processInvoices(
  context: ProcessingContext,
  invoices: Invoice[]
): Promise<void> {
  const { config, everclear, cache, logger, prometheus, chainService, web3Signer, requestId, startTime } = context;
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
  logger.debug('Retrieved gas balances', { requestId, gasBalances: jsonifyMap(gasBalances), duration: getTimeSeconds() - start });

  // Get all custodied assets
  logger.info('Getting custodied assets', { requestId, chains: Object.keys(config.chains) });
  start = getTimeSeconds();
  const custodiedAssets = await getCustodiedBalances(config);
  logger.debug('Retrieved custodied assets', { requestId, custodiedAssets: jsonifyMap(custodiedAssets), duration: getTimeSeconds() - start });

  // Get existing purchase actions
  logger.debug('Getting cached purchases', { requestId });
  start = getTimeSeconds();
  const cachedPurchases = await cache.getAllPurchases();
  logger.debug('Retrieved cached purchases', { requestId, duration: getTimeSeconds() - start });
  start = getTimeSeconds();

  // Remove cached purchases that no longer apply to an invoice.
  const targetsToRemove = (
    await Promise.all(
      cachedPurchases.map(async (purchase: PurchaseAction) => {
        // Remove purchases that are invoiced or settled
        const status = await everclear.intentStatus(purchase.purchase.intentId);
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

  const pendingPurchases = cachedPurchases.filter(({ target }: PurchaseAction) => !targetsToRemove.includes(target.intent_id));

  try {
    await cache.removePurchases(targetsToRemove as string[]);
    logger.info(`Removed stale purchase(s)`, {
      requestId,
      removed: targetsToRemove.length,
      targetsToRemove,
      duration: getTimeSeconds() - start,
    });
  } catch (e) {
    logger.warn('Failed to clear pending cache', { requestId, error: jsonifyError(e, { targetsToRemove }) });
  }

  const invoiceQueues = groupInvoicesByTicker(context, invoices);
  let remainingBalances = new Map(balances);
  let remainingCustodied = new Map(custodiedAssets);
  const allPurchases: PurchaseAction[] = [];
  
  // Process each ticker group
  for (const [ticker, invoiceQueue] of invoiceQueues.entries()) {
    const group: TickerGroup = {
      ticker,
      invoices: invoiceQueue,
      remainingBalances,
      remainingCustodied,
      chosenOrigin: null,
    };

    try {
      const { purchases, remainingBalances: newBalances, remainingCustodied: newCustodied } = 
        await processTickerGroup(context, group, pendingPurchases);

      remainingBalances = newBalances;
      remainingCustodied = newCustodied;
      allPurchases.push(...purchases);
    } catch (error) {
      logger.error('Failed to process ticker group', { requestId, ticker, error: jsonifyError(error), duration: getTimeSeconds() - start });
      continue;
    }
  }

  // Store purchases in cache
  if (allPurchases.length > 0) {
    try {
      await cache.addPurchases(allPurchases);
      logger.info(`Stored ${allPurchases.length} purchases in cache`, { requestId, purchases: allPurchases });
    } catch (e) {
      logger.error('Failed to add purchases to cache', { requestId, error: jsonifyError(e, { purchases: allPurchases }) });
      throw e;
    }
  } else {
    logger.info('Method complete with 0 purchases', { requestId, invoices, duration: getTimeSeconds() - startTime });
  }

  logger.info(`Method complete with ${allPurchases.length} purchase(s)`, { requestId, purchases: allPurchases, invoices, duration: getTimeSeconds() - startTime });
}
