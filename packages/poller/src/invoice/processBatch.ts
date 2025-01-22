import { Invoice, ProcessInvoicesDependencies, ProcessInvoicesResult } from './processInvoices';
import { MarkConfiguration, getTokenAddress } from '@mark/core';
import { processInvoiceBatch } from './processInvoiceBatch';
import { isValidInvoice, processInvoice } from './processInvoices';

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
