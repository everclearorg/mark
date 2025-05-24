import { TransactionReceipt } from 'viem';
import { ProcessingContext } from '../init';
import { jsonifyError } from '@mark/logger';
import { getValidatedZodiacConfig } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';

export const executeDestinationCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, rebalanceCache, config, rebalance, chainService } = context;
  logger.info('Executing destination callbacks', { requestId });

  // Get all actions from the cache
  const existingActions = await rebalanceCache.getRebalances({ routes: config.routes });
  logger.debug('Found existing rebalance actions', { routes: config.routes, actions: existingActions });

  // For each action
  for (const action of existingActions) {
    const route = { asset: action.asset, destination: action.destination, origin: action.origin };
    const logContext = { requestId, action };

    // Get the proper adapter that sent the action
    const adapter = rebalance.getAdapter(action.bridge);

    // get the transaction receipt from origin chain
    let receipt;
    try {
      receipt = await chainService.getTransactionReceipt(action.origin, action.transaction);
    } catch (e) {
      logger.error('Failed to determine if destination action required', { ...logContext, error: jsonifyError(e) });
      // Move on to the next action to avoid blocking
      continue;
    }

    if (!receipt) {
      logger.info('Origin transaction receipt not found for action', logContext);
      continue;
    }

    // check if it is ready on the destination
    try {
      const required = await adapter.readyOnDestination(action.amount, route, receipt as unknown as TransactionReceipt);
      if (!required) {
        logger.info('Action is not ready to execute callback', { ...logContext, receipt, required });
        continue;
      }
    } catch (e: unknown) {
      logger.error('Failed to determine if destination action required', { ...logContext, error: jsonifyError(e) });
      // Move on to the next action to avoid blocking
      continue;
    }

    // Destination callback is required
    let callback;
    try {
      callback = await adapter.destinationCallback(route, receipt as unknown as TransactionReceipt);
    } catch (e: unknown) {
      logger.error('Failed to retrieve destination action required', { ...logContext, error: jsonifyError(e) });
      // Move on to the next action to avoid blocking
      continue;
    }

    if (!callback) {
      logger.info('No destination callback transaction returned', logContext);
      await rebalanceCache.removeRebalances([action.id]);
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
          to: callback.to!,
          data: callback.data!,
          value: callback.value || 0,
          from: config.ownAddress,
        },
        zodiacConfig,
        context: { ...logContext, callbackType: 'destination' },
      });

      logger.info('Successfully submitted destination callback', {
        ...logContext,
        callback,
        receipt,
        destinationTx: tx.transactionHash,
        useZodiac: zodiacConfig.isEnabled,
      });

      await rebalanceCache.removeRebalances([action.id]);
    } catch (e) {
      logger.error('Failed to execute destination action', {
        ...logContext,
        callback,
        receipt,
        error: jsonifyError(e),
      });
      // Move on to the next action to avoid blocking
      continue;
    }
  }
};
