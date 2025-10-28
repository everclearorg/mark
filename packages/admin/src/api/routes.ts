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
  const parsedLimit = parseInt(queryParams?.limit || '50');
  const parsedOffset = parseInt(queryParams?.offset || '0');

  const limit = Math.min(isNaN(parsedLimit) ? 50 : parsedLimit, 1000);
  const offset = isNaN(parsedOffset) ? 0 : Math.max(0, parsedOffset);

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
    const parsedChainId = parseInt(queryParams.chainId);
    if (!isNaN(parsedChainId)) {
      filter.chainId = parsedChainId;
    }
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
    invoiceId?: string;
  } = {};

  if (queryParams?.status) {
    filter.status = queryParams.status as RebalanceOperationStatus;
  }
  if (queryParams?.earmarkId !== undefined) {
    // Handle special case where "null" string means null earmarkId (standalone operations)
    filter.earmarkId = queryParams.earmarkId === 'null' ? null : queryParams.earmarkId;
  }
  if (queryParams?.chainId) {
    const parsedChainId = parseInt(queryParams.chainId);
    if (!isNaN(parsedChainId)) {
      filter.chainId = parsedChainId;
    }
  }
  if (queryParams?.invoiceId) {
    filter.invoiceId = queryParams.invoiceId;
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
      case HttpPaths.PauseOnDemandRebalance:
        await pauseIfNeeded('ondemand', context.database, context);
        break;
      case HttpPaths.UnpausePurchase:
        await unpauseIfNeeded('purchase', context.purchaseCache, context);
        break;
      case HttpPaths.UnpauseRebalance:
        await unpauseIfNeeded('rebalance', context.database, context);
        break;
      case HttpPaths.UnpauseOnDemandRebalance:
        await unpauseIfNeeded('ondemand', context.database, context);
        break;
      case HttpPaths.CancelEarmark:
        return handleCancelEarmark(context);
      case HttpPaths.CancelRebalanceOperation:
        return handleCancelRebalanceOperation(context);
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

const handleCancelRebalanceOperation = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, database } = context;
  const body = JSON.parse(event.body || '{}');
  const operationId = body.operationId;

  if (!operationId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'operationId is required in request body' }),
    };
  }

  logger.info('Cancelling rebalance operation', { operationId });

  try {
    // Get current operation to verify it exists and check status
    const operations = await database
      .queryWithClient<database.rebalance_operations>('SELECT * FROM rebalance_operations WHERE id = $1', [operationId])
      .then((rows) => rows.map((row) => snakeToCamel(row)));

    if (operations.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Rebalance operation not found' }),
      };
    }

    const operation = operations[0];

    // Check if operation can be cancelled (must be PENDING or AWAITING_CALLBACK)
    if (!['pending', 'awaiting_callback'].includes(operation.status)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: `Cannot cancel operation with status: ${operation.status}. Only PENDING and AWAITING_CALLBACK operations can be cancelled.`,
          currentStatus: operation.status,
        }),
      };
    }

    // Update operation status to cancelled
    // Mark as orphaned if it has an associated earmark
    const updated = await database
      .queryWithClient<database.rebalance_operations>(
        `UPDATE rebalance_operations
       SET status = $1, is_orphaned = CASE WHEN earmark_id IS NOT NULL THEN true ELSE is_orphaned END, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
        [RebalanceOperationStatus.CANCELLED, operationId],
      )
      .then((rows) => rows.map((row) => snakeToCamel(row)));

    logger.info('Rebalance operation cancelled successfully', {
      operationId,
      previousStatus: operation.status,
      chainId: operation.chainId,
      hadEarmark: operation.earmarkId !== null,
      earmarkId: operation.earmarkId,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Rebalance operation cancelled successfully',
        operation: updated[0],
      }),
    };
  } catch (error) {
    logger.error('Failed to cancel rebalance operation', { operationId, error });
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Failed to cancel rebalance operation',
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
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

    // Mark all operations as orphaned (both PENDING and AWAITING_CALLBACK keep their status)
    const orphanedOps = await database.queryWithClient<{ id: string; status: string }>(
      `UPDATE rebalance_operations
       SET is_orphaned = true, updated_at = NOW()
       WHERE earmark_id = $1 AND status IN ($2, $3)
       RETURNING id, status`,
      [earmarkId, RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
    );

    // Update earmark status to cancelled
    const updated = await database.updateEarmarkStatus(earmarkId, EarmarkStatus.CANCELLED);

    logger.info('Earmark cancelled successfully', {
      earmarkId,
      invoiceId: earmark.invoiceId,
      previousStatus: earmark.status,
      orphanedOperations: orphanedOps.length,
      orphanedPending: orphanedOps.filter((op) => op.status === RebalanceOperationStatus.PENDING).length,
      orphanedAwaitingCallback: orphanedOps.filter((op) => op.status === RebalanceOperationStatus.AWAITING_CALLBACK)
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
      const { limit, offset } = validatePagination(queryParams);
      const filter = validateOperationFilter(queryParams);

      const result = await context.database.getRebalanceOperations(limit, offset, filter);
      return {
        statusCode: 200,
        body: JSON.stringify({ operations: result.operations, total: result.total }),
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

      try {
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
      } catch {
        // Handle invalid UUID format or other database errors
        return {
          statusCode: 404,
          body: JSON.stringify({ message: 'Earmark not found' }),
        };
      }
    }

    case HttpPaths.GetRebalanceOperationDetails: {
      const operationId = event.pathParameters?.id;
      if (!operationId) {
        return {
          statusCode: 400,
          body: JSON.stringify({ message: 'Operation ID required' }),
        };
      }

      try {
        const operation = await context.database.getRebalanceOperationById(operationId);
        if (!operation) {
          return {
            statusCode: 404,
            body: JSON.stringify({ message: 'Rebalance operation not found' }),
          };
        }

        return {
          statusCode: 200,
          body: JSON.stringify({ operation }),
        };
      } catch {
        // Handle invalid UUID format or other database errors
        return {
          statusCode: 404,
          body: JSON.stringify({ message: 'Rebalance operation not found' }),
        };
      }
    }

    default:
      return {
        statusCode: 404,
        body: JSON.stringify({ message: `Unknown GET request: ${request}` }),
      };
  }
};

const unpauseIfNeeded = async (
  type: 'rebalance' | 'purchase' | 'ondemand',
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
  } else if (type === 'ondemand') {
    const db = _store as Database;
    logger.debug('Unpausing on-demand rebalance', { requestId });
    if (!(await db.isPaused('ondemand'))) {
      throw new Error(`On-demand rebalance is not paused`);
    }
    return db.setPause('ondemand', false);
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
  type: 'rebalance' | 'purchase' | 'ondemand',
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
  } else if (type === 'ondemand') {
    const db = _store as Database;
    logger.debug('Pausing on-demand rebalance', { requestId });
    if (await db.isPaused('ondemand')) {
      throw new Error(`On-demand rebalance is already paused`);
    }
    return db.setPause('ondemand', true);
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

  // Handle rebalance operation detail path with ID parameter
  // Must check this before the cancel operation check
  if (httpMethod === 'GET' && path.match(/\/rebalance\/operation\/[^/]+$/)) {
    return HttpPaths.GetRebalanceOperationDetails;
  }

  // Handle cancel earmark
  if (httpMethod === 'POST' && path.endsWith('/rebalance/cancel')) {
    return HttpPaths.CancelEarmark;
  }

  // Handle cancel rebalance operation
  if (httpMethod === 'POST' && path.endsWith('/rebalance/operation/cancel')) {
    return HttpPaths.CancelRebalanceOperation;
  }

  for (const httpPath of Object.values(HttpPaths)) {
    if (path.endsWith(httpPath)) {
      return httpPath as HttpPaths;
    }
  }
  logger.error('Unknown path', { requestId, path, pathParameters, httpMethod });
  return undefined;
};
