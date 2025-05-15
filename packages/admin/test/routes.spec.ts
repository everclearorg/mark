/* eslint-disable @typescript-eslint/no-explicit-any */
import { extractRequest } from '../src/api/routes';
import { AdminContext, AdminConfig, HttpPaths } from '../src/types';
import { APIGatewayEvent, APIGatewayEventRequestContext } from 'aws-lambda';

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
};

describe('extractRequest', () => {
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
    purchaseCache: {} as any, // Mocked, not used by extractRequest
    rebalanceCache: {} as any, // Mocked, not used by extractRequest
  };

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

  it('should return undefined for a GET request to a known path', () => {
    const event: APIGatewayEvent = {
      ...mockEvent,
      httpMethod: 'GET', // Different method
      path: '/admin/pause/purchase',
    };
    const context: AdminContext = { ...mockAdminContextBase, event };
    expect(extractRequest(context)).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
