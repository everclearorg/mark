import { jsonifyError } from '@mark/logger';
import { AdminContext, HttpPaths } from '../types';
import { verifyAdminToken } from './auth';
import * as database from '@mark/database';
import { PurchaseCache } from '@mark/cache';

type Database = typeof database;

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
      case HttpPaths.ClearRebalance:
        throw new Error(`Fix rebalance clearing with db`);
      case HttpPaths.ClearPurchase:
        context.logger.info('Clearing purchase cache');
        await context.purchaseCache.clear();
        break;
      case HttpPaths.PausePurchase:
        await pauseIfNeeded('purchase', context.purchaseCache, context);
        break;
      case HttpPaths.PauseRebalance:
        await pauseIfNeeded('rebalance', context.database, context);
        break;
      case HttpPaths.UnpausePurchase:
        await unpauseIfNeeded('purchase', context.purchaseCache, context);
        break;
      case HttpPaths.UnpauseRebalance:
        await unpauseIfNeeded('rebalance', context.database, context);
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

const unpauseIfNeeded = async (
  type: 'rebalance' | 'purchase',
  _store: Database | PurchaseCache,
  context: AdminContext,
) => {
  if (type === 'rebalance') {
    throw new Error(`Fix rebalance pausing on db`);
  }
  const store = _store as PurchaseCache;
  const { requestId, logger } = context;
  logger.debug('Unpausing cache', { requestId });
  if (!(await store.isPaused())) {
    throw new Error(`Cache is not paused`);
  }
  return store.setPause(false);
};

const pauseIfNeeded = async (
  type: 'rebalance' | 'purchase',
  _store: Database | PurchaseCache,
  context: AdminContext,
) => {
  if (type === 'rebalance') {
    throw new Error(`Fix rebalance pausing on db`);
  }
  const store = _store as PurchaseCache;
  const { requestId, logger } = context;
  logger.debug('Pausing cache', { requestId });
  if (await store.isPaused()) {
    throw new Error(`Cache is already paused`);
  }
  return store.setPause(true);
};

export const extractRequest = (context: AdminContext): HttpPaths | undefined => {
  const { logger, event, requestId } = context;
  logger.debug(`Extracting request from event`, { requestId, event });

  const { path, pathParameters, httpMethod } = event;

  if (httpMethod !== 'POST') {
    logger.error('Unknown http method', { requestId, path, pathParameters, httpMethod });
    return undefined;
  }

  for (const httpPath of Object.values(HttpPaths)) {
    if (path.endsWith(httpPath)) {
      return httpPath as HttpPaths;
    }
  }
  logger.error('Unknown path', { requestId, path, pathParameters, httpMethod });
  return undefined;
};
