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

  // Sort invoices so oldest enqueued is first
  const invoices = _invoices.sort((a, b) => a.hub_invoice_enqueued_timestamp - b.hub_invoice_enqueued_timestamp);

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

  // Query all of the custodied amounts across chains and ticker hashes
  logger.info('Getting custodied balances', { requestId, chains: Object.keys(config.chains) });
  const custodied = await getCustodiedBalances(config);
  logger.debug('Retrieved custodied amounts', { requestId, custodied: jsonifyMap(custodied) });

  // These are the unbatched intents, i.e. the intents we would send to purchase all of the
  // invoices, grouped by origin domain
  const unbatchedIntents = new Map<string, NewIntentParams[]>();

  // Get current time to measure invoice age
  const time = Math.floor(Date.now() / 1000);

  for (const invoice of invoices) {
    const msg = isValidInvoice(invoice, config);
    if (msg) {
      logger.warn('Invalid invoice', {
        requestId,
        id: invoice.intent_id,
        invoice,
        msg,
      });
      continue;
    }

    logger.info('Evaluating purchase of invoice', {
      requestId,
      id: invoice.intent_id,
      invoice,
    });

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

    // Contracts will select the destination with the highest available liquidity to settle invoice into
    // Sort all invoice destinations by the custodied balance, then find the best match
    const custodiedTicker = custodied.get(invoice.ticker_hash) ?? new Map();
    const destinations = invoice.destinations.sort((a, b) => {
      const custodiedA = custodiedTicker.get(a) ?? 0n;
      const custodiedB = custodiedTicker.get(b) ?? 0n;
      return custodiedB > custodiedA ? 1 : custodiedB < custodiedA ? -1 : 0;
    });
    logger.info('Sorted destinations by custodied balance', {
      requestId,
      id: invoice.intent_id,
      destinations,
      unsorted: invoice.destinations,
    });

    // Calculate the true invoice amount by applying the bps
    const scaledDiscountBps = Math.round(invoice.discountBps * 10_000);
    const discountAmount = (BigInt(invoice.amount) * BigInt(scaledDiscountBps)) / BigInt(10_000 * 10_000);
    const purchaseable = BigInt(invoice.amount) - discountAmount; // multiply by 10 the RHS and dividing the whole to avoid decimals
    logger.info('Calculated purchaseable amount', {
      requestId,
      id: invoice.intent_id,
      purchaseable,
    });

    // For each destination on the invoice, find a chain where mark has balances and invoice req. deposit
    // TODO: should look at all enqueued intents for each destination that could be processed before
    // marks created intent - this can come from /economy endpoint
    for (const destination of destinations) {
      // Verify invoice is old enough to consider
      const age = time - invoice.hub_invoice_enqueued_timestamp;
      if (age < (config.chains[destination]?.invoiceAge ?? time)) {
        logger.info('Invoice not old enough to settle on this domain', {
          requestId,
          id: invoice.intent_id,
          domain: destination,
          threshold: config.chains[destination]?.invoiceAge,
          age,
          invoice,
        });
        continue;
      }

      const destinationCustodied = BigInt(custodied.get(invoice.ticker_hash.toLowerCase())?.get(destination) ?? '0');
      // If there is sufficient custodied asset, ignore invoice. should be settlable w.o intervention.
      if (purchaseable <= destinationCustodied) {
        logger.info('Sufficient custodied balance to settle invoice', {
          requestId,
          purchaseable,
          custodied: destinationCustodied,
          destination,
          tickerHash: invoice.ticker_hash,
          id: invoice.intent_id,
        });

        // Update the custodied mapping for next invoice
        const updatedCustodied = custodied.get(invoice.ticker_hash) ?? new Map<string, bigint>();
        updatedCustodied.set(destination, destinationCustodied - purchaseable);
        custodied.set(invoice.ticker_hash, updatedCustodied);
        break;
      }

      // Get marks balance on this chain
      const balance = BigInt(balances.get(invoice.ticker_hash.toLowerCase())?.get(destination) ?? '0');

      // Check to see how much is required for mark to deposit
      const requiredDeposit = purchaseable - destinationCustodied;
      if (balance < requiredDeposit) {
        logger.debug('Insufficient balance to support destination', {
          requestId,
          purchaseable,
          destinationCustodied,
          id: invoice.intent_id,
          balance,
          requiredDeposit,
          tickerHash: invoice.ticker_hash,
        });
        continue;
      }

      // Sufficient balance to settle invoice with invoice destination == intent origin
      const inputAsset = getTokenAddressFromConfig(invoice.ticker_hash, destination, config);
      if (!inputAsset) {
        throw new Error(
          `No input asset found for ticker (${invoice.ticker_hash}) and domain (${destination}) in config.`,
        );
      }
      const purchaseAction: NewIntentParams = {
        origin: destination,
        // Don't include this intent's origin domain in destinations
        destinations: config.supportedSettlementDomains
          .filter((domain) => domain.toString() !== destination)
          .map((s) => s.toString()),
        to: config.ownAddress,
        inputAsset,
        amount: requiredDeposit.toString(),
        callData: '0x',
        maxFee: '0',
      };
      logger.info('Purchasing invoice', {
        requestId,
        id: invoice.intent_id,
        invoice,
        purchaseAction,
      });

      // Push to unbatched intents
      if (!unbatchedIntents.has(destination)) {
        unbatchedIntents.set(destination, []);
      }
      unbatchedIntents.set(destination, [...unbatchedIntents.get(destination)!, purchaseAction]);

      // Decrement balances before entering into next loop
      const updatedBalance = balances.get(invoice.ticker_hash) ?? new Map<string, bigint>();
      updatedBalance.set(destination, balance - requiredDeposit);
      balances.set(invoice.ticker_hash, updatedBalance);

      // Decrement custodied before entering into next loop.
      // NOTE: because at this point you _have_ to add some amount to purchase the invoice, the
      // custodied assets must be fully consumed.
      const updatedCustodied = custodied.get(invoice.ticker_hash) ?? new Map<string, bigint>();
      updatedCustodied.set(destination, 0n);
      custodied.set(invoice.ticker_hash, updatedCustodied);

      // Exit destination loop
      break;
    }
  }

  if (unbatchedIntents.size === 0) {
    logger.info('No intents to purchase', { requestId });
    return;
  }

  // Combine all unbatched intents
  const batched = await combineIntents(unbatchedIntents, deps);
  logger.info('Purchasing invoices', {
    requestId,
    batch: jsonifyMap(batched),
  });

  // Dispatch all through transaction service
  const receipts = await sendIntents(batched, deps, config);
  logger.info('Sent transactions to purchase invoices', {
    requestId,
    receipts: receipts.map((r) => ({ chainId: r.chainId, transactionHash: r.transactionHash })),
  });
}
