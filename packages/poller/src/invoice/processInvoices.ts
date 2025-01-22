import { Logger } from '../../../adapters/logger/src';
import { EverclearAdapter } from '../../../adapters/everclear/src';
import { TransactionServiceAdapter } from '../../../adapters/txservice/src';
import { findBestDestination } from '../helpers/selectDestination';
import { markHighestLiquidityBalance } from '../helpers/balance';
import { fetchTokenAddress, getTokenAddress, MarkConfiguration, NewIntentParams, TransactionRequest } from '@mark/core';

export interface ProcessInvoicesConfig {
  batchSize: number;
  chains: string[];
}

export interface Invoice {
  amount: number;
  chainId: string;
  id: string;
  owner: string;
  destinations: string[];
  ticker_hash: string;
}

export interface ProcessInvoicesDependencies {
  everclear: EverclearAdapter;
  txService: TransactionServiceAdapter;
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
  getTokenAddress: (tickerHash: string, origin: string) => Promise<string> | string, // Add as a dependency
): Promise<boolean> {
  const { everclear, txService, logger } = deps;

  // Validate batch input
  if (!batch || batch.length === 0) {
    logger.error('Batch is empty or invalid', { batchKey });
    return false;
  }

  try {
    const origin = batch[0].destinations[0];
    const tickerHash = batch[0].ticker_hash;

    // Find the best destination
    const selectedDestination = (await findBestDestination(origin, tickerHash, config)).toString();

    // Calculate total batch amount
    const batchAmount = batch.reduce((total, invoice) => total + Number(invoice.amount), 0);

    // Throw error if batchAmount is 0
    if (batchAmount === 0) {
      throw new Error(`Batch amount is 0 for batchKey: ${batchKey}. No invoices to process.`);
    }

    // Fetch token address using DI
    const tokenAddress = await getTokenAddress(tickerHash, origin);

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
    const txHash = await txService.submitAndMonitor(transaction.chainId.toString(), {
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
  getTokenAddress: (tickerHash: string, origin: string) => Promise<string> | string,
): Promise<boolean> {
  const { everclear, txService, logger } = deps;

  try {
    const tickerHash = invoice.ticker_hash;
    const origin = (
      await markHighestLiquidityBalance(tickerHash, invoice.destinations, config, getTokenAddress)
    ).toString();

    const selectedDestination = (await findBestDestination(origin, tickerHash, config)).toString();

    const inputAsset = await getTokenAddress(tickerHash, origin);

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

    const tx = await txService.submitAndMonitor(transaction.chainId.toString(), {
      data: transaction.data,
    });

    logger.info('Invoice processed successfully', {
      invoiceId: invoice.id,
      txHash: tx,
    });

    return true;
  } catch (error) {
    logger.error('Failed to process invoice', {
      invoiceId: invoice.id,
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
  const result: ProcessInvoicesResult = {
    processed: 0,
    failed: 0,
    skipped: 0,
  };

  const batches: Record<string, Invoice[]> = {}; // Key: `${destination}_${ticker_hash}`

  for (const invoice of invoices) {
    if (!isValidInvoice(invoice)) {
      result.skipped++;
      continue;
    }

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
      const success = await processInvoice(invoice, deps, config, getTokenAddress);
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

    const success = await processInvoiceBatch(batch, deps, config, batchKey, getTokenAddress);
    if (success) {
      result.processed++;
    } else {
      result.failed++;
    }
  }

  return result;
}

export function isValidInvoice(invoice: Invoice): boolean {
  if (!invoice) {
    return false;
  }
  return (
    invoice &&
    typeof invoice.id === 'string' &&
    typeof invoice.amount === 'number' &&
    invoice.amount > 0 &&
    invoice.owner !== 'Mark wallet address'
  );
}

// Main polling function that orchestrates the process
export async function pollAndProcess(
  config: MarkConfiguration,
  deps: ProcessInvoicesDependencies,
): Promise<ProcessInvoicesResult> {
  const { everclear, logger } = deps;

  try {
    const invoices = await everclear.fetchInvoices(config.chains);
    const result = await processBatch(invoices as Invoice[], deps, config);

    logger.info('Invoice processing completed', { result });
    return result;
  } catch (error) {
    logger.error('Failed to process invoices', { error });
    throw error;
  }
}
