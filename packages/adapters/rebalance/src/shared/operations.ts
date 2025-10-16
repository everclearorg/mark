import { TransactionReceipt } from 'viem';
import { RebalanceRoute, RebalanceOperationStatus } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import * as database from '@mark/database';

/**
 * Cancel a rebalance operation due to an error (e.g., insufficient funds)
 * @param db - Database instance
 * @param logger - Logger instance
 * @param route - Rebalance route
 * @param originTransaction - Origin transaction receipt
 * @param error - Error that triggered the cancellation
 */
export async function cancelRebalanceOperation(
  db: typeof database,
  logger: Logger,
  route: RebalanceRoute,
  originTransaction: TransactionReceipt,
  error: Error,
): Promise<void> {
  try {
    // Get the rebalance operation
    const op = await db.getRebalanceOperationByTransactionHash(originTransaction.transactionHash, route.origin);
    if (!op) {
      logger.warn('Cannot cancel rebalance operation: operation not found', {
        transactionHash: originTransaction.transactionHash,
        route,
        error: error.message,
      });
      return;
    }

    // Check if operation can be canceled
    if (!['pending', 'awaiting_callback'].includes(op.status)) {
      logger.warn('Cannot cancel rebalance operation: invalid status', {
        operationId: op.id,
        currentStatus: op.status,
        transactionHash: originTransaction.transactionHash,
        route,
        error: error.message,
      });
      return;
    }

    // Cancel the operation
    await db.updateRebalanceOperation(op.id, {
      status: RebalanceOperationStatus.CANCELLED,
      isOrphaned: op.earmarkId ? true : op.isOrphaned,
    });

    logger.info('Rebalance operation cancelled', {
      operationId: op.id,
      transactionHash: originTransaction.transactionHash,
      route,
      previousStatus: op.status,
      error: error.message,
    });
  } catch (cancelError) {
    logger.error('Failed to cancel rebalance operation', {
      error: jsonifyError(cancelError),
      transactionHash: originTransaction.transactionHash,
      route,
      originalError: error.message,
    });
  }
}
