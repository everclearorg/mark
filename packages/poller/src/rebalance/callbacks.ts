import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { ProcessingContext } from '../init';
import { jsonifyError } from '@mark/logger';
import { getValidatedZodiacConfig } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { RebalanceOperationStatus, SupportedBridge, getTokenAddressFromConfig, serializeBigInt } from '@mark/core';
import { TransactionEntry, TransactionReceipt } from '@mark/database';

export const executeDestinationCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, config, rebalance, chainService, database: db } = context;
  logger.info('Executing destination callbacks', { requestId });

  // Get all pending operations from database
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
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
    const txHashes = operation.transactions;
    const originTx = txHashes?.[operation.originChainId] as
      | TransactionEntry<{ receipt: TransactionReceipt }>
      | undefined;
    if (!originTx) {
      logger.warn('Operation missing origin transaction', { ...logContext, operation });
      continue;
    }

    // Get the transaction receipt from origin chain
    const receipt = originTx?.metadata?.receipt;
    if (!receipt) {
      logger.info('Origin transaction receipt not found for operation', { ...logContext, operation });
      continue;
    }

    const assetAddress = getTokenAddressFromConfig(operation.tickerHash, operation.originChainId.toString(), config);

    if (!assetAddress) {
      logger.error('Could not find asset address for ticker hash', {
        ...logContext,
        tickerHash: operation.tickerHash,
        originChain: operation.originChainId,
      });
      continue;
    }

    const route = {
      origin: operation.originChainId,
      destination: operation.destinationChainId,
      asset: assetAddress,
    };

    // Check if ready for callback
    if (operation.status === RebalanceOperationStatus.PENDING) {
      try {
        const ready = await adapter.readyOnDestination(
          operation.amount,
          route,
          receipt as unknown as ViemTransactionReceipt,
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
        callback = await adapter.destinationCallback(route, receipt as unknown as ViemTransactionReceipt);
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

      logger.info('Retrieved destination callback', {
        ...logContext,
        callback: serializeBigInt(callback),
        receipt: serializeBigInt(receipt),
      });

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
            funcSig: callback.transaction.funcSig || '',
          },
          zodiacConfig,
          context: { ...logContext, callbackType: `destination: ${callback.memo}` },
        });

        logger.info('Successfully submitted destination callback', {
          ...logContext,
          callback: serializeBigInt(callback),
          receipt: serializeBigInt(receipt),
          destinationTx: tx.hash,
          walletType: zodiacConfig.walletType,
        });

        // Update operation as completed with destination tx hash
        if (!tx || !tx.receipt) {
          logger.error('Destination transaction receipt not found', { ...logContext, tx });
          continue;
        }

        try {
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.COMPLETED,
            txHashes: {
              [route.destination.toString()]: tx.receipt as TransactionReceipt,
            },
          });
        } catch (dbError) {
          logger.error('Failed to update database with destination transaction', {
            ...logContext,
            destinationTx: tx.hash,
            receipt: serializeBigInt(tx.receipt),
            error: jsonifyError(dbError),
            errorMessage: (dbError as Error)?.message,
            errorStack: (dbError as Error)?.stack,
          });
          throw dbError;
        }
      } catch (e) {
        logger.error('Failed to execute destination callback', {
          ...logContext,
          callback: serializeBigInt(callback),
          receipt: serializeBigInt(receipt),
          error: jsonifyError(e),
        });
        continue;
      }
    }
  }
};
