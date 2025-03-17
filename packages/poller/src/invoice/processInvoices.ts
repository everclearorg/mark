import { InvalidPurchaseReasons, Invoice, MarkConfiguration } from '@mark/core';
import { PurchaseCache } from '@mark/cache';
import { jsonifyError, jsonifyMap, Logger } from '@mark/logger';
import { EverclearAdapter, IntentStatus } from '@mark/everclear';
import { hexlify, randomBytes } from 'ethers/lib/utils';
import { InvoiceLabels, PrometheusAdapter } from '@mark/prometheus';
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
import { ChainService } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';
import { Wallet } from 'ethers';

interface ProcessInvoicesParams {
  invoices: Invoice[];
  cache: PurchaseCache;
  logger: Logger;
  everclear: EverclearAdapter;
  chainService: ChainService;
  prometheus: PrometheusAdapter;
  config: MarkConfiguration;
  web3Signer: Web3Signer | Wallet;
}

export const MAX_DESTINATIONS = 10; // enforced onchain at 10
export const TOP_N_DESTINATIONS = 7; // mark's preferred top-N domains ordered in his config

const getTimeSeconds = () => Math.floor(Date.now() / 1000);

export async function processInvoices({
  invoices,
  everclear,
  cache,
  chainService,
  logger,
  prometheus,
  config,
  web3Signer,
}: ProcessInvoicesParams): Promise<void> {
  // Create request id tracker for polling
  const requestId = hexlify(randomBytes(32));

  // Get current time to measure invoice age
  const time = getTimeSeconds();
  let start = time;
  logger.debug('Method start', { requestId, start });

  logger.info('Starting invoice processing', {
    requestId,
    invoiceCount: invoices.length,
    invoices: invoices.map((i) => i.intent_id),
  });

  // Query all of marks balances across chains
  logger.info('Getting mark balances', { requestId, chains: Object.keys(config.chains) });
  const balances = await getMarkBalances(config, prometheus);
  logger.debug('Retrieved balances', { requestId, balances: jsonifyMap(balances), duration: getTimeSeconds() - start });

  // Query all of marks gas balances across chains
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
  const cachedPurchases = await cache.getAllPurchases();
  logger.debug('Retrieved cached purchases', { requestId, duration: getTimeSeconds() - start });
  start = getTimeSeconds();

  // Remove cached purchases that no longer apply to an invoice.
  const targetsToRemove = (
    await Promise.all(
      cachedPurchases.map(async (purchase) => {
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

  const pendingPurchases = cachedPurchases.filter(({ target }) => !targetsToRemove.includes(target.intent_id));

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

  // Group invoices by ticker
  const invoiceQueues = new Map<string, Invoice[]>(); // [tickerHash]: invoice[] (oldest first)
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
        ticker: invoice.ticker_hash,
      };
      prometheus.recordPossibleInvoice(labels);
    });

  // Process each ticker group. Goal is to process the first (earliest) invoice in each queue.
  start = getTimeSeconds();
  for (const [ticker, invoiceQueue] of invoiceQueues.entries()) {
    logger.debug('Processing ticker group', { requestId, ticker, invoiceCount: invoiceQueue.length });
    const toEvaluate = invoiceQueue
      .map((i) => {
        const reason = isValidInvoice(i, config, time);
        if (reason) {
          logger.warn('Invoice is invalid, skipping.', {
            requestId,
            invoiceId: i.intent_id,
            ticker,
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

    // Process invoices until we find one we've already purchased
    for (const invoice of toEvaluate) {
      start = getTimeSeconds();
      const invoiceId = invoice.intent_id;
      const labels: InvoiceLabels = {
        origin: invoice.origin,
        id: invoice.intent_id,
        ticker,
      };

      // Skip entire ticker if we already have a purchase for this invoice
      if (pendingPurchases.find(({ target }) => target.intent_id === invoiceId)) {
        logger.debug('Found existing purchase, stopping ticker processing', {
          requestId,
          ticker,
          invoiceId,
          invoice,
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.PendingPurchaseRecord, labels);
        break;
      }

      // Add XERC20 check here
      const isXerc20 = await isXerc20Supported(invoice.ticker_hash, invoice.destinations, config);
      if (isXerc20) {
        logger.info('XERC20 strategy enabled for invoice destination, skipping', {
          requestId,
          invoiceId,
          destinations: invoice.destinations,
          invoice,
          ticker,
          duration: getTimeSeconds() - start,
        });
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.DestinationXerc20, labels);
        continue;
      }

      // Get the minimum amounts for invoice
      let minAmounts: Record<string, string>;
      try {
        const { minAmounts: _minAmounts } = await everclear.getMinAmounts(invoiceId);
        minAmounts = _minAmounts;
        logger.debug('Got minimum amounts for invoice', {
          requestId,
          invoiceId,
          invoice,
          minAmounts,
          duration: getTimeSeconds() - start,
        });
      } catch (e) {
        logger.error('Failed to get min amounts for invoice', {
          requestId,
          invoiceId,
          invoice,
          error: jsonifyError(e),
          duration: getTimeSeconds() - start,
        });
        minAmounts = Object.fromEntries(invoice.destinations.map((d) => [d, '0']));
      }

      // Set for ticker-destination pair lookup
      const existingDestinations = new Set(
        pendingPurchases.filter((p) => p.target.ticker_hash === ticker).map((p) => p.purchase.params.origin),
      );

      // Filter out origins that already have pending purchases for this destination-ticker combo
      const filteredMinAmounts = { ...minAmounts };
      for (const destination of Object.keys(filteredMinAmounts)) {
        if (existingDestinations.has(destination)) {
          logger.info('Action exists for destination-ticker combo, removing from consideration', {
            requestId,
            invoiceId,
            destination,
            duration: getTimeSeconds() - start,
          });
          prometheus.recordInvalidPurchase(InvalidPurchaseReasons.PendingPurchaseRecord, {
            ...labels,
            destination,
          });
          delete filteredMinAmounts[destination];
        }
      }

      // Skip if no valid origins remain
      if (Object.keys(filteredMinAmounts).length === 0) {
        logger.info('No valid origins remain after filtering existing purchases', {
          requestId,
          invoiceId,
          duration: getTimeSeconds() - start,
        });
        continue;
      }

      // Calculate optimal intents to fire using split intents calc
      const { intents, originDomain, totalAllocated } = await calculateSplitIntents(
        invoice,
        filteredMinAmounts,
        config,
        balances,
        custodiedAssets,
        logger,
        requestId,
      );
      logger.info('Calculated split intents for invoice', {
        requestId,
        invoiceId,
        intents,
        origin: originDomain,
        totalAllocated,
      });

      if (intents.length === 0) {
        logger.info('No valid intents can be generated for invoice', {
          requestId,
          invoiceId,
          minAmounts,
          duration: getTimeSeconds() - start,
        });
        // Record insufficient balance as the reason since calculateSplitIntents returned no intents
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.InsufficientBalance, labels);
        // Skip to next invoice
        continue;
      }

      try {
        const intentResults = await sendIntents(
          invoiceId,
          intents,
          { everclear, chainService, logger, cache, prometheus, web3Signer },
          config,
          requestId,
        );

        // Store all purchases in pendingPurchases
        for (let i = 0; i < intentResults.length; i++) {
          const purchase = {
            target: invoice,
            purchase: {
              intentId: intentResults[i].intentId,
              params: intents[i],
            },
            transactionHash: intentResults[i].transactionHash,
          };
          pendingPurchases.push(purchase);
        }

        // Record metrics
        prometheus.recordSuccessfulPurchase({
          ...labels,
          destination: originDomain,
          isSplit: intents.length > 1 ? 'true' : 'false',
          splitCount: intents.length.toString(),
        });
        prometheus.recordInvoicePurchaseDuration(Math.floor(Date.now()) - invoice.hub_invoice_enqueued_timestamp);

        // Log all intent results together with the invoice ID
        logger.info(`Created purchases for invoice`, {
          requestId,
          invoiceId: invoice.intent_id,
          allIntentResults: intentResults.map((result, index) => ({
            intentIndex: index,
            intentId: result.intentId,
            transactionHash: result.transactionHash,
            params: intents[index],
          })),
          totalAmount: invoice.amount,
          totalAllocated: totalAllocated.toString(),
          intentCount: intents.length,
          coverage: `${Number((BigInt(totalAllocated) * BigInt(100)) / BigInt(invoice.amount)).toFixed(2)}%`,
          transactionHashes: intentResults.map((result) => result.transactionHash),
          duration: getTimeSeconds() - start,
        });
      } catch (error) {
        prometheus.recordInvalidPurchase(InvalidPurchaseReasons.TransactionFailed, {
          ...labels,
          destination: originDomain,
        });
        logger.error(`Failed to submit purchase transaction('s')}`, {
          error: jsonifyError(error),
          invoiceId: invoice.intent_id,
          intentCount: intents.length,
          originDomain,
          duration: getTimeSeconds() - start,
        });

        // Continue to next invoice if this one failed
        continue;
      }
    }
  }

  if (pendingPurchases.length === 0) {
    logger.info('Method complete with 0 purchases', {
      requestId,
      pendingPurchases,
      invoices,
      duration: getTimeSeconds() - time,
    });
    return;
  }

  // Store purchases in cache
  try {
    await cache.addPurchases(pendingPurchases);
    logger.info(`Stored ${pendingPurchases.length} purchases in cache`, { requestId, purchases: pendingPurchases });
  } catch (e) {
    logger.error('Failed to add purchases to cache', { requestId, error: jsonifyError(e, { pendingPurchases }) });
    throw e;
  }

  logger.info(`Method complete with ${pendingPurchases.length} purchase(s)`, {
    requestId,
    pendingPurchases,
    invoices,
    duration: getTimeSeconds() - start,
  });
}
