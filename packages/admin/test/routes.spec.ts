/* eslint-disable @typescript-eslint/no-explicit-any */
import { RebalanceCache, PurchaseCache } from '@mark/cache';
import { extractRequest, handleApiRequest } from '../src/api/routes';
import { AdminContext, AdminConfig, HttpPaths } from '../src/types';
import { APIGatewayEvent } from 'aws-lambda';

jest.mock('@mark/cache', () => {
    return {
        RebalanceCache: jest.fn().mockImplementation(() => ({
            isPaused: jest.fn(),
            setPause: jest.fn()
        })),
        PurchaseCache: jest.fn().mockImplementation(() => ({
            isPaused: jest.fn(),
            setPause: jest.fn()
        }))
    }
})

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}

const mockAdminConfig: AdminConfig = {
    logLevel: 'debug',
    redis: { host: 'localhost', port: 6379 },
    adminToken: 'test-token',
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
    rebalanceCache: new RebalanceCache(mockAdminConfig.redis.host, mockAdminConfig.redis.port) as any,
}

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
        expect(JSON.parse(result.body).message).toBe(`Cache is already paused`);
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
        expect(result.body).toBe(JSON.stringify({ message: `Successfully processed request: ${HttpPaths.PauseRebalance}` }));
        expect(mockAdminContextBase.rebalanceCache.setPause).toHaveBeenCalledWith(true);
    });

    it('should error on pause rebalancing if already paused', async () => {
        const event = {
            ...mockEvent,
            path: HttpPaths.PauseRebalance,
        };
        mockAdminContextBase.rebalanceCache.isPaused = jest.fn().mockResolvedValue(true);
        const result = await handleApiRequest({
            ...mockAdminContextBase,
            event,
        });
        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).message).toBe(`Cache is already paused`);
        expect(mockAdminContextBase.rebalanceCache.setPause).toHaveBeenCalledTimes(0);
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
        expect(JSON.parse(result.body).message).toBe(`Cache is not paused`);
        expect(mockAdminContextBase.purchaseCache.setPause).toHaveBeenCalledTimes(0);
    });

    it('should handle unpause rebalancing', async () => {
        const event = {
            ...mockEvent,
            path: HttpPaths.UnpauseRebalance,
        };
        mockAdminContextBase.rebalanceCache.isPaused = jest.fn().mockResolvedValue(true);
        const result = await handleApiRequest({
            ...mockAdminContextBase,
            event,
        });
        expect(result.statusCode).toBe(200);
        expect(result.body).toBe(
            JSON.stringify({ message: `Successfully processed request: ${HttpPaths.UnpauseRebalance}` }),
        );
        expect(mockAdminContextBase.rebalanceCache.setPause).toHaveBeenCalledWith(false);
    });

    it('should error on unpause rebalancing if already paused', async () => {
        const event = {
            ...mockEvent,
            path: HttpPaths.UnpauseRebalance,
        };
        mockAdminContextBase.rebalanceCache.isPaused = jest.fn().mockResolvedValue(false);
        const result = await handleApiRequest({
            ...mockAdminContextBase,
            event,
        });
        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).message).toBe(`Cache is not paused`);
        expect(mockAdminContextBase.rebalanceCache.setPause).toHaveBeenCalledTimes(0);
    });
});
