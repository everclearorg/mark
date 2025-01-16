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
): Promise<boolean> {
  const { everclear, txService, logger } = deps;

  // batch here is same destination and same ticker hash

  // construct new transaction data using `newIntent` endpoint here

  const intentDestination = await findBestDestination(batch[0].destinations[0], batch[0].ticker_hash);

  try {
    // Create and submit transaction

    // add a logic for batching
    const tx = await txService.submitAndMonitor(invoice.chainId, {
      data: '0x',
    });

    // Update invoice status
    // await everclear.updateInvoiceStatus(invoice.id, 'processed');

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

    // Check if the invoice has exactly one destination
    if (invoice.destinations.length === 1) {
      const batchKey = `${invoice.destinations[0]}_${invoice.ticker_hash}`;
      if (!batches[batchKey]) {
        batches[batchKey] = [];
      }
      batches[batchKey].push(invoice);
    } else {
      // directly process those invoice based on liq available

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

    const success = await processInvoiceBatch(batch, deps, config);
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
