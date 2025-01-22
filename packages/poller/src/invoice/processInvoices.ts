import { Logger } from '@mark/logger';
import { EverclearAdapter, Invoice } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { findBestDestination, markHighestLiquidityBalance, selectOrigin } from '../helpers';
import { fetchTokenAddress, getTokenAddress, MarkConfiguration, NewIntentParams, TransactionRequest } from '@mark/core';

export interface ProcessInvoicesConfig {
  batchSize: number;
  chains: string[];
}

export interface ProcessInvoicesDependencies {
  everclear: EverclearAdapter;
  chainService: ChainService;
  logger: Logger;
}

export interface ProcessInvoicesResult {
  processed: number;
  failed: number;
  skipped: number;
}

// TODO: check if invoice is settle-able with Mark's funds
export async function processInvoiceBatch(
  batch: Invoice[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
  batchKey: string,
): Promise<boolean> {
  const { everclear, chainService, logger } = deps;

  // Validate batch input
  if (!batch || batch.length === 0) {
    logger.error('Batch is empty or invalid', { batchKey });
    return false;
  }

  try {
    const origin = await selectOrigin(batch);
    const tickerHash = batch[0].ticker_hash;

    // Find the best destination
    const selectedDestination = (await findBestDestination(origin, tickerHash, config)).toString();

    // Calculate total batch amount
    const batchAmount = batch.reduce((total, invoice) => total + Number(invoice.amount), 0);

    // Throw error if batchAmount is 0
    if (batchAmount === 0) {
      throw new Error(`Batch amount is 0 for batchKey: ${batchKey}. No invoices to process.`);
    }

    const tokenAddress = fetchTokenAddress(tickerHash, origin);

    // TODO: add types here
    const params: NewIntentParams = {
      origin,
      destinations: [selectedDestination],
      to: config.ownAddress, // Use own address from config
      inputAsset: tokenAddress, // Fetch input asset from config
      amount: batchAmount,
      callData: '0x', // Default call data
      maxFee: '0', // Default max fee
    };

    // Create a new intent
    const transaction: TransactionRequest = await everclear.createNewIntent(params);

    // Submit and monitor the transaction
    const txHash = await chainService.submitAndMonitor(transaction.chainId.toString(), {
      data: transaction.data,
    });

    logger.info('Batch processed successfully', {
      batchKey,
      txHash,
    });

    return true;
  } catch (error) {
    logger.error('Failed to process batch', {
      batchKey,
      error: (error as unknown as Error).message || error,
    });
    return false;
  }
}

export async function processInvoice(
  invoice: Invoice,
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<boolean> {
  const { everclear, chainService, logger } = deps;

  try {
    const tickerHash = invoice.ticker_hash;
    // Fixed: Use `of` instead of `in`
    const origin = (
      await markHighestLiquidityBalance(tickerHash, invoice.destinations, config, getTokenAddress)
    ).toString();

    // Find the best destination
    const selectedDestination = (await findBestDestination(origin, tickerHash, config)).toString();

    const inputAsset = fetchTokenAddress(tickerHash, origin);

    const params: NewIntentParams = {
      origin,
      destinations: [selectedDestination],
      to: config.ownAddress,
      inputAsset: inputAsset,
      amount: invoice.amount,
      callData: '0x',
      maxFee: '0',
    };

    const transaction: TransactionRequest = await everclear.createNewIntent(params);

    const tx = await chainService.submitAndMonitor(transaction.chainId.toString(), {
      data: transaction.data,
    });

    logger.info('Invoice processed successfully', {
      invoiceId: invoice.intent_id,
      txHash: tx,
    });

    return true;
  } catch (error) {
    logger.error('Failed to process invoice', {
      invoiceId: invoice.intent_id,
      error,
    });
    return false;
  }
}

// Pure function to process a batch of invoices
export async function processBatch(
  invoices: Invoice[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<ProcessInvoicesResult> {
  const { logger } = deps;
  const result: ProcessInvoicesResult = {
    processed: 0,
    failed: 0,
    skipped: 0,
  };

  const batches: Record<string, Invoice[]> = {}; // Key: `${destination}_${ticker_hash}`

  if (invoices.length === 0) {
    logger.info('No invoices to process');
    return result;
  }

  // Get available balances from mark on the chains
  const balances = await getMarkBalances(config);

  for (const invoice of invoices) {
    if (!isValidInvoice(invoice, config)) {
      result.skipped++;
      continue;
    }

    // For 

    console.log('processing', invoice);

    let addedToBatch = false;

    // Group invoices with single destination directly
    if (invoice.destinations.length === 1) {
      const batchKey = `${invoice.destinations[0]}_${invoice.ticker_hash}`;
      if (!batches[batchKey]) {
        batches[batchKey] = [];
      }
      batches[batchKey].push(invoice);
      addedToBatch = true;
    } else {
      // Handle multi-destination invoices
      for (const destination of invoice.destinations) {
        const batchKey = `${destination}_${invoice.ticker_hash}`;
        if (batches[batchKey]) {
          // Add to an existing batch if a destination matches
          batches[batchKey].push(invoice);
          addedToBatch = true;
          break;
        }
      }
    }

    // If not added to any batch, process individually
    if (!addedToBatch) {
      const success = await processInvoice(invoice, deps, config);
      if (success) {
        result.processed++;
      } else {
        result.failed++;
      }
    }
  }

  // Process each batch
  for (const batchKey in batches) {
    const batch = batches[batchKey];

    const success = await processInvoiceBatch(batch, deps, config, batchKey);
    if (success) {
      result.processed++;
    } else {
      result.failed++;
    }
  }

  return result;
}

// TODO - add logging for why invoices are skipped
export function isValidInvoice(invoice: Invoice, config: MarkConfiguration): boolean {
  // Check formatting of invoice // TODO: ajv?
  const validFormat =
    invoice &&
    typeof invoice.intent_id === 'string' &&
    typeof invoice.amount === 'string' &&
    BigInt(invoice.amount) > 0;
  if (!validFormat) {
    console.log('!validFormat');
    return false;
  }

  // Check it is not our invoice
  if (invoice.owner.toLowerCase() === config.signer.toLowerCase()) {
    console.log('!owner');
    return false;
  }

  // Check that it is old enough
  const time = Math.floor(Date.now() / 1000);
  if (time - config.invoiceAge < invoice.hub_invoice_enqueued_timestamp) {
    console.log('!old', time - config.invoiceAge, invoice.hub_invoice_enqueued_timestamp);
    return false;
  }

  // Check at least one destination is supported
  const matchedDest = invoice.destinations.filter((destination) =>
    config.supportedSettlementDomains.includes(+destination),
  );
  if (matchedDest.length < 1) {
    console.log('!dest');
    return false;
  }

  // Check that the ticker hash is supported
  const tickers = Object.values(config.chains)
    .map((c) => c.assets)
    .map((c) => c.map((a) => a.tickerHash.toLowerCase()))
    .flat();
  if (!tickers.includes(invoice.ticker_hash)) {
    console.log('!tickers');
    return false;
  }

  // Valid invoice
  return true;
}

// Main polling function that orchestrates the process
export async function pollAndProcess(
  config: MarkConfiguration,
  deps: ProcessInvoicesDependencies,
): Promise<ProcessInvoicesResult> {
  const { everclear, logger } = deps;

  try {
    const invoices = await everclear.fetchInvoices(config.chains);
    const result = await processBatch(invoices, deps, config);

    logger.info('Invoice processing completed', { result });
    return result;
  } catch (error) {
    console.log('error', error);
    logger.error('Failed to process invoices', { error: JSON.stringify(error) });
    throw error;
  }
}
