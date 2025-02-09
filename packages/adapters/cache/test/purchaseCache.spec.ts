import Redis from 'ioredis';
import { PurchaseCache, PurchaseAction } from '../src/purchaseCache';
import { NewIntentParams, Invoice } from '@mark/core';

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
            origin: '1',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xasset',
            amount: '100000',
            callData: '0x',
            maxFee: '0'
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
    });

    describe('clear', () => {
        it('should clear the cache successfully', async () => {
            mockRedis.flushall.mockResolvedValue('OK');

            await expect(cache.clear()).resolves.toBeUndefined();
            expect(mockRedis.flushall).toHaveBeenCalled();
        });

        it('should throw error when flush fails', async () => {
            mockRedis.flushall.mockImplementation(async () => {
                throw new Error('Failed to clear store');
            });

            await expect(cache.clear()).rejects.toThrow('Failed to clear store');
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
}); 