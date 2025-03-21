import { processInvoices } from './processInvoices';
import { ProcessingContext } from '../init';

export async function pollAndProcess(context: ProcessingContext): Promise<void> {
  const { config, everclear, logger, requestId } = context;

  try {
    const invoices = await everclear.fetchInvoices(config.chains);

    if (invoices.length === 0) {
      logger.info('No invoices to process', { requestId });
      return;
    }

    await processInvoices(context, invoices);
  } catch (_error: unknown) {
    const error = _error as Error;
    logger.error('Failed to process invoices', {
      requestId,
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    throw error;
  }
}
