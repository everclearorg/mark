import { processInvoices } from './processInvoices';
import { ProcessingContext } from '../init';
import { jsonifyError } from '@mark/logger';

export async function pollAndProcessInvoices(context: ProcessingContext): Promise<void> {
  const { config, everclear, logger, requestId } = context;

  try {
    const invoices = await everclear.fetchInvoices(config.chains);

    if (invoices.length === 0) {
      logger.info('No invoices to process', { requestId });
      return;
    }

    await processInvoices(context, invoices);
    logger.info('Successfully processed invoices', { requestId });
  } catch (_error: unknown) {
    const error = _error as Error;
    logger.error('Failed to process invoices', { error: jsonifyError(error, { requestId }) });
    throw error;
  }
}
