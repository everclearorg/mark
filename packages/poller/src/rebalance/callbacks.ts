import { ProcessingContext } from '../init';
import { jsonifyError } from '@mark/logger';

export const executeDestinationCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, rebalanceCache, config, rebalance, chainService } = context;
  logger.info('Starting to rebalance inventory', { requestId });

  // Get all actions from the cache
  const existingActions = await rebalanceCache.getRebalances({ routes: config.routes });

  // For each action
  for (const action of existingActions) {
    const route = { asset: action.asset, destination: action.destination, origin: action.origin };
    // get the proper adapter that sent the action
    const adapter = rebalance.getAdapter(action.bridge);

    // get the transaction receipt from origin chain
    let receipt;
    try {
      receipt = await chainService.getTransactionReceipt(action.origin, action.transaction);
    } catch (e) {
      logger.error('Failed to determine if destination action required', { requestId, action, error: jsonifyError(e) });
      // Move on to the next action to avoid blocking
      continue;
    }

    if (!receipt) {
      logger.info('Origin transaction receipt not found for action', { requestId, action });
      continue;
    }

    // check if it is ready on the destination
    try {
      const required = await adapter.readyOnDestination(action.amount, route, receipt);
      if (!required) {
        logger.info('No destination callback action required', { requestId, action, receipt, required });
        await rebalanceCache.removeRebalances([action.id]);
        continue;
      }
    } catch (e: unknown) {
      logger.error('Failed to determine if destination action required', { requestId, action, error: jsonifyError(e) });
      // Move on to the next action to avoid blocking
      continue;
    }

    // Destination callback is required
    let callback;
    try {
      callback = await adapter.destinationCallback(route, receipt);
    } catch (e: unknown) {
      logger.error('Failed to retrieve destination action required', { requestId, action, error: jsonifyError(e) });
      // Move on to the next action to avoid blocking
      continue;
    }
    if (!callback) {
      logger.info('No destination callback transaction returned', { requestId, action, receipt });
      await rebalanceCache.removeRebalances([action.id]);
      continue;
    }
    logger.info('Retrieved destination callback', { requestId, action, callback, receipt });

    // Try to execute the destination callback
    try {
      const tx = await chainService.submitAndMonitor(route.destination.toString(), callback);
      logger.info('Successfully submitted destination callback', {
        requestId,
        action,
        callback,
        receipt,
        destinationTx: tx.transactionHash,
      });
      await rebalanceCache.removeRebalances([action.id]);
    } catch (e) {
      logger.error('Failed to execute destination action', {
        requestId,
        action,
        callback,
        receipt,
        error: jsonifyError(e),
      });
      // Move on to the next action to avoid blocking
      continue;
    }
  }
};
