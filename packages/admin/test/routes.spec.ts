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
  getEarmarksWithOperations: jest.fn(),
  getRebalanceOperations: jest.fn(),
  getRebalanceOperationsByEarmark: jest.fn(),
  getRebalanceOperationById: jest.fn(),
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
  whitelistedRecipients: ['0x1234567890123456789012345678901234567890'],
  markConfig: {
    chains: {},
    ownAddress: '0x0000000000000000000000000000000000000000',
  } as any,
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

const mockChainService = {
  submitAndMonitor: jest.fn(),
  readTx: jest.fn(),
} as any;

const mockRebalanceAdapter = {
  getAdapter: jest.fn(() => ({
    getReceivedAmount: jest.fn(),
    send: jest.fn(),
  })),
} as any;

const mockEverclearAdapter = {
  createNewIntent: jest.fn(),
  solanaCreateNewIntent: jest.fn(),
  tronCreateNewIntent: jest.fn(),
} as any;

const mockAdminContextBase: AdminContext = {
  logger: mockLogger as any,
  requestId: 'test-request-id',
  config: mockAdminConfig,
  event: mockEvent,
  startTime: Date.now(),
  purchaseCache: new PurchaseCache(mockAdminConfig.redis.host, mockAdminConfig.redis.port),
  database: database as typeof database,
  chainService: mockChainService,
  rebalanceAdapter: mockRebalanceAdapter,
  everclearAdapter: mockEverclearAdapter,
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

  it('should handle pause on-demand rebalancing', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.PauseOnDemandRebalance,
    };
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(
      JSON.stringify({ message: `Successfully processed request: ${HttpPaths.PauseOnDemandRebalance}` }),
    );
    expect(database.setPause).toHaveBeenCalledWith('ondemand', true);
  });

  it('should error on pause on-demand rebalancing if already paused', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.PauseOnDemandRebalance,
    };
    (database.isPaused as jest.Mock).mockResolvedValue(true);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).message).toBe(`On-demand rebalance is already paused`);
    expect(database.setPause).toHaveBeenCalledTimes(0);
  });

  it('should handle unpause on-demand rebalancing', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.UnpauseOnDemandRebalance,
    };
    (database.isPaused as jest.Mock).mockResolvedValue(true);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(
      JSON.stringify({ message: `Successfully processed request: ${HttpPaths.UnpauseOnDemandRebalance}` }),
    );
    expect(database.setPause).toHaveBeenCalledWith('ondemand', false);
  });

  it('should error on unpause on-demand rebalancing if not paused', async () => {
    const event = {
      ...mockEvent,
      path: HttpPaths.UnpauseOnDemandRebalance,
    };
    (database.isPaused as jest.Mock).mockResolvedValue(false);
    const result = await handleApiRequest({
      ...mockAdminContextBase,
      event,
    });
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).message).toBe(`On-demand rebalance is not paused`);
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

  describe('GET Rebalance Operations', () => {
    it('should retrieve rebalance operations with pagination', async () => {
      const mockOperations = [
        { id: 'op1', status: 'pending', originChainId: 1, destinationChainId: 10 },
        { id: 'op2', status: 'completed', originChainId: 1, destinationChainId: 137 },
      ];

      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: '/admin/rebalance/operations',
        queryStringParameters: {
          limit: '10',
          offset: '0',
        },
      };

      (database.getRebalanceOperations as jest.Mock).mockResolvedValueOnce({
        operations: mockOperations,
        total: 25,
      });

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.operations).toEqual(mockOperations);
      expect(body.total).toBe(25);
      expect(database.getRebalanceOperations).toHaveBeenCalledWith(10, 0, {});
    });

    it('should retrieve rebalance operations with invoiceId filter', async () => {
      const mockOperations = [
        { id: 'op1', status: 'pending', originChainId: 1, destinationChainId: 10 },
      ];

      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: '/admin/rebalance/operations',
        queryStringParameters: {
          limit: '50',
          offset: '0',
          invoiceId: 'test-invoice-123',
        },
      };

      (database.getRebalanceOperations as jest.Mock).mockResolvedValueOnce({
        operations: mockOperations,
        total: 1,
      });

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.operations).toEqual(mockOperations);
      expect(body.total).toBe(1);
      expect(database.getRebalanceOperations).toHaveBeenCalledWith(50, 0, {
        invoiceId: 'test-invoice-123',
      });
    });

    it('should retrieve rebalance operations with multiple filters', async () => {
      const mockOperations = [
        { id: 'op1', status: 'pending', originChainId: 1, destinationChainId: 10 },
      ];

      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: '/admin/rebalance/operations',
        queryStringParameters: {
          limit: '20',
          offset: '10',
          status: 'pending',
          chainId: '1',
          invoiceId: 'test-invoice-456',
        },
      };

      (database.getRebalanceOperations as jest.Mock).mockResolvedValueOnce({
        operations: mockOperations,
        total: 15,
      });

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.operations).toEqual(mockOperations);
      expect(body.total).toBe(15);
      expect(database.getRebalanceOperations).toHaveBeenCalledWith(20, 10, {
        status: 'pending',
        chainId: 1,
        invoiceId: 'test-invoice-456',
      });
    });
  });

  describe('GET Rebalance Operation By ID', () => {
    it('should retrieve a specific operation by ID', async () => {
      const operationId = 'test-op-id-123';
      const mockOperation = {
        id: operationId,
        status: 'pending',
        originChainId: 1,
        destinationChainId: 10,
        earmarkId: 'test-earmark-id',
        transactions: { '1': { transactionHash: '0x123' } },
      };

      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: `/admin/rebalance/operation/${operationId}`,
        pathParameters: { id: operationId },
      };

      (database.getRebalanceOperationById as jest.Mock).mockResolvedValueOnce(mockOperation);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.operation).toEqual(mockOperation);
      expect(database.getRebalanceOperationById).toHaveBeenCalledWith(operationId);
    });

    it('should return 400 when operation ID is missing', async () => {
      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: '/admin/rebalance/operation/some-id',
        pathParameters: {}, // No id in pathParameters
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Operation ID required');
    });

    it('should return 404 when operation is not found', async () => {
      const operationId = 'non-existent-op-id';

      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: `/admin/rebalance/operation/${operationId}`,
        pathParameters: { id: operationId },
      };

      (database.getRebalanceOperationById as jest.Mock).mockResolvedValueOnce(undefined);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Rebalance operation not found');
    });
  });

  describe('GET Earmarks', () => {
    it('should retrieve earmarks with operations and total count', async () => {
      const mockEarmarks = [
        {
          id: 'earmark1',
          invoiceId: 'invoice-001',
          status: 'pending',
          designatedPurchaseChain: 1,
          operations: [
            { id: 'op1', status: 'pending' },
            { id: 'op2', status: 'completed' },
          ],
        },
        {
          id: 'earmark2',
          invoiceId: 'invoice-002',
          status: 'ready',
          designatedPurchaseChain: 137,
          operations: [],
        },
      ];

      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: '/admin/rebalance/earmarks',
        queryStringParameters: {
          limit: '50',
          offset: '0',
        },
      };

      (database.getEarmarksWithOperations as jest.Mock).mockResolvedValueOnce({
        earmarks: mockEarmarks,
        total: 10,
      });

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.earmarks).toEqual(mockEarmarks);
      expect(body.total).toBe(10);
      expect(database.getEarmarksWithOperations).toHaveBeenCalledWith(50, 0, {});
    });

    it('should retrieve earmarks with filters', async () => {
      const event = {
        ...mockEvent,
        httpMethod: 'GET',
        path: '/admin/rebalance/earmarks',
        queryStringParameters: {
          limit: '20',
          offset: '5',
          status: 'pending',
          chainId: '1',
          invoiceId: 'test-invoice',
        },
      };

      (database.getEarmarksWithOperations as jest.Mock).mockResolvedValueOnce({
        earmarks: [],
        total: 0,
      });

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.earmarks).toEqual([]);
      expect(body.total).toBe(0);
      expect(database.getEarmarksWithOperations).toHaveBeenCalledWith(20, 5, {
        status: 'pending',
        chainId: 1,
        invoiceId: 'test-invoice',
      });
    });
  });

  describe('POST Trigger Send', () => {
    it('should validate whitelisted recipient and reject with chain not configured', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          chainId: 999, // Non-existent chain
          asset: 'USDC',
          recipient: '0x1234567890123456789012345678901234567890',
          amount: '1000000',
          memo: 'Test send',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Chain 999 is not configured');
    });

    it('should reject non-whitelisted recipient', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          chainId: 1,
          asset: 'USDC',
          recipient: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Recipient address is not whitelisted');
      expect(body.recipient).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    });

    it('should perform case-insensitive whitelist matching', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          chainId: 999, // Non-existent chain
          asset: 'USDC',
          recipient: '0X1234567890123456789012345678901234567890', // Uppercase
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      // Should pass whitelist validation but fail on chain config
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Chain 999 is not configured');
    });

    it('should return 400 when chainId is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          asset: 'USDC',
          recipient: '0x1234567890123456789012345678901234567890',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('chainId is required in request body');
    });

    it('should return 400 when asset is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          chainId: 1,
          recipient: '0x1234567890123456789012345678901234567890',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('asset is required in request body');
    });

    it('should return 400 when recipient is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          chainId: 1,
          asset: 'USDC',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('recipient is required in request body');
    });

    it('should return 400 when amount is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          chainId: 1,
          asset: 'USDC',
          recipient: '0x1234567890123456789012345678901234567890',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('amount is required in request body');
    });

    it('should return 403 when no whitelist is configured', async () => {
      const configNoWhitelist = {
        ...mockAdminConfig,
        whitelistedRecipients: [],
      };

      const event = {
        ...mockEvent,
        path: '/admin/trigger/send',
        body: JSON.stringify({
          chainId: 1,
          asset: 'USDC',
          recipient: '0x1234567890123456789012345678901234567890',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configNoWhitelist,
        event,
      });

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('No whitelisted recipients configured. Cannot send funds.');
    });
  });

  describe('extractRequest for trigger/send', () => {
    it('should return HttpPaths.TriggerSend for POST /admin/trigger/send', () => {
      const event: APIGatewayEvent = {
        ...mockEvent,
        path: '/admin/trigger/send',
      };
      const context: AdminContext = { ...mockAdminContextBase, event };
      expect(extractRequest(context)).toBe(HttpPaths.TriggerSend);
    });
  });

  describe('POST Trigger Rebalance', () => {
    it('should return 400 when originChain is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          destinationChain: 42161,
          asset: 'USDC',
          amount: '1.0',
          bridge: 'Across',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('originChain is required in request body');
    });

    it('should return 400 when destinationChain is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          originChain: 1,
          asset: 'USDC',
          amount: '1.0',
          bridge: 'Across',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('destinationChain is required in request body');
    });

    it('should return 400 when asset is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          originChain: 1,
          destinationChain: 42161,
          amount: '1.0',
          bridge: 'Across',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('asset is required in request body');
    });

    it('should return 400 when amount is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          originChain: 1,
          destinationChain: 42161,
          asset: 'USDC',
          bridge: 'Across',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('amount is required in request body');
    });

    it('should return 400 when bridge is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          originChain: 1,
          destinationChain: 42161,
          asset: 'USDC',
          amount: '1.0',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('bridge is required in request body');
    });

    it('should return 400 for invalid bridge type', async () => {
      const configWithChains = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: {
            '1': {
              chainId: 1,
              rpc: ['http://localhost:8545'],
              assets: [
                {
                  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                  tickerHash: 'USDC',
                  decimals: 6,
                },
              ],
            },
            '42161': {
              chainId: 42161,
              rpc: ['http://localhost:8545'],
              assets: [
                {
                  address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
                  tickerHash: 'USDC',
                  decimals: 6,
                },
              ],
            },
          },
        } as any,
      };

      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          originChain: 1,
          destinationChain: 42161,
          asset: 'USDC',
          amount: '1.0',
          bridge: 'InvalidBridge',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithChains,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Invalid bridge type');
    });

    it('should return 400 when origin chain is not configured', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          originChain: 999999,
          destinationChain: 42161,
          asset: 'USDC',
          amount: '1.0',
          bridge: 'Across',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Origin chain 999999 is not configured');
    });

    it('should return 400 when destination chain is not configured', async () => {
      const configWithOriginChain = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: {
            '1': {
              chainId: 1,
              rpc: ['http://localhost:8545'],
              assets: [],
            },
          },
        } as any,
      };

      const event = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
        body: JSON.stringify({
          originChain: 1,
          destinationChain: 999999,
          asset: 'USDC',
          amount: '1.0',
          bridge: 'Across',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithOriginChain,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Destination chain 999999 is not configured');
    });
  });

  describe('extractRequest for trigger/rebalance', () => {
    it('should return HttpPaths.TriggerRebalance for POST /admin/trigger/rebalance', () => {
      const event: APIGatewayEvent = {
        ...mockEvent,
        path: '/admin/trigger/rebalance',
      };
      const context: AdminContext = { ...mockAdminContextBase, event };
      expect(extractRequest(context)).toBe(HttpPaths.TriggerRebalance);
    });
  });

  describe('POST Trigger Intent', () => {
    const VALID_TO = mockAdminConfig.markConfig.ownAddress; // Must be ownAddress

    it('should return 400 when origin is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          destinations: [10, 42161],
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 0,
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('origin (chain ID) is required in request body');
    });

    it('should return 400 when destinations is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 0,
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('destinations (array of chain IDs) is required in request body');
    });

    it('should return 400 when to (receiver) is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [10, 42161],
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 0,
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('to (receiver address) is required in request body');
    });

    it('should return 400 when inputAsset is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [10, 42161],
          to: VALID_TO,
          amount: '1000000',
          maxFee: 0,
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('inputAsset is required in request body');
    });

    it('should return 400 when amount is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [10, 42161],
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          maxFee: 0,
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('amount is required in request body');
    });

    it('should return 400 when maxFee is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [10, 42161],
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('maxFee is required in request body');
    });

    it('should return 400 when maxFee is not 0', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [10, 42161],
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 100,
        }),
      };

      const configWithChain = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: { '1': { chainId: 1, rpc: ['http://localhost:8545'], assets: [] } },
        } as any,
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithChain,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('maxFee must be 0 (no solver fees allowed)');
    });

    it('should return 400 when callData is not 0x', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [10, 42161],
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 0,
          callData: '0x1234',
        }),
      };

      const configWithChain = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: { '1': { chainId: 1, rpc: ['http://localhost:8545'], assets: [] } },
        } as any,
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithChain,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('callData must be 0x (no custom execution allowed)');
    });

    it('should return 400 when receiver is not ownAddress', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [10, 42161],
          to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 0,
        }),
      };

      const configWithChain = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: { '1': { chainId: 1, rpc: ['http://localhost:8545'], assets: [] } },
        } as any,
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithChain,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Receiver must be Mark');
    });

    it('should return 400 when origin chain is not configured', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 999999,
          destinations: [10, 42161],
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 0,
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Origin chain 999999 is not configured');
    });

    it('should return 400 when destination chain is not configured', async () => {
      const configWithOriginChain = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: {
            '1': {
              chainId: 1,
              rpc: ['http://localhost:8545'],
              assets: [],
            },
          },
        } as any,
      };

      const event = {
        ...mockEvent,
        path: '/admin/trigger/intent',
        body: JSON.stringify({
          origin: 1,
          destinations: [999999],
          to: VALID_TO,
          inputAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000',
          maxFee: 0,
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithOriginChain,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Destination chain 999999 is not configured');
    });
  });

  describe('extractRequest for trigger/intent', () => {
    it('should return HttpPaths.TriggerIntent for POST /admin/trigger/intent', () => {
      const event: APIGatewayEvent = {
        ...mockEvent,
        path: '/admin/trigger/intent',
      };
      const context: AdminContext = { ...mockAdminContextBase, event };
      expect(extractRequest(context)).toBe(HttpPaths.TriggerIntent);
    });
  });

  describe('POST Trigger Swap', () => {
    it('should return 400 when chainId is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/swap',
        body: JSON.stringify({
          inputAsset: 'USDT',
          outputAsset: 'USDC',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('chainId is required in request body');
    });

    it('should return 400 when inputAsset is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/swap',
        body: JSON.stringify({
          chainId: 42161,
          outputAsset: 'USDC',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('inputAsset is required in request body');
    });

    it('should return 400 when outputAsset is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/swap',
        body: JSON.stringify({
          chainId: 42161,
          inputAsset: 'USDT',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('outputAsset is required in request body');
    });

    it('should return 400 when amount is missing', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/swap',
        body: JSON.stringify({
          chainId: 42161,
          inputAsset: 'USDT',
          outputAsset: 'USDC',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('amount is required in request body');
    });

    it('should return 400 when chain is not configured', async () => {
      const event = {
        ...mockEvent,
        path: '/admin/trigger/swap',
        body: JSON.stringify({
          chainId: 999999,
          inputAsset: 'USDT',
          outputAsset: 'USDC',
          amount: '1000000',
        }),
      };

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Chain 999999 is not configured');
    });

    it('should return 400 when swap adapter does not support executeSwap', async () => {
      const mockAdapterWithoutExecuteSwap = {
        getReceivedAmount: jest.fn(),
        send: jest.fn(),
        // No executeSwap method
      };

      const configWithChain = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: {
            '42161': {
              chainId: 42161,
              rpc: ['http://localhost:8545'],
              assets: [
                { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, tickerHash: '0xusdt' },
                { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, tickerHash: '0xusdc' },
              ],
            },
          },
        } as any,
      };

      const event = {
        ...mockEvent,
        path: '/admin/trigger/swap',
        body: JSON.stringify({
          chainId: 42161,
          inputAsset: 'USDT',
          outputAsset: 'USDC',
          amount: '1000000',
          swapAdapter: 'across', // Use a valid SupportedBridge name
        }),
      };

      mockRebalanceAdapter.getAdapter.mockReturnValue(mockAdapterWithoutExecuteSwap);

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithChain,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('does not support executeSwap operation');
    });

    it('should return 400 when invalid swap adapter is provided', async () => {
      const configWithChain = {
        ...mockAdminConfig,
        markConfig: {
          ...mockAdminConfig.markConfig,
          chains: {
            '42161': {
              chainId: 42161,
              rpc: ['http://localhost:8545'],
              assets: [
                { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, tickerHash: '0xusdt' },
                { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, tickerHash: '0xusdc' },
              ],
            },
          },
        } as any,
      };

      const event = {
        ...mockEvent,
        path: '/admin/trigger/swap',
        body: JSON.stringify({
          chainId: 42161,
          inputAsset: 'USDT',
          outputAsset: 'USDC',
          amount: '1000000',
          swapAdapter: 'invalid_adapter',
        }),
      };

      // Don't mock getAdapter - the validation should fail at enum check before calling getAdapter

      const result = await handleApiRequest({
        ...mockAdminContextBase,
        config: configWithChain,
        event,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Invalid swap adapter');
    });
  });

  describe('extractRequest for trigger/swap', () => {
    it('should return HttpPaths.TriggerSwap for POST /admin/trigger/swap', () => {
      const event: APIGatewayEvent = {
        ...mockEvent,
        path: '/admin/trigger/swap',
      };
      const context: AdminContext = { ...mockAdminContextBase, event };
      expect(extractRequest(context)).toBe(HttpPaths.TriggerSwap);
    });
  });
});
