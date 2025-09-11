import { jsonifyError } from '@mark/logger';
import { AdminContext, HttpPaths } from '../types';
import { verifyAdminToken } from './auth';
import * as database from '@mark/database';
import { snakeToCamel } from '@mark/database';
import { PurchaseCache } from '@mark/cache';
import { RebalanceOperationStatus, EarmarkStatus } from '@mark/core';
import { APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';

type Database = typeof database;

// Validation helper functions
function validatePagination(queryParams: APIGatewayProxyEventQueryStringParameters | null): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(parseInt(queryParams?.limit || '50'), 100);
  const offset = parseInt(queryParams?.offset || '0');
  return { limit, offset };
}

function validateEarmarkFilter(queryParams: APIGatewayProxyEventQueryStringParameters | null) {
  const filter: {
    status?: string;
    chainId?: number;
    invoiceId?: string;
  } = {};

  if (queryParams?.status) {
    filter.status = queryParams.status;
  }
  if (queryParams?.chainId) {
    filter.chainId = parseInt(queryParams.chainId);
  }
  if (queryParams?.invoiceId) {
    filter.invoiceId = queryParams.invoiceId;
  }

  return filter;
}

function validateOperationFilter(queryParams: APIGatewayProxyEventQueryStringParameters | null) {
  const filter: {
    status?: RebalanceOperationStatus | RebalanceOperationStatus[];
    chainId?: number;
    earmarkId?: string | null;
  } = {};

  if (queryParams?.status) {
    filter.status = queryParams.status as RebalanceOperationStatus;
  }
  if (queryParams?.earmarkId) {
    filter.earmarkId = queryParams.earmarkId;
  }
  if (queryParams?.chainId) {
    filter.chainId = parseInt(queryParams.chainId);
  }

  return filter;
}

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

    // Handle GET requests for rebalance inspection
    if (context.event.httpMethod === 'GET') {
      return handleGetRequest(request, context);
    }

    // Handle POST requests (existing functionality)
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
      case HttpPaths.CancelEarmark:
        return handleCancelEarmark(context);
      default:
        throw new Error(`Unknown request: ${request}`);
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Successfully processed request: ${request}` }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify(jsonifyError(e)),
    };
  }
};

const handleCancelEarmark = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, database } = context;
  const body = JSON.parse(event.body || '{}');
  const earmarkId = body.earmarkId;

  if (!earmarkId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'earmarkId is required in request body' }),
    };
  }

  logger.info('Cancelling earmark', { earmarkId });

  try {
    // Get current earmark to verify it exists and check status
    const earmarks = await database
      .queryWithClient<database.earmarks>('SELECT * FROM earmarks WHERE id = $1', [earmarkId])
      .then((rows) => rows.map((row) => snakeToCamel(row)));
    if (earmarks.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Earmark not found' }),
      };
    }

    const earmark = earmarks[0];

    // Check if earmark can be cancelled
    if (['completed', 'cancelled', 'expired'].includes(earmark.status)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: `Cannot cancel earmark with status: ${earmark.status}`,
          currentStatus: earmark.status,
        }),
      };
    }

    // Cancel any pending operations by marking them as expired
    const operations = await database.getRebalanceOperationsByEarmark(earmarkId);
    for (const op of operations) {
      if (op.status === 'pending' || op.status === 'awaiting_callback') {
        await database.updateRebalanceOperation(op.id, { status: RebalanceOperationStatus.EXPIRED });
      }
    }

    // Update earmark status to cancelled
    const updated = await database.updateEarmarkStatus(earmarkId, EarmarkStatus.CANCELLED);

    logger.info('Earmark cancelled successfully', {
      earmarkId,
      invoiceId: earmark.invoiceId,
      previousStatus: earmark.status,
      cancelledOperations: operations.filter((op) => op.status === 'pending' || op.status === 'awaiting_callback')
        .length,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Earmark cancelled successfully',
        earmark: updated,
      }),
    };
  } catch (error) {
    logger.error('Failed to cancel earmark', { earmarkId, error });
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Failed to cancel earmark',
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

const handleGetRequest = async (
  request: HttpPaths,
  context: AdminContext,
): Promise<{ statusCode: number; body: string }> => {
  const { logger, event } = context;
  logger.info('Handling GET request', { request, path: event.path });

  switch (request) {
    case HttpPaths.GetEarmarks: {
      const queryParams = event.queryStringParameters;
      const { limit, offset } = validatePagination(queryParams);
      const filter = validateEarmarkFilter(queryParams);

      const earmarks = await context.database.getEarmarksWithOperations(limit, offset, filter);
      return {
        statusCode: 200,
        body: JSON.stringify({ earmarks, total: earmarks.length }),
      };
    }

    case HttpPaths.GetRebalanceOperations: {
      const queryParams = event.queryStringParameters;
      const filter = validateOperationFilter(queryParams);

      const operations = await context.database.getRebalanceOperations(filter);
      return {
        statusCode: 200,
        body: JSON.stringify({ operations }),
      };
    }

    case HttpPaths.GetEarmarkDetails: {
      const earmarkId = event.pathParameters?.id;
      if (!earmarkId) {
        return {
          statusCode: 400,
          body: JSON.stringify({ message: 'Earmark ID required' }),
        };
      }

      const earmarks = await context.database
        .queryWithClient<database.earmarks>('SELECT * FROM earmarks WHERE id = $1', [earmarkId])
        .then((rows) => rows.map((row) => snakeToCamel(row)));
      if (earmarks.length === 0) {
        return {
          statusCode: 404,
          body: JSON.stringify({ message: 'Earmark not found' }),
        };
      }

      const operations = await context.database.getRebalanceOperationsByEarmark(earmarkId);

      return {
        statusCode: 200,
        body: JSON.stringify({
          earmark: earmarks[0],
          operations,
        }),
      };
    }

    default:
      return {
        statusCode: 404,
        body: JSON.stringify({ message: `Unknown GET request: ${request}` }),
      };
  }
};

const unpauseIfNeeded = async (
  type: 'rebalance' | 'purchase',
  _store: Database | PurchaseCache,
  context: AdminContext,
) => {
  const { requestId, logger } = context;

  if (type === 'rebalance') {
    const db = _store as Database;
    logger.debug('Unpausing rebalance', { requestId });
    if (!(await db.isPaused('rebalance'))) {
      throw new Error(`Rebalance is not paused`);
    }
    return db.setPause('rebalance', false);
  } else {
    const store = _store as PurchaseCache;
    logger.debug('Unpausing purchase cache', { requestId });
    if (!(await store.isPaused())) {
      throw new Error(`Purchase cache is not paused`);
    }
    return store.setPause(false);
  }
};

const pauseIfNeeded = async (
  type: 'rebalance' | 'purchase',
  _store: Database | PurchaseCache,
  context: AdminContext,
) => {
  const { requestId, logger } = context;

  if (type === 'rebalance') {
    const db = _store as Database;
    logger.debug('Pausing rebalance', { requestId });
    if (await db.isPaused('rebalance')) {
      throw new Error(`Rebalance is already paused`);
    }
    return db.setPause('rebalance', true);
  } else {
    const store = _store as PurchaseCache;
    logger.debug('Pausing purchase cache', { requestId });
    if (await store.isPaused()) {
      throw new Error(`Purchase cache is already paused`);
    }
    return store.setPause(true);
  }
};

export const extractRequest = (context: AdminContext): HttpPaths | undefined => {
  const { logger, event, requestId } = context;
  logger.debug(`Extracting request from event`, { requestId, event });

  const { path, pathParameters, httpMethod } = event;

  if (httpMethod !== 'POST' && httpMethod !== 'GET') {
    logger.error('Unknown http method', { requestId, path, pathParameters, httpMethod });
    return undefined;
  }

  // Handle earmark detail path with ID parameter
  if (httpMethod === 'GET' && path.includes('/rebalance/earmark/')) {
    return HttpPaths.GetEarmarkDetails;
  }

  // Handle cancel earmark
  if (httpMethod === 'POST' && path.endsWith('/rebalance/cancel')) {
    return HttpPaths.CancelEarmark;
  }

  for (const httpPath of Object.values(HttpPaths)) {
    if (path.endsWith(httpPath)) {
      return httpPath as HttpPaths;
    }
  }
  logger.error('Unknown path', { requestId, path, pathParameters, httpMethod });
  return undefined;
};
