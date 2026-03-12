import { TransactionReceipt as ViemTransactionReceipt, maxUint256 } from 'viem';
import { ProcessingContext } from '../init';
import { jsonifyError } from '@mark/logger';
import { getValidatedZodiacConfig, getActualOwner } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { getTickerForAsset } from '../helpers';
import {
  RebalanceOperationStatus,
  SupportedBridge,
  getTokenAddressFromConfig,
  serializeBigInt,
  RouteRebalancingConfig,
  OnDemandRouteConfig,
} from '@mark/core';
import { buildTransactionsForAction } from '@mark/rebalance';
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
  const findMatchingRoute = (op: (typeof operations)[0]): RouteRebalancingConfig | OnDemandRouteConfig | undefined => {
    const match = config.routes.find((r) => {
      if (r.origin !== op.originChainId || r.destination !== op.destinationChainId) return false;
      const routeTicker = getTickerForAsset(r.asset, r.origin, config)?.toLowerCase();
      return routeTicker === op.tickerHash.toLowerCase();
    });
    if (match) return match;

    // Only fall back to on-demand routes when they have post-bridge actions configured,
    // so that operations without post-bridge needs continue to behave as before.
    return config.onDemandRoutes?.find((r) => {
      if (!r.postBridgeActions?.length) return false;
      if (r.origin !== op.originChainId || r.destination !== op.destinationChainId) return false;
      const routeTicker = getTickerForAsset(r.asset, r.origin, config)?.toLowerCase();
      return routeTicker === op.tickerHash.toLowerCase();
    });
  };

  // Helper to transition to AWAITING_POST_BRIDGE or COMPLETED based on route config
  const resolvePostBridgeStatus = (matchingRoute: RouteRebalancingConfig | OnDemandRouteConfig | undefined) => {
    if (matchingRoute?.postBridgeActions?.length) {
      return RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    }
    return RebalanceOperationStatus.COMPLETED;
  };

  // Bridge tags managed by the dedicated Aave token rebalancer — skip them here
  // so the generic handler doesn't race and mark them completed prematurely.
  const aaveTokenBridgeTags = ['stargate-amanusde', 'stargate-amansyrupusdt'];

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    // Skip operations owned by the Aave token rebalancer
    if (operation.bridge && aaveTokenBridgeTags.includes(operation.bridge)) {
      logger.debug('Skipping operation managed by Aave token rebalancer', {
        ...logContext,
        bridge: operation.bridge,
        status: operation.status,
      });
      continue;
    }

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

        const actualSender = getActualOwner(zodiacConfig, config.ownAddress);

        // Execute each action sequentially: build + execute before moving to next.
        // This allows DexSwap output to be consumed by subsequent AaveSupply.
        let currentAmount = operation.amount;

        for (let i = 0; i < matchingRoute.postBridgeActions.length; i++) {
          const action = matchingRoute.postBridgeActions[i];

          logger.info('Building transactions for post-bridge action', {
            ...logContext,
            actionIndex: i,
            actionType: action.type,
            currentAmount,
          });

          const actionTxs = await buildTransactionsForAction(
            actualSender,
            currentAmount,
            operation.destinationChainId,
            action,
            config.chains,
            logger,
            config.quoteServiceUrl,
          );

          if (actionTxs.length === 0) {
            // Action returned no transactions (e.g., DexSwap already completed on retry).
            // Use maxUint256 so subsequent actions determine amount from on-chain balance
            // via their min(balance, requestedAmount) logic, avoiding decimal mismatch.
            currentAmount = maxUint256.toString();
            logger.info('Post-bridge action returned no transactions, advancing to next action', {
              ...logContext,
              actionIndex: i,
              actionType: action.type,
            });
            continue;
          }

          for (const actionTx of actionTxs) {
            await submitTransactionWithLogging({
              chainService,
              logger,
              chainId: operation.destinationChainId.toString(),
              txRequest: {
                chainId: operation.destinationChainId,
                to: actionTx.transaction.to!,
                data: actionTx.transaction.data!,
                value: (actionTx.transaction.value ?? BigInt(0)).toString(),
                from: actualSender,
                funcSig: actionTx.transaction.funcSig || '',
              },
              zodiacConfig,
              context: { ...logContext, callbackType: `post-bridge: ${actionTx.memo}` },
            });

            // Carry forward output amount to next action
            if (actionTx.effectiveAmount) {
              currentAmount = actionTx.effectiveAmount;
            }
          }
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
            value: (callback.transaction.value ?? BigInt(0)).toString(),
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

        // Check if the callback process is complete (multi-step bridges like Zircuit may need further callbacks)
        let shouldComplete = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isCallbackComplete = (adapter as any).isCallbackComplete;
        if (typeof isCallbackComplete === 'function') {
          try {
            shouldComplete = await isCallbackComplete.call(
              adapter,
              route,
              receipt as unknown as ViemTransactionReceipt,
            );
          } catch (e) {
            logger.warn('isCallbackComplete check failed, completing as fail-safe', {
              ...logContext,
              error: jsonifyError(e),
            });
            shouldComplete = true;
          }
        }

        if (!shouldComplete) {
          logger.info('Callback submitted but process not yet complete, retaining for next iteration', logContext);
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
