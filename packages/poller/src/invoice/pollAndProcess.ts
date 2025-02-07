import { MarkConfiguration } from '@mark/core';
import { ChainService } from '@mark/chainservice';
import { EverclearAdapter } from '@mark/everclear';
import { Logger } from '@mark/logger';
import { processInvoices } from './processInvoices';
import { PurchaseCache } from '@mark/cache';

export interface ProcessInvoicesDependencies {
  everclear: EverclearAdapter;
  chainService: ChainService;
  logger: Logger;
  cache: PurchaseCache;
}

export async function pollAndProcess(config: MarkConfiguration, deps: ProcessInvoicesDependencies): Promise<void> {
  const { everclear, logger, chainService, cache } = deps;

  try {
    const invoices = await everclear.fetchInvoices(config.chains);
    await processInvoices({
      invoices,
      everclear,
      logger,
      chainService,
      cache,
      config,
    });
  } catch (_error: unknown) {
    const error = _error as Error;
    logger.error('Failed to process invoices', { message: error.message, stack: error.stack, name: error.name });
    throw error;
  }
}
