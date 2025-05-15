import { jsonifyError } from '@mark/logger';
import { AdminContext, HttpPaths } from '../types';
import { verifyAdminToken } from './auth';
import { PurchaseCache, RebalanceCache } from '@mark/cache';

export const handleApiRequest = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { requestId, logger, event } = context;
  if (!verifyAdminToken(context)) {
    logger.warn('Unauthorized access attempt', { requestId, event });
    return {
      statusCode: 403,
      body: JSON.stringify({ message: 'Forbidden: Invalid admin token' }),
    };
  }
  try {
    const request = extractRequest(context);
    if (!request) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: `Unknown request: ${context.event.httpMethod} ${context.event.path}` }),
      };
    }
    switch (request) {
      case HttpPaths.PausePurchase:
        await pauseIfNeeded(context.purchaseCache, context);
        break;
      case HttpPaths.PauseRebalance:
        await pauseIfNeeded(context.rebalanceCache, context);
        break;
      case HttpPaths.UnpausePurchase:
        await unpauseIfNeeded(context.purchaseCache, context);
        break;
      case HttpPaths.UnpauseRebalance:
        await unpauseIfNeeded(context.rebalanceCache, context);
        break;
      default:
        throw new Error(`Unknown request: ${request}`);
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Successfully processed request: ${request}` }),
    };
  } catch (e) {
    console.log('error', e);
    return {
      statusCode: 500,
      body: JSON.stringify(jsonifyError(e)),
    };
  }
};

const unpauseIfNeeded = async (cache: RebalanceCache | PurchaseCache, context: AdminContext) => {
  const { requestId, logger } = context;
  logger.debug('Unpausing cache', { requestId });
  if (!(await cache.isPaused())) {
    throw new Error(`Cache is not paused`);
  }
  return cache.setPause(false);
};

const pauseIfNeeded = async (cache: RebalanceCache | PurchaseCache, context: AdminContext) => {
  const { requestId, logger } = context;
  logger.debug('Pausing cache', { requestId });
  if (await cache.isPaused()) {
    throw new Error(`Cache is already paused`);
  }
  return cache.setPause(true);
};

export const extractRequest = (context: AdminContext): HttpPaths | undefined => {
  const { logger, event, requestId } = context;
  logger.debug(`Extracting request from event`, { requestId, event });

  const { path, pathParameters, httpMethod } = event;

  if (httpMethod === 'POST' && path.endsWith(HttpPaths.PausePurchase)) {
    return HttpPaths.PausePurchase;
  }

  if (httpMethod === 'POST' && path.endsWith(HttpPaths.PauseRebalance)) {
    return HttpPaths.PauseRebalance;
  }

  if (httpMethod === 'POST' && path.endsWith(HttpPaths.UnpausePurchase)) {
    return HttpPaths.UnpausePurchase;
  }

  if (httpMethod === 'POST' && path.endsWith(HttpPaths.UnpauseRebalance)) {
    return HttpPaths.UnpauseRebalance;
  }

  logger.error('Unknown path', { requestId, path, pathParameters, httpMethod });
  return undefined;
};
