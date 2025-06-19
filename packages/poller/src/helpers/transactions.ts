import { providers } from 'ethers';
import { ChainService } from '@mark/chainservice';
import { LoggingContext, TransactionSubmissionType, TransactionRequest, WalletConfig } from '@mark/core';
import { wrapTransactionWithZodiac } from './zodiac';
import { Logger } from '@mark/logger';

export interface TransactionSubmissionParams {
  chainService: ChainService;
  logger: Logger;
  chainId: string;
  txRequest: TransactionRequest;
  zodiacConfig: WalletConfig;
  context?: LoggingContext; // For logging context
}

export interface TransactionSubmissionResult {
  submissionType: TransactionSubmissionType;
  hash: string; // unique identifier for the transaction, could be safe hash or transaction hash
  receipt?: providers.TransactionReceipt; // The actual receipt type from chainService
}

/**
 * Submits a transaction with consistent logging and error handling
 */
export async function submitTransactionWithLogging(
  params: TransactionSubmissionParams,
): Promise<TransactionSubmissionResult> {
  const { chainService, logger, chainId, txRequest, zodiacConfig, context = {} } = params;

  // Prepare the transaction (wrap with Zodiac if needed)
  const preparedTx = await wrapTransactionWithZodiac({ ...txRequest, chainId: +params.chainId }, zodiacConfig);

  logger.info('Submitting transaction', {
    ...context,
    chainId,
    to: preparedTx.to,
    walletType: zodiacConfig.walletType,
    originalTo: txRequest.to,
    value: preparedTx.value?.toString() || '0',
  });

  try {
    const receipt = await chainService.submitAndMonitor(chainId, preparedTx);

    logger.info('Transaction submitted successfully', {
      ...context,
      chainId,
      transactionHash: receipt.transactionHash,
      walletType: zodiacConfig.walletType,
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
      walletType: zodiacConfig.walletType,
    });
    throw error;
  }
}
