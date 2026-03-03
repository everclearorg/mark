import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { ProcessingContext } from '../init';
import { jsonifyError } from '@mark/logger';
import { getValidatedZodiacConfig } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { getTickerForAsset } from '../helpers';
import {
  RebalanceOperationStatus,
  SupportedBridge,
  getTokenAddressFromConfig,
  serializeBigInt,
  RouteRebalancingConfig,
} from '@mark/core';
import { buildPostBridgeTransactions } from '@mark/rebalance';
import { TransactionEntry, TransactionReceipt } from '@mark/database';

export const executeDestinationCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, config, rebalance, chainService, database: db } = context;
  logger.info('Executing destination callbacks', { requestId });

  // Get all pending operations from database
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: [
      RebalanceOperationStatus.PENDING,
      RebalanceOperationStatus.AWAITING_CALLBACK,
      RebalanceOperationStatus.AWAITING_POST_BRIDGE,
    ],
  });

  logger.debug('Found rebalance operations', {
    count: operations.length,
    requestId,
    statuses: [
      RebalanceOperationStatus.PENDING,
      RebalanceOperationStatus.AWAITING_CALLBACK,
      RebalanceOperationStatus.AWAITING_POST_BRIDGE,
    ],
  });

  // Helper to find the matching route config for an operation
  const findMatchingRoute = (op: (typeof operations)[0]): RouteRebalancingConfig | undefined => {
    return config.routes.find((r) => {
      if (r.origin !== op.originChainId || r.destination !== op.destinationChainId) return false;
      const routeTicker = getTickerForAsset(r.asset, r.origin, config)?.toLowerCase();
      return routeTicker === op.tickerHash.toLowerCase();
    });
  };

  // Helper to transition to AWAITING_POST_BRIDGE or COMPLETED based on route config
  const resolvePostBridgeStatus = (matchingRoute: RouteRebalancingConfig | undefined) => {
    if (matchingRoute?.postBridgeActions?.length) {
      return RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    }
    return RebalanceOperationStatus.COMPLETED;
  };

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    // Handle AWAITING_POST_BRIDGE operations (execute post-bridge actions)
    if (operation.status === RebalanceOperationStatus.AWAITING_POST_BRIDGE) {
      const matchingRoute = findMatchingRoute(operation);
      if (!matchingRoute?.postBridgeActions?.length) {
        logger.warn('Operation awaiting post-bridge actions but no actions configured, marking completed', logContext);
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
        });
        continue;
      }

      const destinationChainConfig = config.chains[operation.destinationChainId];
      const zodiacConfig = getValidatedZodiacConfig(destinationChainConfig, logger, {
        ...logContext,
        destination: operation.destinationChainId,
      });

      try {
        logger.info('Executing post-bridge actions', {
          ...logContext,
          actionCount: matchingRoute.postBridgeActions.length,
        });

        const postBridgeTxs = await buildPostBridgeTransactions(
          config.ownAddress,
          operation.amount,
          operation.destinationChainId,
          matchingRoute.postBridgeActions,
          config.chains,
          logger,
        );

        for (const postBridgeTx of postBridgeTxs) {
          await submitTransactionWithLogging({
            chainService,
            logger,
            chainId: operation.destinationChainId.toString(),
            txRequest: {
              chainId: operation.destinationChainId,
              to: postBridgeTx.transaction.to!,
              data: postBridgeTx.transaction.data!,
              value: (postBridgeTx.transaction.value || 0).toString(),
              from: config.ownAddress,
              funcSig: postBridgeTx.transaction.funcSig || '',
            },
            zodiacConfig,
            context: { ...logContext, callbackType: `post-bridge: ${postBridgeTx.memo}` },
          });
        }

        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
        });

        logger.info('Post-bridge actions completed successfully', logContext);
      } catch (e) {
        // Leave as AWAITING_POST_BRIDGE for retry on next poll cycle
        logger.error('Failed to execute post-bridge actions, will retry', {
          ...logContext,
          error: jsonifyError(e),
        });
      }
      continue;
    }

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
        // No callback needed — check if post-bridge actions are needed
        const matchingRoute = findMatchingRoute(operation);
        const nextStatus = resolvePostBridgeStatus(matchingRoute);
        logger.info('No destination callback required', { ...logContext, nextStatus });
        await db.updateRebalanceOperation(operation.id, {
          status: nextStatus,
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
          // Check if post-bridge actions are needed
          const matchingRoute = findMatchingRoute(operation);
          const nextStatus = resolvePostBridgeStatus(matchingRoute);

          await db.updateRebalanceOperation(operation.id, {
            status: nextStatus,
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
