import { MarkConfiguration, NewIntentParams, getTokenAddressFromConfig } from '@mark/core';
import { Invoice } from '@mark/everclear';
import { ProcessInvoicesDependencies } from './pollAndProcess';
import { isValidInvoice } from './validation';
import { combineIntents, getCustodiedBalances, getMarkBalances, isXerc20Supported, sendIntents } from '../helpers';
import { jsonifyMap } from '@mark/logger';

export async function processBatch(
  invoices: Invoice[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<void> {
  const { logger, chainService } = deps;

  // Query all of marks balances across chains
  logger.info('Getting mark balances', { chains: Object.keys(config.chains) });
  const balances = await getMarkBalances(config);
  logger.debug('Retrieved balances', { balances: jsonifyMap(balances) });

  // Query all of the custodied amounts across chains and ticker hashes
  logger.info('Getting custodied balances', { chains: Object.keys(config.chains) });
  const custodied = await getCustodiedBalances(config);
  logger.debug('Retrieved custodied amounts', { custodied: jsonifyMap(custodied) });

  // These are the unbatched intents, i.e. the intents we would send to purchase all of the
  // invoices, grouped by origin domain
  const unbatchedIntents = new Map<string, NewIntentParams[]>();

  for (const invoice of invoices) {
    if (!isValidInvoice(invoice, config)) {
      logger.info('Invalid invoice', {
        invoice,
      });
      continue;
    }

    // Check to see if any of the destinations on the invoice support xerc20 for ticker
    if (await isXerc20Supported(invoice.ticker_hash, invoice.destinations, config)) {
      logger.info('XERC20 supported for ticker on valid destination', {
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
      return custodiedB - custodiedA;
    });

    // Calculate the true invoice amount by applying the bps
    const scaledDiscountBps = Math.round(invoice.discountBps * 10_000);
    const discountAmount = (BigInt(invoice.amount) * BigInt(scaledDiscountBps)) / BigInt(10_000 * 10_000);
    const purchaseable = BigInt(invoice.amount) - discountAmount; // multiply by 10 the RHS and dividing the whole to avoid decimals

    // For each destination on the invoice, find a chain where mark has balances and invoice req. deposit
    // TODO: should look at all enqueued intents for each destination that could be processed before
    // marks created intent - this can come from /economy endpoint
    for (const destination of destinations) {
      const destinationCustodied = BigInt(custodied.get(invoice.ticker_hash.toLowerCase())?.get(destination) ?? '0');
      // If there is sufficient custodied asset, ignore invoice. should be settlable w.o intervention.
      if (purchaseable <= destinationCustodied) {
        logger.info('Sufficient custodied balance to settle invoice', {
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
        destinations: config.supportedSettlementDomains.map((s) => s.toString()),
        to: config.ownAddress,
        inputAsset,
        amount: requiredDeposit.toString(),
        callData: '0x',
        maxFee: '0',
      };
      logger.info('Purchasing invoice', {
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
    logger.info('No intents to purchase');
    return;
  }

  // Combine all unbatched intents
  const batched = await combineIntents(unbatchedIntents, deps);

  // Dispatch all through transaction service
  const receipts = await sendIntents(batched, chainService, deps, config);
  logger.info('Sent transactions to purchase invoices', {
    receipts: receipts.map((r) => ({ chainId: r.chainId, transactionHash: r.transactionHash })),
  });
}
