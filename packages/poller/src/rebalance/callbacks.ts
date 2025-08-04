import { TransactionReceipt } from 'viem';
import { ProcessingContext } from '../init';
import { jsonifyError } from '@mark/logger';
import { getValidatedZodiacConfig } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { RebalanceOperationStatus, SupportedBridge } from '@mark/core';

// Type for the txHashes JSON field that matches database schema
interface TxHashes {
  originTxHash?: string;
  destinationTxHash?: string;
  [key: string]: string | undefined;
}

export const executeDestinationCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, config, rebalance, chainService, database: db } = context;
  logger.info('Executing destination callbacks', { requestId });

  // Get all pending operations from database
  const operations = await db.getRebalanceOperations({
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  logger.debug('Found rebalance operations', {
    count: operations.length,
    requestId,
    statuses: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    if (!operation.bridge) {
      logger.warn('Operation missing bridge type', logContext);
      continue;
    }
    const adapter = rebalance.getAdapter(operation.bridge as SupportedBridge);

    // Get origin transaction hash from JSON field
    const txHashes = operation.txHashes as TxHashes | null;
    const originTxHash = txHashes?.originTxHash;
    if (!originTxHash) {
      logger.warn('Operation missing origin transaction hash', logContext);
      continue;
    }

    // Get the transaction receipt from origin chain
    let receipt;
    try {
      receipt = await chainService.getTransactionReceipt(operation.originChainId, originTxHash);
    } catch (e) {
      logger.error('Failed to get transaction receipt', { ...logContext, error: jsonifyError(e) });
      continue;
    }

    if (!receipt) {
      logger.info('Origin transaction receipt not found for operation', logContext);
      continue;
    }

    const route = {
      origin: operation.originChainId,
      destination: operation.destinationChainId,
      asset: operation.tickerHash,
    };

    // Check if ready for callback
    if (operation.status === RebalanceOperationStatus.PENDING) {
      try {
        const ready = await adapter.readyOnDestination(
          operation.amount,
          route,
          receipt as unknown as TransactionReceipt,
        );
        if (ready) {
          // Update status to awaiting callback
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
          });
          logger.info('Operation ready for callback, updated status', {
            ...logContext,
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
          });

          // Update the operation object for further processing
          operation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        } else {
          logger.info('Action not ready for destination callback', logContext);
        }
      } catch (e: unknown) {
        logger.error('Failed to check if ready on destination', { ...logContext, error: jsonifyError(e) });
        continue;
      }
    }

    // Execute callback if awaiting
    if (operation.status === RebalanceOperationStatus.AWAITING_CALLBACK) {
      let callback;
      try {
        callback = await adapter.destinationCallback(route, receipt as unknown as TransactionReceipt);
      } catch (e: unknown) {
        logger.error('Failed to retrieve destination callback', { ...logContext, error: jsonifyError(e) });
        continue;
      }

      if (!callback) {
        // No callback needed, mark as completed
        logger.info('No destination callback required, marking as completed', logContext);
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
        });
        continue;
      }

      logger.info('Retrieved destination callback', { ...logContext, callback, receipt });

      // Check for Zodiac configuration on destination chain
      const destinationChainConfig = config.chains[route.destination];
      const zodiacConfig = getValidatedZodiacConfig(destinationChainConfig, logger, {
        ...logContext,
        destination: route.destination,
      });

      // Try to execute the destination callback
      try {
        const tx = await submitTransactionWithLogging({
          chainService,
          logger,
          chainId: route.destination.toString(),
          txRequest: {
            chainId: +route.destination,
            to: callback.transaction.to!,
            data: callback.transaction.data!,
            value: (callback.transaction.value || 0).toString(),
            from: config.ownAddress,
          },
          zodiacConfig,
          context: { ...logContext, callbackType: `destination: ${callback.memo}` },
        });

        logger.info('Successfully submitted destination callback', {
          ...logContext,
          callback,
          receipt,
          destinationTx: tx.hash,
          walletType: zodiacConfig.walletType,
        });

        // Update operation as completed with destination tx hash
        const currentTxHashes = (operation.txHashes as TxHashes) || {};
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
          txHashes: { ...currentTxHashes, destinationTxHash: tx.hash },
        });
      } catch (e) {
        logger.error('Failed to execute destination callback', {
          ...logContext,
          callback,
          receipt,
          error: jsonifyError(e),
        });
        continue;
      }
    }
  }

  // Mark PENDING/AWAITING_CALLBACK ops >24 hours since creation as EXPIRED
  try {
    await db.queryWithClient(
      `
      UPDATE rebalance_operations
      SET status = $1, "updatedAt" = NOW()
      WHERE status = ANY($2)
      AND "createdAt" < NOW() - INTERVAL '24 hours'
    `,
      [
        RebalanceOperationStatus.EXPIRED,
        [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
      ],
    );
  } catch (e) {
    logger.error('Failed to expire old operations', { error: jsonifyError(e), requestId });
  }
};
