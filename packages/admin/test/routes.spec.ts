/* eslint-disable @typescript-eslint/no-explicit-any */
import { PurchaseCache } from '@mark/cache';
import { extractRequest, handleApiRequest } from '../src/api/routes';
import { AdminContext, AdminConfig, HttpPaths } from '../src/types';
import { APIGatewayEvent } from 'aws-lambda';
import * as database from '@mark/database';
import { EarmarkStatus } from '@mark/core';

jest.mock('@mark/cache', () => {
  return {
    PurchaseCache: jest.fn().mockImplementation(() => ({
      isPaused: jest.fn(),
      setPause: jest.fn(),
    })),
  };
});

jest.mock('@mark/database', () => ({
  isPaused: jest.fn(),
  setPause: jest.fn(),
  queryWithClient: jest.fn(),
  updateEarmarkStatus: jest.fn(),
  snakeToCamel: jest.fn((obj) => obj), // Simple pass-through mock
}));

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockAdminConfig: AdminConfig = {
  logLevel: 'debug',
  redis: { host: 'localhost', port: 6379 },
  adminToken: 'test-token',
  database: { connectionString: 'postgresql://localhost:5432/test' },
};

const mockEvent: APIGatewayEvent = {
  headers: {
    ['x-admin-token']: mockAdminConfig.adminToken,
  },
  accountId: 'test-account-id',
  apiId: 'test-api-id',
  httpMethod: 'POST', // Will be overridden if necessary
  path: '', // Will be overridden
  requestId: 'test-request-id',
  stage: 'test',
  identity: {
    sourceIp: '127.0.0.1',
    userAgent: 'Jest test',
  } as any,
} as any;

const mockAdminContextBase: AdminContext = {
  logger: mockLogger as any,
  requestId: 'test-request-id',
  config: mockAdminConfig,
  event: mockEvent,
  startTime: Date.now(),
  purchaseCache: new PurchaseCache(mockAdminConfig.redis.host, mockAdminConfig.redis.port),
  database: database as typeof database,
};

describe('extractRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return HttpPaths.PausePurchase for POST /admin/pause/purchase', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      path: '/admin/pause/purchase',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBe(HttpPaths.PausePurchase);
    expect(mockLogger.debug).toHaveBeenCalledWith('Extracting request from event', {
      requestId: 'test-request-id',
      event,
    });
  });

  it('should return HttpPaths.PauseRebalance for POST /admin/pause/rebalance', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      path: '/admin/pause/rebalance',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBe(HttpPaths.PauseRebalance);
  });

  it('should return HttpPaths.UnpausePurchase for POST /admin/unpause/purchase', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      path: '/admin/unpause/purchase',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBe(HttpPaths.UnpausePurchase);
  });

  it('should return HttpPaths.UnpauseRebalance for POST /admin/unpause/rebalance', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      path: '/admin/unpause/rebalance',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBe(HttpPaths.UnpauseRebalance);
  });

  it('should return undefined for an unknown path', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      path: '/admin/unknown-path',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith('Unknown path', {
      requestId: 'test-request-id',
      path: '/admin/unknown-path',
      pathParameters: undefined,
      httpMethod: 'POST',
    });
  });

  it('should return undefined for a DELETE request', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      httpMethod: 'DELETE', // Unsupported method
      path: '/admin/pause/purchase',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('should return HttpPaths.CancelEarmark for POST /admin/rebalance/cancel', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      path: '/admin/rebalance/cancel',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBe(HttpPaths.CancelEarmark);
  });
});

describe('handleApiRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle invalid admin tokens', async () => {
    const event = {
      ...mockEvent,
      headers: {},
    };
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toBe(JSON.stringify({ message: 'Forbidden: Invalid admin token' }));
  });

  it('should return 404 if extractRequest returns undefined', async () => {
    const event = {
      ...mockEvent,
      httpMethod: 'GET',
    };
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(404);
    expect(result.body).toBe(JSON.stringify({ message: `Unknown request: ${event.httpMethod} ${event.path}` }));
  });

  it('should handle pause puchasing', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.PausePurchase,
    };
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(JSON.stringify({ message: `Successfully processed request: ${HttpPaths.PausePurchase}` }));
    expect(mockAdminContextBase.purchaseCache.setPause).toHaveBeenCalledWith(true);
  });

  it('should error on pause puchasing if already paused', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.PausePurchase,
    };
    mockAdminContextBase.purchaseCache.isPaused = jest.fn().mockResolvedValue(true);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).message).toBe(`Purchase cache is already paused`);
    expect(mockAdminContextBase.purchaseCache.setPause).toHaveBeenCalledTimes(0);
  });

  it('should handle pause rebalancing', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.PauseRebalance,
    };
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(
      JSON.stringify({ message: `Successfully processed request: ${HttpPaths.PauseRebalance}` }),
    );
    expect(database.setPause).toHaveBeenCalledWith('rebalance', true);
  });

  it('should error on pause rebalancing if already paused', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.PauseRebalance,
    };
    (database.isPaused as jest.Mock).mockResolvedValue(true);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).message).toBe(`Rebalance is already paused`);
    expect(database.setPause).toHaveBeenCalledTimes(0);
  });

  it('should handle unpause puchasing', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.UnpausePurchase,
    };
    mockAdminContextBase.purchaseCache.isPaused = jest.fn().mockResolvedValue(true);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(
      JSON.stringify({ message: `Successfully processed request: ${HttpPaths.UnpausePurchase}` }),
    );
    expect(mockAdminContextBase.purchaseCache.setPause).toHaveBeenCalledWith(false);
  });

  it('should error on unpause purchasing if already paused', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.UnpausePurchase,
    };
    mockAdminContextBase.purchaseCache.isPaused = jest.fn().mockResolvedValue(false);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).message).toBe(`Purchase cache is not paused`);
    expect(mockAdminContextBase.purchaseCache.setPause).toHaveBeenCalledTimes(0);
  });

  it('should handle unpause rebalancing', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.UnpauseRebalance,
    };
    (database.isPaused as jest.Mock).mockResolvedValue(true);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(
      JSON.stringify({ message: `Successfully processed request: ${HttpPaths.UnpauseRebalance}` }),
    );
    expect(database.setPause).toHaveBeenCalledWith('rebalance', false);
  });

  it('should error on unpause rebalancing if already paused', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.UnpauseRebalance,
    };
    (database.isPaused as jest.Mock).mockResolvedValue(false);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).message).toBe(`Rebalance is not paused`);
    expect(database.setPause).toHaveBeenCalledTimes(0);
  });

  describe('Cancel Earmark', () => {
    it('should cancel earmark successfully', async () => {
      const earmarkId = 'test-earmark-id';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/cancel',
        body: JSON.stringify({ earmarkId }),
      };

      // Mock earmark exists and is pending
      (database.queryWithClient as jest.Mock)
        .mockResolvedValueOnce([{ id: earmarkId, status: 'pending', invoiceId: 'test-invoice' }]) // getEarmark
        .mockResolvedValueOnce([
          { id: 'op1', status: 'pending' },
          { id: 'op2', status: 'pending' },
          { id: 'op3', status: 'awaiting_callback' },
        ]); // orphaned operations

      (database.updateEarmarkStatus as jest.Mock).mockResolvedValueOnce({
        id: earmarkId,
        status: EarmarkStatus.CANCELLED,
      });

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Earmark cancelled successfully');
      expect(database.updateEarmarkStatus).toHaveBeenCalledWith(earmarkId, EarmarkStatus.CANCELLED);
    });

    it('should return 400 if earmarkId is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/cancel',
        body: JSON.stringify({}),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('earmarkId is required in request body');
    });

    it('should return 404 if earmark not found', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/cancel',
        body: JSON.stringify({ earmarkId: 'non-existent' }),
      };

      (database.queryWithClient as jest.Mock).mockResolvedValueOnce([]); // no earmark found

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).message).toBe('Earmark not found');
    });

    it('should not cancel already completed earmark', async () => {
      const earmarkId = 'completed-earmark';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/cancel',
        body: JSON.stringify({ earmarkId }),
      };

      (database.queryWithClient as jest.Mock).mockResolvedValueOnce([
        { id: earmarkId, status: 'completed', invoiceId: 'test-invoice' },
      ]);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Cannot cancel earmark with status: completed');
      expect(body.currentStatus).toBe('completed');
    });

    it('should mark operations as orphaned without changing their status', async () => {
      const earmarkId = 'test-earmark-id-2';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/cancel',
        body: JSON.stringify({ earmarkId }),
      };

      const mockOperations = [
        { id: 'op1', status: 'pending' },
        { id: 'op2', status: 'pending' },
        { id: 'op3', status: 'awaiting_callback' },
        { id: 'op4', status: 'awaiting_callback' },
      ];

      // Mock earmark exists and is pending
      (database.queryWithClient as jest.Mock)
        .mockResolvedValueOnce([{ id: earmarkId, status: 'pending', invoiceId: 'test-invoice-2' }]) // getEarmark
        .mockResolvedValueOnce(mockOperations); // orphaned operations returned from UPDATE query

      (database.updateEarmarkStatus as jest.Mock).mockResolvedValueOnce({
        id: earmarkId,
        status: EarmarkStatus.CANCELLED,
      });

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);

      // Verify the UPDATE query was called with correct parameters
      const updateCall = (database.queryWithClient as jest.Mock).mock.calls[1];
      expect(updateCall[0]).toContain('SET is_orphaned = true');
      expect(updateCall[0]).not.toContain('SET status =');
      expect(updateCall[1]).toEqual([earmarkId, 'pending', 'awaiting_callback']);
    });
  });

  describe('Cancel Rebalance Operation', () => {
    it('should cancel standalone pending operation successfully', async () => {
      const operationId = 'test-operation-id';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({ operationId }),
      };

      // Mock operation exists, is standalone (earmarkId null), and is pending
      (database.queryWithClient as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: operationId,
            status: 'pending',
            earmarkId: null,
            chainId: 1,
            isOrphaned: false,
          },
        ]) // getOperation
        .mockResolvedValueOnce([
          {
            id: operationId,
            status: 'cancelled',
            earmarkId: null,
            chainId: 1,
            isOrphaned: false, // Should remain false for standalone ops
          },
        ]); // updated operation

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Rebalance operation cancelled successfully');
      expect(body.operation).toBeDefined();
      expect(body.operation.isOrphaned).toBe(false);
    });

    it('should cancel standalone awaiting_callback operation successfully', async () => {
      const operationId = 'test-operation-id';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({ operationId }),
      };

      // Mock operation exists, is standalone, and is awaiting_callback
      (database.queryWithClient as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: operationId,
            status: 'awaiting_callback',
            earmarkId: null,
            chainId: 1,
            isOrphaned: false,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: operationId,
            status: 'cancelled',
            earmarkId: null,
            chainId: 1,
            isOrphaned: false, // Should remain false for standalone ops
          },
        ]);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Rebalance operation cancelled successfully');
      expect(body.operation.isOrphaned).toBe(false);
    });

    it('should return 400 if operationId is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({}),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('operationId is required in request body');
    });

    it('should return 404 if operation not found', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({ operationId: 'non-existent' }),
      };

      (database.queryWithClient as jest.Mock).mockResolvedValueOnce([]); // no operation found

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).message).toBe('Rebalance operation not found');
    });

    it('should allow cancelling operation with earmark and mark it as orphaned', async () => {
      const operationId = 'test-operation-id';
      const earmarkId = 'test-earmark-id';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({ operationId }),
      };

      (database.queryWithClient as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: operationId,
            status: 'pending',
            earmarkId: earmarkId,
            chainId: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: operationId,
            status: 'cancelled',
            earmarkId: earmarkId,
            chainId: 1,
            isOrphaned: true,
          },
        ]);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Rebalance operation cancelled successfully');
      expect(body.operation.id).toBe(operationId);
      expect(body.operation.status).toBe('cancelled');
      expect(body.operation.isOrphaned).toBe(true);

      // Check that the update query was called with correct parameters
      expect(database.queryWithClient).toHaveBeenCalledWith(expect.stringContaining('UPDATE rebalance_operations'), [
        'cancelled',
        operationId,
      ]);
    });

    it('should reject cancelling completed operation', async () => {
      const operationId = 'completed-operation';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({ operationId }),
      };

      (database.queryWithClient as jest.Mock).mockResolvedValueOnce([
        {
          id: operationId,
          status: 'completed',
          earmarkId: null,
          chainId: 1,
        },
      ]);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe(
        'Cannot cancel operation with status: completed. Only PENDING and AWAITING_CALLBACK operations can be cancelled.',
      );
      expect(body.currentStatus).toBe('completed');
    });

    it('should reject cancelling expired operation', async () => {
      const operationId = 'expired-operation';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({ operationId }),
      };

      (database.queryWithClient as jest.Mock).mockResolvedValueOnce([
        {
          id: operationId,
          status: 'expired',
          earmarkId: null,
          chainId: 1,
        },
      ]);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe(
        'Cannot cancel operation with status: expired. Only PENDING and AWAITING_CALLBACK operations can be cancelled.',
      );
    });

    it('should reject cancelling already cancelled operation', async () => {
      const operationId = 'cancelled-operation';
      const event = {
        ...mockEvent,
        path: '/admin/rebalance/operation/cancel',
        body: JSON.stringify({ operationId }),
      };

      (database.queryWithClient as jest.Mock).mockResolvedValueOnce([
        {
          id: operationId,
          status: 'cancelled',
          earmarkId: null,
          chainId: 1,
        },
      ]);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe(
        'Cannot cancel operation with status: cancelled. Only PENDING and AWAITING_CALLBACK operations can be cancelled.',
      );
    });
  });
});
