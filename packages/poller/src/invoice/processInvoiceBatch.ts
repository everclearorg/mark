import { Invoice, ProcessInvoicesDependencies } from './processInvoices';
import { MarkConfiguration, NewIntentParams, TransactionRequest } from '@mark/core';
import { findBestDestination } from '../helpers/selectDestination';

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

    console.log('is falling here baby?', error);
    return false;
  }
}
