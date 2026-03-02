import Redis from 'ioredis';
import { PurchaseCache, PurchaseAction } from '../src/purchaseCache';
import { Invoice, TransactionSubmissionType } from '@mark/core';

// Mock Redis
jest.mock('ioredis');

describe('PurchaseCache', () => {
    let cache: PurchaseCache;
    let mockRedis: jest.Mocked<Redis>;

    const mockInvoice: Invoice = {
        intent_id: 'test-intent-1',
        amount: '1000000000000000000', // 1 ETH in wei
        owner: '0x1234567890123456789012345678901234567890',
        entry_epoch: 1234567,
        origin: '10',
        destinations: ['1'],
        ticker_hash: 'ticker-hash',
        discountBps: 1.2,
        hub_status: 'INVOICED',
        hub_invoice_enqueued_timestamp: 1234567890,
    };

    const mockPurchaseAction: PurchaseAction = {
        target: mockInvoice,
        transactionType: TransactionSubmissionType.Onchain,
        purchase: {
            intentId: '0xpurchaseid',
            params: {
                origin: '1',
                destinations: ['1', '10'],
                to: '0xowner',
                inputAsset: '0xasset',
                amount: '100000',
                callData: '0x',
                maxFee: '0'
            }
        },
        transactionHash: '0x123',
        cachedAt: Math.floor(Date.now() / 1000)
    };

    beforeEach(() => {
        cache = new PurchaseCache('host', 1010);
        mockRedis = (cache as any).store as jest.Mocked<Redis>;
        mockRedis.exists = jest.fn();
        mockRedis.del = jest.fn();
        mockRedis.keys = jest.fn();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('addPurchases', () => {
        it('should store purchase actions successfully', async () => {
            mockRedis.hset.mockResolvedValue(1);

            const result = await cache.addPurchases([mockPurchaseAction]);

            expect(result).toBe(1);
            expect(mockRedis.hset).toHaveBeenCalledWith(
                'purchases:data',
                mockPurchaseAction.target.intent_id,
                JSON.stringify(mockPurchaseAction)
            );
        });

        it('should handle multiple purchase actions', async () => {
            mockRedis.hset.mockResolvedValue(1);

            const actions = [
                mockPurchaseAction,
                {
                    ...mockPurchaseAction,
                    target: { ...mockInvoice, intent_id: 'test-intent-2' },
                },
            ];

            const result = await cache.addPurchases(actions);

            expect(result).toBe(2);
            expect(mockRedis.hset).toHaveBeenCalledTimes(2);
        });

        it('should return 0 if actions array is empty', async () => {
            const result = await cache.addPurchases([]);
            expect(result).toBe(0);
            expect(mockRedis.hset).not.toHaveBeenCalled();
        });

        it('should correctly sum results when hset returns 0 (field updated)', async () => {
            // Simulate one new field and one updated field
            mockRedis.hset
                .mockResolvedValueOnce(1) // First call adds a new field
                .mockResolvedValueOnce(0); // Second call updates an existing field

            const actions = [
                mockPurchaseAction,
                {
                    ...mockPurchaseAction,
                    target: { ...mockInvoice, intent_id: 'test-intent-2' },
                },
            ];
            const result = await cache.addPurchases(actions);

            expect(result).toBe(1); // 1 (new) + 0 (updated) = 1
            expect(mockRedis.hset).toHaveBeenCalledTimes(2);
        });
    });

    describe('getPurchases', () => {
        it('should retrieve purchase actions successfully', async () => {
            mockRedis.hmget.mockResolvedValue([JSON.stringify(mockPurchaseAction)]);

            const result = await cache.getPurchases(['test-intent-1']);

            expect(result).toEqual([mockPurchaseAction]);
            expect(mockRedis.hmget).toHaveBeenCalledWith(
                'purchases:data',
                'test-intent-1'
            );
        });

        it('should filter out null results', async () => {
            mockRedis.hmget.mockResolvedValue([null, JSON.stringify(mockPurchaseAction)]);

            const result = await cache.getPurchases(['non-existent', 'test-intent-1']);

            expect(result).toEqual([mockPurchaseAction]);
        });

        it('should handle corrupted JSON data gracefully', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            mockRedis.hmget.mockResolvedValue(['invalid-json{', JSON.stringify(mockPurchaseAction)]);

            const result = await cache.getPurchases(['corrupted', 'test-intent-1']);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(mockPurchaseAction);
            expect(consoleSpy).toHaveBeenCalledWith(
                'Failed to parse purchase data, skipping corrupted entry:',
                expect.any(SyntaxError)
            );
            consoleSpy.mockRestore();
        });

        it('should return an empty array if targetIds is empty', async () => {
            // If targetIds is empty, hmget might be called with just the key,
            // or the mock might need to handle ...targetIds spreading an empty array.
            // Let's assume hmget returns an empty array in this case.
            mockRedis.hmget.mockResolvedValue([]);

            const result = await cache.getPurchases([]);

            expect(result).toEqual([]);
            // Verify hmget was called, possibly with only the key if targetIds is empty
            // or that it handles the spread of an empty array gracefully.
            expect(mockRedis.hmget).toHaveBeenCalledWith('purchases:data');
        });
    });

    describe('removePurchases', () => {
        it('should remove purchase actions successfully', async () => {
            mockRedis.hdel.mockResolvedValue(1);

            const result = await cache.removePurchases(['test-intent-1']);

            expect(result).toBe(1);
            expect(mockRedis.hdel).toHaveBeenCalledWith(
                'purchases:data',
                'test-intent-1'
            );
        });

        it('should return 0 if targetIds array is empty', async () => {
            const result = await cache.removePurchases([]);
            expect(result).toBe(0);
            expect(mockRedis.hdel).not.toHaveBeenCalled();
        });
    });

    describe('clear', () => {
        const dataKey = 'purchases:data';
        const pauseKey = 'purchases:paused';

        it('should delete data and pause keys if they exist', async () => {
            (mockRedis.exists as jest.Mock)
                .mockResolvedValueOnce(1) // dataKey exists
                .mockResolvedValueOnce(1); // pauseKey exists
            (mockRedis.del as jest.Mock).mockResolvedValueOnce(2); // Simulating 2 keys deleted

            await cache.clear();

            expect(mockRedis.exists).toHaveBeenCalledWith(dataKey);
            expect(mockRedis.exists).toHaveBeenCalledWith(pauseKey);
            expect(mockRedis.del).toHaveBeenCalledWith(dataKey, pauseKey);
        });

        it('should not call del if data and pause keys do not exist', async () => {
            (mockRedis.exists as jest.Mock)
                .mockResolvedValueOnce(0) // dataKey does not exist
                .mockResolvedValueOnce(0); // pauseKey does not exist

            await cache.clear();

            expect(mockRedis.exists).toHaveBeenCalledWith(dataKey);
            expect(mockRedis.exists).toHaveBeenCalledWith(pauseKey);
            expect(mockRedis.del).not.toHaveBeenCalled();
        });

        it('should call del with only the key that exists', async () => {
            (mockRedis.exists as jest.Mock)
                .mockResolvedValueOnce(1) // dataKey exists
                .mockResolvedValueOnce(0); // pauseKey does not exist
            (mockRedis.del as jest.Mock).mockResolvedValueOnce(1);

            await cache.clear();

            expect(mockRedis.del).toHaveBeenCalledWith(dataKey);
        });

        it('should propagate errors from store.del()', async () => {
            const delError = new Error('Failed to delete keys');
            (mockRedis.exists as jest.Mock).mockResolvedValue(1); // Assume keys exist for this test
            (mockRedis.del as jest.Mock).mockRejectedValueOnce(delError);

            await expect(cache.clear()).rejects.toThrow(delError);
        });
    });

    describe('hasPurchase', () => {
        it('should return true when purchase exists', async () => {
            mockRedis.hexists.mockResolvedValue(1);

            const result = await cache.hasPurchase('test-intent-1');

            expect(result).toBe(true);
            expect(mockRedis.hexists).toHaveBeenCalledWith(
                'purchases:data',
                'test-intent-1'
            );
        });

        it('should return false when purchase does not exist', async () => {
            mockRedis.hexists.mockResolvedValue(0);

            const result = await cache.hasPurchase('non-existent');

            expect(result).toBe(false);
        });
    });

    describe('getAllPurchases', () => {
        it('should return all purchase actions from the cache', async () => {
            const action2: PurchaseAction = {
                ...mockPurchaseAction,
                target: { ...mockInvoice, intent_id: 'test-intent-2' },
                transactionHash: '0x456',
            };
            mockRedis.hgetall.mockResolvedValue({
                [mockPurchaseAction.target.intent_id]: JSON.stringify(mockPurchaseAction),
                [action2.target.intent_id]: JSON.stringify(action2),
            });

            const result = await cache.getAllPurchases();

            expect(result).toHaveLength(2);
            // Order might not be guaranteed from hgetall, so check for presence
            expect(result).toContainEqual(mockPurchaseAction);
            expect(result).toContainEqual(action2);
            expect(mockRedis.hgetall).toHaveBeenCalledWith('purchases:data');
        });

        it('should return an empty array if the cache is empty', async () => {
            mockRedis.hgetall.mockResolvedValue({}); // Empty object for no items

            const result = await cache.getAllPurchases();

            expect(result).toEqual([]);
            expect(mockRedis.hgetall).toHaveBeenCalledWith('purchases:data');
        });

        it('should handle corrupted JSON data gracefully', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            mockRedis.hgetall.mockResolvedValue({
                'corrupted': 'invalid-json{',
                [mockPurchaseAction.target.intent_id]: JSON.stringify(mockPurchaseAction),
            });

            const result = await cache.getAllPurchases();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(mockPurchaseAction);
            expect(consoleSpy).toHaveBeenCalledWith(
                'Failed to parse purchase data in getAllPurchases, skipping corrupted entry:',
                expect.any(SyntaxError)
            );
            consoleSpy.mockRestore();
        });
    });

    describe('setPause', () => {
        const pauseKey = 'purchases:paused';

        it('should call store.set with true mapped to \'1\'', async () => {
            (mockRedis.set as jest.Mock).mockResolvedValueOnce('OK');
            await cache.setPause(true);
            expect(mockRedis.set).toHaveBeenCalledTimes(1);
            expect(mockRedis.set).toHaveBeenCalledWith(pauseKey, '1');
        });

        it('should call store.set with false mapped to \'0\'', async () => {
            (mockRedis.set as jest.Mock).mockResolvedValueOnce('OK');
            await cache.setPause(false);
            expect(mockRedis.set).toHaveBeenCalledTimes(1);
            expect(mockRedis.set).toHaveBeenCalledWith(pauseKey, '0');
        });

        it('should propagate errors from store.set', async () => {
            const setError = new Error('Failed to set key');
            (mockRedis.set as jest.Mock).mockRejectedValueOnce(setError);
            await expect(cache.setPause(true)).rejects.toThrow(setError);
        });
    });

    describe('isPaused', () => {
        const pauseKey = 'purchases:paused';

        it('should return true if store.get returns \'1\'', async () => {
            (mockRedis.get as jest.Mock).mockResolvedValueOnce('1');
            const result = await cache.isPaused();
            expect(result).toBe(true);
            expect(mockRedis.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should return false if store.get returns \'0\'', async () => {
            (mockRedis.get as jest.Mock).mockResolvedValueOnce('0');
            const result = await cache.isPaused();
            expect(result).toBe(false);
            expect(mockRedis.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should return false if store.get returns null (key not found)', async () => {
            (mockRedis.get as jest.Mock).mockResolvedValueOnce(null);
            const result = await cache.isPaused();
            expect(result).toBe(false);
            expect(mockRedis.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should return false if store.get returns an unexpected string', async () => {
            (mockRedis.get as jest.Mock).mockResolvedValueOnce('unexpected_value');
            const result = await cache.isPaused();
            expect(result).toBe(false);
            expect(mockRedis.get).toHaveBeenCalledWith(pauseKey);
        });

        it('should propagate errors from store.get', async () => {
            const getError = new Error('Failed to get key');
            (mockRedis.get as jest.Mock).mockRejectedValueOnce(getError);
            await expect(cache.isPaused()).rejects.toThrow(getError);
        });
    });
}); 