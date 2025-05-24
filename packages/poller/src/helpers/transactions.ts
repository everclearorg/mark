import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { ZodiacConfig, wrapTransactionWithZodiac, TransactionRequest } from './zodiac';

export interface TransactionSubmissionParams {
  chainService: ChainService;
  logger: Logger;
  chainId: string;
  txRequest: TransactionRequest;
  zodiacConfig: ZodiacConfig;
  context?: any; // For logging context
}

export interface TransactionSubmissionResult {
  transactionHash: string;
  receipt: any; // The actual receipt type from chainService
}

/**
 * Submits a transaction with consistent logging and error handling
 */
export async function submitTransactionWithLogging(
  params: TransactionSubmissionParams
): Promise<TransactionSubmissionResult> {
  const { chainService, logger, chainId, txRequest, zodiacConfig, context = {} } = params;

  // Prepare the transaction (wrap with Zodiac if needed)
  const preparedTx = wrapTransactionWithZodiac(txRequest, zodiacConfig);

  logger.info('Submitting transaction', {
    ...context,
    chainId,
    to: preparedTx.to,
    useZodiac: zodiacConfig.isEnabled,
    originalTo: txRequest.to,
    value: preparedTx.value?.toString() || '0',
  });

  try {
    const receipt = await chainService.submitAndMonitor(chainId, preparedTx);

    logger.info('Transaction submitted successfully', {
      ...context,
      chainId,
      transactionHash: receipt.transactionHash,
      useZodiac: zodiacConfig.isEnabled,
    });

    return {
      transactionHash: receipt.transactionHash,
      receipt,
    };
  } catch (error) {
    logger.error('Transaction submission failed', {
      ...context,
      chainId,
      error,
      txRequest: preparedTx,
      useZodiac: zodiacConfig.isEnabled,
    });
    throw error;
  }
} 