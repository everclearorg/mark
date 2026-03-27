import { ChainService, TransactionReceipt } from '@mark/chainservice';
import { LoggingContext, TransactionSubmissionType, TransactionRequest, WalletConfig, isEvmChain } from '@mark/core';
import { wrapTransactionWithZodiac } from './zodiac';
import { Logger } from '@mark/logger';
import type { InventoryServiceClient, NonceAssignment } from '@mark/inventory';

export interface TransactionSubmissionParams {
  chainService: ChainService;
  logger: Logger;
  chainId: string;
  txRequest: TransactionRequest;
  zodiacConfig: WalletConfig;
  context?: LoggingContext; // For logging context
  inventory?: InventoryServiceClient; // Optional: unified inventory service for nonce management
  walletAddress?: string; // Wallet address for nonce management (required if inventory is provided)
  operationId?: string; // Operation ID for nonce tracking
}

export interface TransactionSubmissionResult {
  submissionType: TransactionSubmissionType;
  hash: string; // unique identifier for the transaction, could be safe hash or transaction hash
  receipt?: TransactionReceipt; // The actual receipt type from chainService
  nonceAssignment?: NonceAssignment; // Nonce assigned by inventory service (if used)
}

/**
 * Submits a transaction with consistent logging, nonce management, and result reporting.
 *
 * When an inventory service client is provided:
 * 1. Acquires a nonce from the inventory service before submission
 * 2. Reports nonce confirmation on success (with tx hash)
 * 3. Reports nonce failure on error
 *
 * Falls back to chain service nonce management if inventory service is unavailable.
 */
export async function submitTransactionWithLogging(
  params: TransactionSubmissionParams,
): Promise<TransactionSubmissionResult> {
  const {
    chainService,
    logger,
    chainId,
    txRequest,
    zodiacConfig,
    context = {},
    inventory,
    walletAddress,
    operationId,
  } = params;

  // Prepare the transaction (wrap with Zodiac if needed)
  const preparedTx = isEvmChain(chainId)
    ? await wrapTransactionWithZodiac({ ...txRequest, chainId: +params.chainId }, zodiacConfig)
    : txRequest;

  // Acquire nonce from inventory service if available
  let nonceAssignment: NonceAssignment | undefined;
  if (inventory && walletAddress && isEvmChain(chainId)) {
    nonceAssignment = await inventory.assignNonce(chainId, walletAddress, operationId);
    if (nonceAssignment) {
      logger.info('Acquired nonce from inventory service', {
        ...context,
        chainId,
        nonce: nonceAssignment.nonce,
        nonceId: nonceAssignment.nonceId,
      });
      // Attach nonce to the transaction request (TransactionRequest.nonce is a string)
      preparedTx.nonce = nonceAssignment.nonce.toString();
    } else {
      logger.debug('Inventory service nonce unavailable, using chain service nonce', {
        ...context,
        chainId,
      });
    }
  }

  logger.info('Submitting transaction', {
    ...context,
    chainId,
    to: preparedTx.to,
    walletType: zodiacConfig.walletType,
    originalTo: txRequest.to,
    value: preparedTx.value?.toString() || '0',
    funcSig: preparedTx.funcSig,
    nonce: nonceAssignment?.nonce,
  });

  try {
    const receipt = await chainService.submitAndMonitor(chainId, preparedTx);

    logger.info('Transaction submitted successfully', {
      ...context,
      chainId,
      transactionHash: receipt.transactionHash,
      walletType: zodiacConfig.walletType,
      nonce: nonceAssignment?.nonce,
    });

    // Report nonce confirmation to inventory service
    if (nonceAssignment && inventory && walletAddress) {
      await inventory.confirmNonce(chainId, walletAddress, nonceAssignment.nonce, receipt.transactionHash);
    }

    return {
      submissionType: TransactionSubmissionType.Onchain,
      hash: receipt.transactionHash,
      receipt,
      nonceAssignment,
    };
  } catch (error) {
    logger.error('Transaction submission failed', {
      ...context,
      chainId,
      error,
      txRequest: preparedTx,
      walletType: zodiacConfig.walletType,
      nonce: nonceAssignment?.nonce,
    });

    // Report nonce failure to inventory service
    if (nonceAssignment && inventory && walletAddress) {
      await inventory.failNonce(chainId, walletAddress, nonceAssignment.nonce);
    }

    throw error;
  }
}
