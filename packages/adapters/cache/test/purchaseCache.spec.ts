import Redis from 'ioredis';
import { PurchaseCache, PurchaseAction } from '../src/purchaseCache';
import { Invoice } from '@mark/core';

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
    };

    beforeEach(() => {
        cache = new PurchaseCache('host', 1010);
        mockRedis = (cache as any).store as jest.Mocked<Redis>;
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
        it('should clear the cache successfully', async () => {
            mockRedis.flushall.mockResolvedValue('OK');

            await expect(cache.clear()).resolves.toBeUndefined();
            expect(mockRedis.flushall).toHaveBeenCalled();
        });

        it('should throw error when flushall returns a non-OK string', async () => {
            const redisErrorMessage = 'FLUSHALL_ERROR';
            mockRedis.flushall.mockResolvedValue(redisErrorMessage as any); // Resolves with a non-'OK' string

            await expect(cache.clear()).rejects.toThrow(
                `Failed to clear store: "${redisErrorMessage}"`
            );
            expect(mockRedis.flushall).toHaveBeenCalledTimes(1);
        });

        it('should throw error when flushall itself rejects (e.g. connection issue)', async () => {
            const connectionError = new Error('Connection refused');
            mockRedis.flushall.mockRejectedValue(connectionError); // flushall() itself throws an error

            await expect(cache.clear()).rejects.toThrow(connectionError);
            expect(mockRedis.flushall).toHaveBeenCalledTimes(1);
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
    });
}); 