import { getTokenAddressFromConfig, Invoice, MarkConfiguration, NewIntentParams } from '@mark/core';
import { PurchaseCache } from '@mark/cache';
import { jsonifyError, jsonifyMap, Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { hexlify, randomBytes } from 'ethers/lib/utils';
import {
  getMarkBalances,
  logBalanceThresholds,
  getMarkGasBalances,
  logGasThresholds,
  convertHubAmountToLocalDecimals,
  sendIntents,
  isXerc20Supported,
} from '../helpers';
import { isValidInvoice } from './validation';
import { ChainService } from '@mark/chainservice';

interface ProcessInvoicesParams {
  invoices: Invoice[];
  cache: PurchaseCache;
  logger: Logger;
  everclear: EverclearAdapter;
  chainService: ChainService;
  config: MarkConfiguration;
}

export async function processInvoices({
  invoices,
  everclear,
  cache,
  chainService,
  logger,
  config,
}: ProcessInvoicesParams): Promise<void> {
  const requestId = hexlify(randomBytes(32));
  logger.info('Starting invoice processing', {
    requestId,
    invoiceCount: invoices.length,
    invoices: invoices.map((i) => i.intent_id),
  });
  // Get current time to measure invoice age
  const time = Math.floor(Date.now() / 1000);

  // Query all of marks balances across chains
  logger.info('Getting mark balances', { requestId, chains: Object.keys(config.chains) });
  const balances = await getMarkBalances(config);
  logBalanceThresholds(balances, config, logger);
  logger.debug('Retrieved balances', { requestId, balances: jsonifyMap(balances) });

  // Query all of marks gas balances across chains
  logger.info('Getting mark gas balances', { requestId, chains: Object.keys(config.chains) });
  const gas = await getMarkGasBalances(config);
  logGasThresholds(gas, config, logger);
  logger.debug('Retrieved gas balances', { requestId, balances: jsonifyMap(gas) });

  // Get existing purchase actions
  const cachedPurchases = await cache.getAllPurchases();

  // Remove cached purchases that no longer apply to an invoice.
  const invoiceIds = invoices.map(({ intent_id }) => intent_id);
  const toRemove = cachedPurchases
    .filter((purchase) => {
      return !invoiceIds.includes(purchase.target.intent_id);
    })
    .map(({ target }) => target.intent_id);

  const pendingPurchases = cachedPurchases.filter(({ target }) => invoiceIds.includes(target.intent_id));
  try {
    await cache.removePurchases(toRemove);
    logger.info('Removed stale purchases', { requestId, toRemove });
  } catch (e) {
    logger.warn('Failed to clear pending cache', { requestId, error: jsonifyError(e, { toRemove }) });
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
    });

  // Process each ticker group. Goal is to process the first invoice in each queue.
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
          });
          return undefined;
        }
        return i;
      })
      .filter((x) => !!x);

    // Process invoices until we find one we've already purchased
    for (const invoice of toEvaluate) {
      const invoiceId = invoice.intent_id;
      // Skip entire ticker if we already have a purchase for this invoice
      if (pendingPurchases.find(({ target }) => target.intent_id === invoiceId)) {
        logger.debug('Found existing purchase, stopping ticker processing', {
          requestId,
          ticker,
          invoiceId,
          invoice: invoice,
        });
        break;
      }

      // Get the minimum amounts for invoice
      const { minAmounts } = await everclear.getMinAmounts(invoiceId);

      // For each invoice destination
      for (const [destination, minAmount] of Object(minAmounts).entries()) {
        // Check if we have sufficient balance. If not, check other destinations.
        const markBalance = balances.get(ticker)?.get(destination) ?? BigInt(0);
        if (markBalance < minAmount) {
          logger.debug('Insufficient balance for destination', {
            requestId,
            invoiceId,
            destination,
            required: minAmount.toString(),
            available: markBalance.toString(),
          });
          continue;
        }

        // Add XERC20 check here
        const isXerc20 = await isXerc20Supported(invoice.ticker_hash, [destination], config);
        if (isXerc20) {
          logger.info('XERC20 strategy enabled for destination, skipping', {
            requestId,
            invoiceId,
            destination,
            invoice,
            ticker: invoice.ticker_hash,
          });
          continue;
        }

        // If there is already a purchase created or pending with this existing destination-ticker
        // combo, we are impacting the custodied assets and invalidating the minAmounts for subsequent
        // intents in the queue so exit ticker.
        const existing = pendingPurchases.filter(
          (action) => action.target.ticker_hash === ticker && action.purchase.origin === destination,
        );
        if (existing.length > 0) {
          logger.info('Action exists for destination-ticker combo', {
            requestId,
            invoiceId,
            existingCount: existing.length,
            existing,
          });
          continue;
        }

        // Create purchase parameters
        const inputAsset = getTokenAddressFromConfig(ticker, destination, config);
        if (!inputAsset) {
          logger.error('No input asset found', { requestId, invoiceId, ticker, destination, config });
          throw new Error(`No input asset found for ticker (${ticker}) and domain (${destination}) in config.`);
        }
        const params: NewIntentParams = {
          origin: destination,
          destinations: config.supportedSettlementDomains
            .filter((domain) => domain.toString() !== destination)
            .map((s) => s.toString()),
          to: config.ownAddress,
          inputAsset,
          amount: convertHubAmountToLocalDecimals(minAmount, inputAsset, destination, config).toString(),
          callData: '0x',
          maxFee: '0',
        };

        try {
          const [{ transactionHash }] = await sendIntents(
            [params],
            { everclear, chainService, logger, cache: cache },
            config,
          );

          const purchase = {
            target: invoice,
            purchase: params,
            transactionHash,
          };
          pendingPurchases.push(purchase);

          logger.info('Created new purchase', {
            requestId,
            invoiceId: invoice.intent_id,
            purchase,
          });

          // Break to next invoice once we've made a purchase
          break;
        } catch (error) {
          logger.error('Failed to submit purchase transaction', {
            error,
            invoiceId: invoice.intent_id,
            destination,
          });
        }
      }
    }
  }

  // Store purchases in cache
  try {
    await cache.addPurchases(pendingPurchases);
    logger.info('Stored purchases in cache', { requestId, purchases: pendingPurchases });
  } catch (e) {
    logger.error('Failed to add purchases to cache', { requestId, error: jsonifyError(e, { toRemove }) });
    throw e;
  }

  logger.info('Method complete', { requestId, pendingPurchases, invoices });
}
