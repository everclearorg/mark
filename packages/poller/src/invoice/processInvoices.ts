import { Logger } from '../../../adapters/logger/src';
import { EverclearAdapter } from '../../../adapters/everclear/src';
import { TransactionServiceAdapter } from '../../../adapters/txservice/src';
import { findBestDestination } from 'src/helpers/selectDestination';

export interface ProcessInvoicesConfig {
  batchSize: number;
  chains: string[];
}

export interface Invoice {
  amount: string;
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
  config: ProcessInvoicesConfig,
  batchKey: string,
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
    const selectedDestination = await findBestDestination(origin, tickerHash, config);

    // Calculate total batch amount
    const batchAmount = batch.reduce((total, invoice) => total + Number(invoice.amount), 0);

    // Throw error if batchAmount is 0
    if (batchAmount === 0) {
      throw new Error(`Batch amount is 0 for batchKey: ${batchKey}. No invoices to process.`);
    }

    // TODO: add types here
    const params: NewIntentParams = {
      origin,
      destinations: [selectedDestination],
      to: config.ownAddress, // Use own address from config
      inputAsset: config.inputAsset, // Fetch input asset from config
      amount: batchAmount,
      callData: '0x', // Default call data
      maxFee: '0', // Default max fee
    };

    // Create a new intent
    const transaction: IntentTransaction = await everclear.createNewIntent(params);

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
      error: error.message || error,
    });
    return false;
  }
}

export async function processInvoice(invoice: Invoice, deps: ProcessInvoicesDependencies): Promise<boolean> {
  const { everclear, txService, logger } = deps;

  try {
    // Create and submit transaction
    const tx = await txService.submitAndMonitor(invoice.chainId, {
      data: '0x',
    });

    // Update invoice status
    await everclear.updateInvoiceStatus(invoice.id, 'processed');

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
  config: ProcessInvoicesConfig,
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
      const success = await processInvoice(invoice, deps);
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

// Pure function to validate an invoice
function isValidInvoice(invoice: Invoice): boolean {
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
  config: ProcessInvoicesConfig,
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
