import { MarkConfiguration } from '@mark/core';
import { processBatch } from './processBatch';
import { ChainService } from '@mark/chainservice';
import { EverclearAdapter } from '@mark/everclear';
import { Logger } from '@mark/logger';

export interface ProcessInvoicesDependencies {
  everclear: EverclearAdapter;
  chainService: ChainService;
  logger: Logger;
}

export async function pollAndProcess(config: MarkConfiguration, deps: ProcessInvoicesDependencies): Promise<void> {
  const { everclear, logger } = deps;

  try {
    const invoices = await everclear.fetchInvoices(config.chains);
    await processBatch(invoices, deps, config);
  } catch (_error: unknown) {
    const error = _error as Error;
    // console.log('error:', error);
    logger.error('Failed to process invoices', { message: error.message, stack: error.stack, name: error.name });
    throw error;
  }
}
