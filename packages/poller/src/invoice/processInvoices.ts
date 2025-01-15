import { Logger } from '../../../adapters/logger/src';
import { EverclearAdapter } from '../../../adapters/everclear/src';
import { TransactionServiceAdapter } from '../../../adapters/txservice/src';

export interface ProcessInvoicesConfig {
  batchSize: number;
}

export interface Invoice {
  amount: string;
  chainId: string;
  id: string;
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
): Promise<ProcessInvoicesResult> {
  const result: ProcessInvoicesResult = {
    processed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const invoice of invoices) {
    if (!isValidInvoice(invoice)) {
      result.skipped++;
      continue;
    }

    const success = await processInvoice(invoice, deps);
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
  return invoice && typeof invoice.id === 'string' && typeof invoice.amount === 'number' && invoice.amount > 0;
}

// Main polling function that orchestrates the process
export async function pollAndProcess(
  config: ProcessInvoicesConfig,
  deps: ProcessInvoicesDependencies,
): Promise<ProcessInvoicesResult> {
  const { everclear, logger } = deps;

  try {
    const invoices = await everclear.fetchInvoices();
    const result = await processBatch(invoices as Invoice[], deps);

    logger.info('Invoice processing completed', { result });
    return result;
  } catch (error) {
    logger.error('Failed to process invoices', { error });
    throw error;
  }
}
