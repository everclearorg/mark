import { MarkConfiguration } from '@mark/core';
import { Invoice } from '@mark/everclear';
import { ProcessInvoicesDependencies, ProcessInvoicesResult } from './processInvoices';
import { processBatch } from './processBatch';

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
