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

  // Track custodied amounts that will result from our batched intents
  const pendingCustodied = new Map<string, Map<string, bigint>>();

  // Initialize pending custodied tracking from current custodied balances
  for (const [ticker, domainMap] of custodied.entries()) {
    pendingCustodied.set(ticker, new Map(domainMap));
  }

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

    // Verify invoice is old enough to consider
    const age = time - invoice.hub_invoice_enqueued_timestamp;
    const minAge = config.chains[invoice.destinations[0]]?.invoiceAge ?? 3600;
    if (age < minAge) {
      logger.warn('Invoice too old', {
        requestId,
        id: invoice.intent_id,
        age,
        minAge,
        timestamp: invoice.hub_invoice_enqueued_timestamp,
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

    // Get min amounts required for each destination
    const minAmountsResponse = await deps.everclear.getMinAmounts(invoice.intent_id);
    logger.debug('Retrieved min amounts', {
      requestId,
      id: invoice.intent_id,
      minAmounts: minAmountsResponse,
    });

    // Find best destination based on mark's balances and min amounts required
    let selectedDestination: string | null = null;
    let requiredDeposit: bigint | null = null;

    for (const destination of invoice.destinations) {
      const minAmount = BigInt(minAmountsResponse.minAmounts[destination] || '0');

      // Invoice will be settled, do nothing
      if (minAmount === 0n) continue;

      const balance = BigInt(balances.get(invoice.ticker_hash.toLowerCase())?.get(destination) ?? '0');
      const pendingCustodiedAmount = pendingCustodied.get(invoice.ticker_hash.toLowerCase())?.get(destination) ?? 0n;

      // Check if we have sufficient balance after accounting for pending custodied amounts
      // Mark will select the first destination that has sufficient balance right now
      if (balance >= minAmount + pendingCustodiedAmount) {
        selectedDestination = destination;
        requiredDeposit = minAmount;
        break;
      }
    }

    if (!selectedDestination || !requiredDeposit) {
      logger.debug('No suitable destination found with sufficient balance', {
        requestId,
        id: invoice.intent_id,
      });
      continue;
    }

    // Update pending custodied amounts
    const tickerHash = invoice.ticker_hash.toLowerCase();
    if (!pendingCustodied.has(tickerHash)) {
      pendingCustodied.set(tickerHash, new Map());
    }
    const domainMap = pendingCustodied.get(tickerHash)!;
    const currentAmount = domainMap.get(selectedDestination) ?? 0n;
    domainMap.set(selectedDestination, currentAmount + requiredDeposit);

    logger.debug('Updated pending custodied amounts', {
      requestId,
      id: invoice.intent_id,
      destination: selectedDestination,
      currentAmount: currentAmount.toString(),
      newAmount: (currentAmount + requiredDeposit).toString(),
    });

    // Create purchase action
    const inputAsset = getTokenAddressFromConfig(invoice.ticker_hash, selectedDestination, config);
    if (!inputAsset) {
      throw new Error(
        `No input asset found for ticker (${invoice.ticker_hash}) and domain (${selectedDestination}) in config.`,
      );
    }

    const purchaseAction: NewIntentParams = {
      origin: selectedDestination,
      destinations: config.supportedSettlementDomains
        .filter((domain) => domain.toString() !== selectedDestination)
        .map((s) => s.toString()),
      to: config.ownAddress,
      inputAsset,
      amount: requiredDeposit.toString(),
      callData: '0x',
      maxFee: '0',
    };

    // Add to unbatched intents
    if (!unbatchedIntents.has(selectedDestination)) {
      unbatchedIntents.set(selectedDestination, []);
    }
    unbatchedIntents.set(selectedDestination, [...unbatchedIntents.get(selectedDestination)!, purchaseAction]);

    // Update balances
    const updatedBalance = balances.get(invoice.ticker_hash) ?? new Map<string, bigint>();
    updatedBalance.set(selectedDestination, BigInt(updatedBalance.get(selectedDestination) ?? '0') - requiredDeposit);
    balances.set(invoice.ticker_hash, updatedBalance);
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
