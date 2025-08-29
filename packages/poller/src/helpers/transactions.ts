import { ChainService, ChainServiceTransactionReceipt } from '@mark/chainservice';
import { LoggingContext, TransactionSubmissionType, TransactionRequest } from '@mark/core';
import { Logger } from '@mark/logger';
export interface TransactionSubmissionParams {
  chainService: ChainService;
  logger: Logger;
  chainId: string;
  txRequest: TransactionRequest;
  context?: LoggingContext; // For logging context
}

export interface TransactionSubmissionResult {
  submissionType: TransactionSubmissionType;
  hash: string; // unique identifier for the transaction, could be safe hash or transaction hash
  receipt?: ChainServiceTransactionReceipt; // The actual receipt type from chainService
}

/**
 * Submits a transaction with consistent logging and error handling
 */
export async function submitTransactionWithLogging(
  params: TransactionSubmissionParams,
): Promise<TransactionSubmissionResult> {
  const { chainService, logger, chainId, txRequest: preparedTx, context = {} } = params;

  logger.info('Submitting transaction', {
    ...context,
    chainId,
    tx: preparedTx,
    value: preparedTx.value?.toString() || '0',
    funcSig: preparedTx.funcSig,
  });

  try {
    const receipt = await chainService.submitAndMonitor(chainId, preparedTx);

    logger.info('Transaction submitted successfully', {
      ...context,
      chainId,
      transactionHash: receipt.transactionHash,
    });

    return {
      submissionType: TransactionSubmissionType.Onchain,
      hash: receipt.transactionHash,
      receipt,
    };
  } catch (error) {
    logger.error('Transaction submission failed', {
      ...context,
      chainId,
      error,
      txRequest: preparedTx,
    });
    throw error;
  }
}
