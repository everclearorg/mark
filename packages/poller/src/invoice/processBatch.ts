import { MarkConfiguration, NewIntentParams, getTokenAddressFromConfig } from '@mark/core';
import { Invoice } from '@mark/everclear';
import { ProcessInvoicesDependencies } from './pollAndProcess';
import { isValidInvoice } from './validation';
import {
  combineIntents,
  getCustodiedBalances,
  getMarkBalances,
  getMarkGasBalances,
  isXerc20Supported,
  logBalanceThresholds,
  logGasThresholds,
  convertHubAmountToLocalDecimals,
  sendIntents,
} from '../helpers';
import { jsonifyMap } from '@mark/logger';
import { hexlify, randomBytes } from 'ethers/lib/utils';

export async function processBatch(
  _invoices: Invoice[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<void> {
  const { logger } = deps;
  const requestId = hexlify(randomBytes(32));

  // Sort invoices so newest enqueued is first
  const invoices = _invoices.sort((a, b) => b.hub_invoice_enqueued_timestamp - a.hub_invoice_enqueued_timestamp);

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

  // Get current time to measure invoice age
  const time = Math.floor(Date.now() / 1000);

  // Grouped valid invoices by ticker-destination combo
  const invoicesByTickerDest = new Map<string, Invoice[]>();

  // These are the intents we'll send to purchase invoices
  const intents: NewIntentParams[] = [];

  // Track already handled invoices
  const handledInvoices = new Set<string>();

  // Construct the invoicesByTickerDest map
  for (const invoice of invoices) {
    const msg = isValidInvoice(invoice, config, time);
    if (msg) {
      logger.warn('Invalid invoice', {
        requestId,
        id: invoice.intent_id,
        invoice,
        msg,
      });
      continue;
    }

    // Check to see if any of the destinations on the invoice support xerc20 for ticker
    if (await isXerc20Supported(invoice.ticker_hash, invoice.destinations, config)) {
      logger.info('XERC20 supported for ticker on valid destination', {
        requestId,
        id: invoice.intent_id,
        destinations: invoice.destinations,
        ticker: invoice.ticker_hash,
      });
      continue;
    }

    const tickerHash = invoice.ticker_hash.toLowerCase();
    invoice.destinations.forEach((dest) => {
      const tickerDest = `${tickerHash}-${dest}`;
      if (!invoicesByTickerDest.has(tickerDest)) {
        invoicesByTickerDest.set(tickerDest, []);
      }
      invoicesByTickerDest.get(tickerDest)!.push(invoice);
    });
  }

  // Process each ticker-destination group of invoices
  for (const [tickerDest, invoices] of invoicesByTickerDest) {
    const [tickerHash, destination] = tickerDest.split('-');
    // Try each invoice as the target invoice, starting from newest
    for (const invoice of invoices) {
      if (handledInvoices.has(invoice.intent_id)) {
        continue;
      }

      // Get min amounts for this invoice (includes amounts for all prior invoices)
      const minAmountsResponse = await deps.everclear.getMinAmounts(invoice.intent_id);
      logger.debug('Retrieved min amounts', {
        requestId,
        id: invoice.intent_id,
        minAmounts: minAmountsResponse,
      });

      // Get required amount and adjust for any handled invoices
      let minAmount = BigInt(minAmountsResponse.minAmounts[destination] || '0');
      if (minAmount === 0n) continue;

      // Subtract amounts for already handled prior invoices
      for (const priorInvoice of invoices) {
        if (!handledInvoices.has(priorInvoice.intent_id)) {
          // not handled
          continue;
        }
        if (priorInvoice.hub_invoice_enqueued_timestamp > invoice.hub_invoice_enqueued_timestamp) {
          // prior invoice is newer, not doesnt impact liquidity
          continue;
        }
        // Subtract the discounted amount for this invoice
        const discountedAmount = (BigInt(priorInvoice.amount) * BigInt(10000 - priorInvoice.discountBps)) / 10000n;
        minAmount -= discountedAmount;
      }

      if (minAmount <= 0n) continue;

      // Check if Mark has sufficient balance
      const balance = BigInt(balances.get(tickerHash)?.get(destination) ?? '0');
      if (balance >= minAmount) {
        const inputAsset = getTokenAddressFromConfig(tickerHash, destination, config);
        if (!inputAsset) {
          throw new Error(`No input asset found for ticker (${tickerHash}) and domain (${destination}) in config.`);
        }

        const purchaseAction: NewIntentParams = {
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

        intents.push(purchaseAction);

        // Update balances
        balances.get(tickerHash)!.set(destination, balance - minAmount);

        // Flag all invoices up to this one as handled
        for (const priorInvoice of invoices) {
          if (priorInvoice.hub_invoice_enqueued_timestamp <= invoice.hub_invoice_enqueued_timestamp) {
            handledInvoices.add(priorInvoice.intent_id);
          }
        }

        logger.debug('Created intent for invoice group', {
          requestId,
          targetInvoice: invoice.intent_id,
          destination,
          minAmount: minAmount.toString(),
          handledInvoices: Array.from(handledInvoices),
        });

        // Break out of the loop for this destination since we've handled all invoices up to this point
        break;
      }
    }
  }

  if (intents.length === 0) {
    logger.info('No intents to purchase', { requestId });
    return;
  }

  logger.info('Purchasing invoices', {
    requestId,
    intents: intents.map((i) => ({
      origin: i.origin,
      amount: i.amount,
      inputAsset: i.inputAsset,
    })),
  });

  // Dispatch all through transaction service
  const receipts = await sendIntents(intents, deps, config);
  logger.info('Sent transactions to purchase invoices', {
    requestId,
    receipts: receipts.map((r) => ({ chainId: r.chainId, transactionHash: r.transactionHash })),
  });
}
