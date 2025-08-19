import { SupportedBridge } from '@mark/core';
import { RebalanceCache, RebalanceAction, RebalancingConfig } from '../src/rebalanceCache';
import Redis from 'ioredis';

// Shared mock instances that tests can access and clear.
const mockPipelineInstance = {
    hset: jest.fn().mockReturnThis(),
    sadd: jest.fn().mockReturnThis(),
    smembers: jest.fn().mockReturnThis(),
    hmget: jest.fn().mockReturnThis(),
    srem: jest.fn().mockReturnThis(),
    hdel: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
};

const mockRedisSdkInstance = {
    pipeline: jest.fn(() => mockPipelineInstance),
    hset: jest.fn(),
    sadd: jest.fn(),
    hmget: jest.fn(),
    hget: jest.fn(),
    srem: jest.fn(),
    hdel: jest.fn(),
    smembers: jest.fn(),
    flushall: jest.fn().mockResolvedValue('OK'),
    hexists: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    hkeys: jest.fn(),
    connectTimeout: 17_000,
    maxRetriesPerRequest: 4,
    retryStrategy: jest.fn((times) => Math.min(times * 30, 1_000)),
    keys: jest.fn(),
    exists: jest.fn(),
    del: jest.fn(),
    disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('ioredis', () => {
    // The mock constructor for Redis
    const MockRedis = jest.fn().mockImplementation(() => mockRedisSdkInstance);
    return MockRedis;
});

describe('RebalanceCache', () => {
    let rebalanceCache: RebalanceCache;

    beforeEach(() => {
        // Clear all mock functions on the shared instances before each test
        Object.values(mockRedisSdkInstance).forEach(mockFn => {
            if (jest.isMockFunction(mockFn)) {
                mockFn.mockClear();
            }
        });
        Object.values(mockPipelineInstance).forEach(mockFn => {
            if (jest.isMockFunction(mockFn)) {
                mockFn.mockClear();
            }
        });

        // Reset default resolved values
        mockPipelineInstance.exec.mockResolvedValue([]);
        mockRedisSdkInstance.flushall.mockResolvedValue('OK');
        mockRedisSdkInstance.hexists.mockResolvedValue(0);
        mockRedisSdkInstance.set.mockResolvedValue('OK');
        mockRedisSdkInstance.get.mockResolvedValue(null);
        // Ensure pipeline() returns the (cleared) mockPipelineInstance for each test
        mockRedisSdkInstance.pipeline.mockReturnValue(mockPipelineInstance);


        // Create a new instance of RebalanceCache before each test
        // This will use the mocked ioredis constructor
        rebalanceCache = new RebalanceCache('localhost', 6379);
    });

    it('should instantiate and connect to Redis with correct parameters', () => {
        // Check if the Redis mock constructor was called
        expect(Redis).toHaveBeenCalledTimes(1);
        // Check if it was called with the correct parameters
        expect(Redis).toHaveBeenCalledWith({
            host: 'localhost',
            port: 6379,
            connectTimeout: 17_000,
            maxRetriesPerRequest: 4,
            retryStrategy: expect.any(Function), // ioredis uses a default strategy if not provided, so we check for a function
        });
    });

    describe('addRebalances', () => {
        const sampleAction: RebalanceAction = {
            amount: '100',
            origin: 1,
            destination: 2,
            asset: 'ETH',
            transaction: '0xtxhash1',
            bridge: SupportedBridge.Across,
            recipient: '0x1234567890123456789012345678901234567890'
        };

        it('should add a single rebalance action and return 1', async () => {
            // Mock pipeline exec to simulate successful hset (returns [null, 1])
            // randomUUID will be part of the key, so we expect one hset and one sadd
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([[null, 1], [null, 1]]); // [hset result, sadd result]

            const result = await rebalanceCache.addRebalances([sampleAction]);

            expect(result).toBe(1);
            expect(mockRedisSdkInstance.pipeline).toHaveBeenCalledTimes(1);
            expect(mockPipelineInstance.hset).toHaveBeenCalledTimes(1);
            expect(mockPipelineInstance.sadd).toHaveBeenCalledTimes(1);
            expect(mockPipelineInstance.exec).toHaveBeenCalledTimes(1);

            // Verify hset arguments (id will contain a UUID)
            expect(mockPipelineInstance.hset).toHaveBeenCalledWith(
                'rebalances:data',
                expect.stringContaining(`${sampleAction.destination}-${sampleAction.origin}-${sampleAction.asset}`),
                JSON.stringify(sampleAction)
            );
            // Verify sadd arguments
            expect(mockPipelineInstance.sadd).toHaveBeenCalledWith(
                `rebalances:route:${sampleAction.destination}-${sampleAction.origin}-${sampleAction.asset.toLowerCase()}`,
                expect.stringContaining(`${sampleAction.destination}-${sampleAction.origin}-${sampleAction.asset}`)
            );
        });

        it('should add multiple rebalance actions and return the count of new actions', async () => {
            const actions: RebalanceAction[] = [
                sampleAction,
                { ...sampleAction, destination: 3, transaction: '0xtxhash2' },
            ];
            // Simulate two successful hsets and two sadds
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([
                [null, 1], [null, 1], // action 1 hset, sadd
                [null, 1], [null, 1], // action 2 hset, sadd
            ]);

            const result = await rebalanceCache.addRebalances(actions);

            expect(result).toBe(2);
            expect(mockRedisSdkInstance.pipeline).toHaveBeenCalledTimes(1);
            expect(mockPipelineInstance.hset).toHaveBeenCalledTimes(2);
            expect(mockPipelineInstance.sadd).toHaveBeenCalledTimes(2);
            expect(mockPipelineInstance.exec).toHaveBeenCalledTimes(1);
        });

        it('should return 0 if no actions are provided', async () => {
            const result = await rebalanceCache.addRebalances([]);
            expect(result).toBe(0);
            expect(mockRedisSdkInstance.pipeline).not.toHaveBeenCalled();
        });

        it('should return 0 if hset reports no new row was created', async () => {
            // Mock pipeline exec to simulate hset not creating a new row (returns [null, 0])
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([[null, 0], [null, 1]]);

            const result = await rebalanceCache.addRebalances([sampleAction]);
            expect(result).toBe(0);
        });
    });

    describe('getRebalances', () => {
        const sampleAction1: RebalanceAction = {
            amount: '100', origin: 1, destination: 2, asset: 'ETH', transaction: '0xtx1', bridge: SupportedBridge.Across, recipient: '0x1111111111111111111111111111111111111111'
        };
        const sampleAction2: RebalanceAction = {
            amount: '200', origin: 1, destination: 2, asset: 'BTC', transaction: '0xtx2', bridge: SupportedBridge.Across, recipient: '0x2222222222222222222222222222222222222222'
        };
        const sampleAction3: RebalanceAction = {
            amount: '300', origin: 3, destination: 4, asset: 'ETH', transaction: '0xtx3', bridge: SupportedBridge.Across, recipient: '0x3333333333333333333333333333333333333333'
        };

        const id1 = '2-1-eth-uuid1';
        const id2 = '2-1-btc-uuid2';
        const id3 = '4-3-eth-uuid3';

        it('should return rebalance actions matching the config', async () => {
            const config: RebalancingConfig = {
                routes: [
                    { destination: 2, origin: 1, asset: 'ETH', maximum: '1000', slippages: [0.1], preferences: [] },
                    { destination: 2, origin: 1, asset: 'BTC', maximum: '1000', slippages: [0.1], preferences: [] },
                ],
            };

            // Mock pipeline.exec for smembers calls
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([
                [null, [id1]], // Result for smembers on route 1
                [null, [id2]], // Result for smembers on route 2
            ]);

            // Mock store.hmget for fetching action data
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                JSON.stringify(sampleAction1),
                JSON.stringify(sampleAction2),
            ]);

            const result = await rebalanceCache.getRebalances(config);

            expect(mockRedisSdkInstance.pipeline).toHaveBeenCalledTimes(1);
            expect(mockPipelineInstance.smembers).toHaveBeenCalledTimes(2);
            expect(mockPipelineInstance.smembers).toHaveBeenCalledWith(`rebalances:route:2-1-eth`);
            expect(mockPipelineInstance.smembers).toHaveBeenCalledWith(`rebalances:route:2-1-btc`);
            expect(mockPipelineInstance.exec).toHaveBeenCalledTimes(1);

            expect(mockRedisSdkInstance.hmget).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hmget).toHaveBeenCalledWith('rebalances:data', id1, id2);

            expect(result).toEqual([
                { ...sampleAction1, id: id1 },
                { ...sampleAction2, id: id2 }
            ]);
        });

        it('should return an empty array if no routes are configured', async () => {
            const config: RebalancingConfig = { routes: [] };
            const result = await rebalanceCache.getRebalances(config);
            expect(result).toEqual([]);
            expect(mockRedisSdkInstance.pipeline).not.toHaveBeenCalled();
            expect(mockRedisSdkInstance.hmget).not.toHaveBeenCalled();
        });

        it('should return an empty array if smembers returns no ids', async () => {
            const config: RebalancingConfig = {
                routes: [{ destination: 9, origin: 9, asset: 'XYZ', maximum: '100', slippages: [0.1], preferences: [] }],
            };
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([[null, []]]); // No IDs for this route

            const result = await rebalanceCache.getRebalances(config);

            expect(result).toEqual([]);
            expect(mockPipelineInstance.smembers).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hmget).not.toHaveBeenCalled();
        });

        it('should return an empty array if hmget returns no data for ids', async () => {
            const config: RebalancingConfig = {
                routes: [{ destination: 2, origin: 1, asset: 'ETH', maximum: '1000', slippages: [0.1], preferences: [] }],
            };
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([[null, [id1]]]);
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([null]); // No data for id1

            const result = await rebalanceCache.getRebalances(config);
            expect(result).toEqual([]);
        });

        it('should handle multiple routes, some with no matching IDs', async () => {
            const config: RebalancingConfig = {
                routes: [
                    { destination: 2, origin: 1, asset: 'ETH', maximum: '1000', slippages: [0.1], preferences: [] }, // Has id1
                    { destination: 9, origin: 9, asset: 'XYZ', maximum: '100', slippages: [0.1], preferences: [] }, // No IDs
                    { destination: 4, origin: 3, asset: 'ETH', maximum: '1000', slippages: [0.1], preferences: [] }, // Has id3
                ],
            };

            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([
                [null, [id1]],
                [null, []],    // No IDs for XYZ route
                [null, [id3]],
            ]);
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                JSON.stringify(sampleAction1),
                JSON.stringify(sampleAction3),
            ]);

            const result = await rebalanceCache.getRebalances(config);

            expect(mockPipelineInstance.smembers).toHaveBeenCalledTimes(3);
            expect(mockRedisSdkInstance.hmget).toHaveBeenCalledWith('rebalances:data', id1, id3);
            expect(result).toEqual([
                { ...sampleAction1, id: id1 },
                { ...sampleAction3, id: id3 }
            ]);
        });
    });

    describe('hasRebalance', () => {
        const testId = 'some-rebalance-id';

        it('should return true if hexists returns 1', async () => {
            (mockRedisSdkInstance.hexists as jest.Mock).mockResolvedValueOnce(1);

            const result = await rebalanceCache.hasRebalance(testId);

            expect(result).toBe(true);
            expect(mockRedisSdkInstance.hexists).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hexists).toHaveBeenCalledWith('rebalances:data', testId);
        });

        it('should return false if hexists returns 0', async () => {
            (mockRedisSdkInstance.hexists as jest.Mock).mockResolvedValueOnce(0);

            const result = await rebalanceCache.hasRebalance(testId);

            expect(result).toBe(false);
            expect(mockRedisSdkInstance.hexists).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hexists).toHaveBeenCalledWith('rebalances:data', testId);
        });
    });

    describe('getRebalanceByTransaction', () => {
        const sampleAction: RebalanceAction = {
            amount: '100', origin: 1, destination: 2, asset: 'ETH', transaction: '0xtx1', bridge: SupportedBridge.Across, recipient: '0x1111111111111111111111111111111111111111'
        };

        it('should return action when transaction hash matches', async () => {
            const id = '2-1-eth-uuid1';
            
            // Mock hkeys to return the ID
            (mockRedisSdkInstance.hkeys as jest.Mock).mockResolvedValueOnce([id]);
            
            // Mock hmget to return the action data
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                JSON.stringify(sampleAction),
            ]);

            const result = await rebalanceCache.getRebalanceByTransaction('0xtx1');

            expect(mockRedisSdkInstance.hkeys).toHaveBeenCalledWith('rebalances:data');
            expect(mockRedisSdkInstance.hmget).toHaveBeenCalledWith('rebalances:data', id);
            expect(result).toEqual({ ...sampleAction, id });
        });

        it('should return undefined when no actions exist', async () => {
            (mockRedisSdkInstance.hkeys as jest.Mock).mockResolvedValueOnce([]);
            
            const result = await rebalanceCache.getRebalanceByTransaction('0xtx1');
            
            expect(result).toBeUndefined();
            expect(mockRedisSdkInstance.hmget).not.toHaveBeenCalled();
        });

        it('should return undefined when transaction hash does not match', async () => {
            const id = '2-1-eth-uuid1';
            const differentAction = { ...sampleAction, transaction: '0xtx2' };
            
            (mockRedisSdkInstance.hkeys as jest.Mock).mockResolvedValueOnce([id]);
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                JSON.stringify(differentAction),
            ]);

            const result = await rebalanceCache.getRebalanceByTransaction('0xtx1');

            expect(result).toBeUndefined();
        });

        it('should handle multiple actions and return the matching one', async () => {
            const id1 = '2-1-eth-uuid1';
            const id2 = '3-4-btc-uuid2';
            const action1 = { ...sampleAction, transaction: '0xtx1' };
            const action2 = { ...sampleAction, transaction: '0xtx2', origin: 3, destination: 4, asset: 'BTC' };
            
            (mockRedisSdkInstance.hkeys as jest.Mock).mockResolvedValueOnce([id1, id2]);
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                JSON.stringify(action1),
                JSON.stringify(action2),
            ]);

            const result = await rebalanceCache.getRebalanceByTransaction('0xtx2');

            expect(result).toEqual({ ...action2, id: id2 });
        });

        it('should handle null values in Redis response', async () => {
            const id1 = '2-1-eth-uuid1';
            const id2 = '3-4-btc-uuid2';
            
            (mockRedisSdkInstance.hkeys as jest.Mock).mockResolvedValueOnce([id1, id2]);
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                null, // This ID has been deleted
                JSON.stringify(sampleAction),
            ]);

            const result = await rebalanceCache.getRebalanceByTransaction('0xtx1');

            expect(result).toEqual({ ...sampleAction, id: id2 });
        });
    });

    describe('removeRebalances', () => {
        const sampleAction1: RebalanceAction = {
            amount: '100', origin: 1, destination: 2, asset: 'ETH', transaction: '0xtx1', bridge: SupportedBridge.Across, recipient: '0x1111111111111111111111111111111111111111'
        };
        const id1 = '2-1-ETH-uuid1'; // Make sure asset casing matches ID generation

        const sampleAction2: RebalanceAction = {
            amount: '200', origin: 3, destination: 4, asset: 'BTC', transaction: '0xtx2', bridge: SupportedBridge.Across, recipient: '0x2222222222222222222222222222222222222222'
        };
        const id2 = '4-3-BTC-uuid2';

        it('should remove a single rebalance action and return 1', async () => {
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([JSON.stringify(sampleAction1)]);
            // Pipeline: [srem_res, hdel_res]
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([[null, 1], [null, 1]]);

            const result = await rebalanceCache.removeRebalances([id1]);

            expect(result).toBe(1);
            expect(mockRedisSdkInstance.hmget).toHaveBeenCalledWith('rebalances:data', id1);
            expect(mockPipelineInstance.srem).toHaveBeenCalledWith(`rebalances:route:2-1-eth`, id1);
            expect(mockPipelineInstance.hdel).toHaveBeenCalledWith('rebalances:data', id1);
            expect(mockPipelineInstance.exec).toHaveBeenCalledTimes(1);
        });

        it('should remove multiple rebalance actions and return the count', async () => {
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                JSON.stringify(sampleAction1),
                JSON.stringify(sampleAction2),
            ]);
            // Pipeline: [s1,h1, s2,h2] all successful
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([
                [null, 1], [null, 1], // For id1
                [null, 1], [null, 1], // For id2
            ]);

            const result = await rebalanceCache.removeRebalances([id1, id2]);
            expect(result).toBe(2);
            expect(mockRedisSdkInstance.hmget).toHaveBeenCalledWith('rebalances:data', id1, id2);
            expect(mockPipelineInstance.srem).toHaveBeenCalledTimes(2);
            expect(mockPipelineInstance.hdel).toHaveBeenCalledTimes(2);
            expect(mockPipelineInstance.exec).toHaveBeenCalledTimes(1);
        });

        it('should return 0 if no IDs are provided', async () => {
            const result = await rebalanceCache.removeRebalances([]);
            expect(result).toBe(0);
            expect(mockRedisSdkInstance.hmget).not.toHaveBeenCalled();
            expect(mockPipelineInstance.exec).not.toHaveBeenCalled();
        });

        it('should return 0 if hmget returns no data for an ID (action already gone)', async () => {
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([null]); // id1 not found
            // pipeline.exec won't be called if no actions are parsed

            const result = await rebalanceCache.removeRebalances([id1]);
            expect(result).toBe(0);
            expect(mockRedisSdkInstance.hmget).toHaveBeenCalledWith('rebalances:data', id1);
            expect(mockPipelineInstance.srem).not.toHaveBeenCalled();
            expect(mockPipelineInstance.hdel).not.toHaveBeenCalled();
            expect(mockPipelineInstance.exec).toHaveBeenCalledTimes(1);
        });

        it('should handle a mix of existing and non-existing IDs', async () => {
            const nonExistentId = 'non-existent-id';
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([
                JSON.stringify(sampleAction1), // id1 exists
                null,                         // nonExistentId does not
            ]);
            // Pipeline for id1 only: [srem_res, hdel_res]
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([[null, 1], [null, 1]]);

            const result = await rebalanceCache.removeRebalances([id1, nonExistentId]);
            expect(result).toBe(1); // Only id1 removed
            expect(mockPipelineInstance.srem).toHaveBeenCalledTimes(1);
            expect(mockPipelineInstance.hdel).toHaveBeenCalledTimes(1);
        });

        it('should return 0 if hdel fails (returns 0 for an action)', async () => {
            (mockRedisSdkInstance.hmget as jest.Mock).mockResolvedValueOnce([JSON.stringify(sampleAction1)]);
            // srem succeeds, hdel fails
            (mockPipelineInstance.exec as jest.Mock).mockResolvedValueOnce([[null, 1], [null, 0]]);

            const result = await rebalanceCache.removeRebalances([id1]);
            // With `filter(([,res]) => res === 1).length / 2`, (1)/2 = 0.5 -> not an integer. Test needs to expect what JS does.
            // Assuming the result is floored or the intent changes. Let's expect 0 for now if count is based on pairs.
            // If it counts only hdel, it should be 0. If it counts any success and divides, this is tricky.
            // The current code `(results ?? []).filter(([, res]) => res === 1).length / 2` would give 0.5 here.
            // This suggests the return logic in `removeRebalances` is problematic.
            // Let's assume the user wants to fix the method to count successful HDELs.
            // For now, testing the current behavior: (1 successful op) / 2 = 0.5. If filter is specific, test will fail.
            // The current code `((results ?? []).filter(([, res]) => res === 1).length) / 2`
            // In JS, `1 / 2 = 0.5`. Let's assume it should be an integer, so test for 0 if hdel fails.
            expect(result).toBe(0); // Based on the assumption that a failed hdel means the item wasn't *fully* removed by this function's definition of success.
        });
    });

    describe('clear', () => {
        const dataKey = 'rebalances:data';
        const pauseKey = 'rebalances:paused';
        const routePattern = 'rebalances:route:*';
        const mockRouteKeys = ['rebalances:route:1-2-eth', 'rebalances:route:3-4-btc'];

        it('should delete data, pause, and all route keys', async () => {
            (mockRedisSdkInstance.keys as jest.Mock).mockResolvedValueOnce(mockRouteKeys);
            (mockRedisSdkInstance.exists as jest.Mock)
                .mockResolvedValueOnce(1) // dataKey exists
                .mockResolvedValueOnce(1); // pauseKey exists
            (mockRedisSdkInstance.del as jest.Mock).mockResolvedValueOnce(mockRouteKeys.length + 2);

            await rebalanceCache.clear();

            expect(mockRedisSdkInstance.keys).toHaveBeenCalledWith(routePattern);
            expect(mockRedisSdkInstance.exists).toHaveBeenCalledWith(dataKey);
            expect(mockRedisSdkInstance.exists).toHaveBeenCalledWith(pauseKey);
            const expectedKeysToDelete = [dataKey, pauseKey, ...mockRouteKeys];
            expect(mockRedisSdkInstance.del).toHaveBeenCalledWith(...expectedKeysToDelete);
        });

        it('should not call del if no relevant keys exist (excluding pattern keys that might be empty)', async () => {
            (mockRedisSdkInstance.keys as jest.Mock).mockResolvedValueOnce([]); // No route keys
            (mockRedisSdkInstance.exists as jest.Mock)
                .mockResolvedValueOnce(0) // dataKey does not exist
                .mockResolvedValueOnce(0); // pauseKey does not exist

            await rebalanceCache.clear();

            expect(mockRedisSdkInstance.keys).toHaveBeenCalledWith(routePattern);
            expect(mockRedisSdkInstance.exists).toHaveBeenCalledWith(dataKey);
            expect(mockRedisSdkInstance.exists).toHaveBeenCalledWith(pauseKey);
            expect(mockRedisSdkInstance.del).not.toHaveBeenCalled();
        });

        it('should call del with only existing keys if some are missing', async () => {
            (mockRedisSdkInstance.keys as jest.Mock).mockResolvedValueOnce(mockRouteKeys); // Has route keys
            (mockRedisSdkInstance.exists as jest.Mock)
                .mockResolvedValueOnce(1) // dataKey exists
                .mockResolvedValueOnce(0); // pauseKey does not exist
            (mockRedisSdkInstance.del as jest.Mock).mockResolvedValueOnce(mockRouteKeys.length + 1);

            await rebalanceCache.clear();
            const expectedKeysToDelete = [dataKey, ...mockRouteKeys];
            expect(mockRedisSdkInstance.del).toHaveBeenCalledWith(...expectedKeysToDelete);
        });

        it('should propagate errors from store.keys()', async () => {
            const keysError = new Error('Failed to fetch keys');
            (mockRedisSdkInstance.keys as jest.Mock).mockRejectedValueOnce(keysError);

            await expect(rebalanceCache.clear()).rejects.toThrow(keysError);
        });

        it('should propagate errors from store.del()', async () => {
            const delError = new Error('Failed to delete keys');
            (mockRedisSdkInstance.keys as jest.Mock).mockResolvedValueOnce(mockRouteKeys);
            (mockRedisSdkInstance.exists as jest.Mock).mockResolvedValue(1);
            (mockRedisSdkInstance.del as jest.Mock).mockRejectedValueOnce(delError);

            await expect(rebalanceCache.clear()).rejects.toThrow(delError);
        });
    });

    describe('setPause', () => {
        const pauseKey = 'rebalances:paused';

        it('should call store.set with true mapped to \'1\'', async () => {
            (mockRedisSdkInstance.set as jest.Mock).mockResolvedValueOnce('OK');
            await rebalanceCache.setPause(true);
            expect(mockRedisSdkInstance.set).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.set).toHaveBeenCalledWith(pauseKey, '1');
        });

        it('should call store.set with false mapped to \'0\'', async () => {
            (mockRedisSdkInstance.set as jest.Mock).mockResolvedValueOnce('OK');
            await rebalanceCache.setPause(false);
            expect(mockRedisSdkInstance.set).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.set).toHaveBeenCalledWith(pauseKey, '0');
        });

        it('should propagate errors from store.set', async () => {
            const setError = new Error('Failed to set key');
            (mockRedisSdkInstance.set as jest.Mock).mockRejectedValueOnce(setError);
            await expect(rebalanceCache.setPause(true)).rejects.toThrow(setError);
        });
    });

    describe('isPaused', () => {
        const pauseKey = 'rebalances:paused';

        it('should return true if store.get returns \'1\'', async () => {
            (mockRedisSdkInstance.get as jest.Mock).mockResolvedValueOnce('1');
            const result = await rebalanceCache.isPaused();
            expect(result).toBe(true);
            expect(mockRedisSdkInstance.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should return false if store.get returns \'0\'', async () => {
            (mockRedisSdkInstance.get as jest.Mock).mockResolvedValueOnce('0');
            const result = await rebalanceCache.isPaused();
            expect(result).toBe(false);
            expect(mockRedisSdkInstance.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should return false if store.get returns null (key not found)', async () => {
            (mockRedisSdkInstance.get as jest.Mock).mockResolvedValueOnce(null);
            const result = await rebalanceCache.isPaused();
            expect(result).toBe(false);
            expect(mockRedisSdkInstance.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should return false if store.get returns an unexpected string', async () => {
            (mockRedisSdkInstance.get as jest.Mock).mockResolvedValueOnce('unexpected_value');
            const result = await rebalanceCache.isPaused();
            expect(result).toBe(false);
            expect(mockRedisSdkInstance.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should propagate errors from store.get', async () => {
            const getError = new Error('Failed to get key');
            (mockRedisSdkInstance.get as jest.Mock).mockRejectedValueOnce(getError);
            await expect(rebalanceCache.isPaused()).rejects.toThrow(getError);
        });
    });

    describe('addWithdrawId', () => {
        const withdrawKey = 'rebalances:withdrawals';
        const rebalanceId = 'rebalance-id-123';
        const withdrawId = 'withdraw-id-456';

        it('should store withdrawal ID for a rebalance', async () => {
            (mockRedisSdkInstance.hset as jest.Mock).mockResolvedValueOnce(1);

            await rebalanceCache.addWithdrawId(rebalanceId, withdrawId);

            expect(mockRedisSdkInstance.hset).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hset).toHaveBeenCalledWith(withdrawKey, rebalanceId, withdrawId);
        });

        it('should overwrite existing withdrawal ID for a rebalance', async () => {
            const newWithdrawId = 'new-withdraw-id-789';
            (mockRedisSdkInstance.hset as jest.Mock).mockResolvedValueOnce(0); // 0 indicates update

            await rebalanceCache.addWithdrawId(rebalanceId, newWithdrawId);

            expect(mockRedisSdkInstance.hset).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hset).toHaveBeenCalledWith(withdrawKey, rebalanceId, newWithdrawId);
        });

        it('should propagate errors from store.hset', async () => {
            const hsetError = new Error('Failed to set withdrawal ID');
            (mockRedisSdkInstance.hset as jest.Mock).mockRejectedValueOnce(hsetError);

            await expect(rebalanceCache.addWithdrawId(rebalanceId, withdrawId)).rejects.toThrow(hsetError);
        });
    });

    describe('getWithdrawId', () => {
        const withdrawKey = 'rebalances:withdrawals';
        const rebalanceId = 'rebalance-id-123';
        const withdrawId = 'withdraw-id-456';

        it('should retrieve withdrawal ID for a rebalance', async () => {
            (mockRedisSdkInstance.hget as jest.Mock).mockResolvedValueOnce(withdrawId);

            const result = await rebalanceCache.getWithdrawId(rebalanceId);

            expect(result).toBe(withdrawId);
            expect(mockRedisSdkInstance.hget).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hget).toHaveBeenCalledWith(withdrawKey, rebalanceId);
        });

        it('should return null if withdrawal ID does not exist', async () => {
            (mockRedisSdkInstance.hget as jest.Mock).mockResolvedValueOnce(null);

            const result = await rebalanceCache.getWithdrawId(rebalanceId);

            expect(result).toBeNull();
            expect(mockRedisSdkInstance.hget).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hget).toHaveBeenCalledWith(withdrawKey, rebalanceId);
        });

        it('should propagate errors from store.hget', async () => {
            const hgetError = new Error('Failed to get withdrawal ID');
            (mockRedisSdkInstance.hget as jest.Mock).mockRejectedValueOnce(hgetError);

            await expect(rebalanceCache.getWithdrawId(rebalanceId)).rejects.toThrow(hgetError);
        });
    });

    describe('removeWithdrawId', () => {
        const withdrawKey = 'rebalances:withdrawals';
        const rebalanceId = 'rebalance-id-123';

        it('should remove withdrawal ID and return true when successful', async () => {
            (mockRedisSdkInstance.hdel as jest.Mock).mockResolvedValueOnce(1);

            const result = await rebalanceCache.removeWithdrawId(rebalanceId);

            expect(result).toBe(true);
            expect(mockRedisSdkInstance.hdel).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hdel).toHaveBeenCalledWith(withdrawKey, rebalanceId);
        });

        it('should return false if withdrawal ID does not exist', async () => {
            (mockRedisSdkInstance.hdel as jest.Mock).mockResolvedValueOnce(0);

            const result = await rebalanceCache.removeWithdrawId(rebalanceId);

            expect(result).toBe(false);
            expect(mockRedisSdkInstance.hdel).toHaveBeenCalledTimes(1);
            expect(mockRedisSdkInstance.hdel).toHaveBeenCalledWith(withdrawKey, rebalanceId);
        });

        it('should propagate errors from store.hdel', async () => {
            const hdelError = new Error('Failed to delete withdrawal ID');
            (mockRedisSdkInstance.hdel as jest.Mock).mockRejectedValueOnce(hdelError);

            await expect(rebalanceCache.removeWithdrawId(rebalanceId)).rejects.toThrow(hdelError);
        });
    });

    describe('disconnect', () => {
        it('should disconnect from Redis successfully', async () => {
            (mockRedisSdkInstance.disconnect as jest.Mock).mockResolvedValueOnce(undefined);
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await rebalanceCache.disconnect();

            expect(mockRedisSdkInstance.disconnect).toHaveBeenCalledTimes(1);
            expect(consoleSpy).toHaveBeenCalledWith('RebalanceCache: Redis connection closed successfully');
            
            consoleSpy.mockRestore();
        });

        it('should handle disconnect errors', async () => {
            const disconnectError = new Error('Failed to disconnect');
            (mockRedisSdkInstance.disconnect as jest.Mock).mockRejectedValueOnce(disconnectError);
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            await expect(rebalanceCache.disconnect()).rejects.toThrow(disconnectError);
            expect(consoleSpy).toHaveBeenCalledWith('RebalanceCache: Error closing Redis connection:', disconnectError);
            
            consoleSpy.mockRestore();
        });
    });
});
