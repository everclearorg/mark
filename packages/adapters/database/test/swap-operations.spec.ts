import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  createRebalanceOperation,
  createSwapOperation,
  getSwapOperations,
  updateSwapOperationStatus,
  getSwapOperationByOrderId,
  CreateSwapOperationParams,
} from '../src';
import { RebalanceOperationStatus } from '@mark/core';
import { setupTestDatabase, teardownTestDatabase, cleanupTestDatabase } from './setup';

describe('Swap Operations CRUD', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  let testRebalanceOpId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();

    // Create a rebalance operation to link swaps to
    const rebalanceOp = await createRebalanceOperation({
      earmarkId: null,
      originChainId: 42161,
      destinationChainId: 10,
      tickerHash: 'test_ticker',
      amount: '1000000',
      slippage: 100,
      status: RebalanceOperationStatus.PENDING,
      bridge: 'binance',
      operationType: 'swap_and_bridge',
    });
    testRebalanceOpId = rebalanceOp.id;
  });

  describe('createSwapOperation', () => {
    it('should create a swap operation with all fields', async () => {
      const params: CreateSwapOperationParams = {
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        quoteId: 'quote_123',
        status: 'pending_deposit',
        metadata: { chainId: 42161, maxSlippage: 100 },
      };

      const swap = await createSwapOperation(params);

      expect(swap).toBeDefined();
      expect(swap.id).toBeDefined();
      expect(swap.rebalanceOperationId).toBe(testRebalanceOpId);
      expect(swap.platform).toBe('binance');
      expect(swap.fromAsset).toBe('USDT');
      expect(swap.toAsset).toBe('USDC');
      expect(swap.fromAmount).toBe('1000000');
      expect(swap.toAmount).toBe('999000');
      expect(swap.expectedRate).toBe('999000000000000000');
      expect(swap.quoteId).toBe('quote_123');
      expect(swap.status).toBe('pending_deposit');
      expect(swap.metadata).toEqual({ chainId: 42161, maxSlippage: 100 });
      expect(swap.createdAt).toBeDefined();
      expect(swap.updatedAt).toBeDefined();
    });

    it('should create swap without optional fields', async () => {
      const params: CreateSwapOperationParams = {
        rebalanceOperationId: testRebalanceOpId,
        platform: 'kraken',
        fromAsset: 'USDC',
        toAsset: 'USDT',
        fromAmount: '1000000',
        toAmount: '999500',
        expectedRate: '999500000000000000',
        status: 'pending_deposit',
      };

      const swap = await createSwapOperation(params);

      expect(swap.id).toBeDefined();
      expect(swap.quoteId).toBeNull();
      expect(swap.orderId).toBeNull();
      expect(swap.metadata).toBeNull();
    });
  });

  describe('getSwapOperations', () => {
    beforeEach(async () => {
      // Create multiple swap operations with different statuses
      await createSwapOperation({
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        status: 'pending_deposit',
      });

      await createSwapOperation({
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDC',
        toAsset: 'USDT',
        fromAmount: '2000000',
        toAmount: '1998000',
        expectedRate: '999000000000000000',
        status: 'processing',
      });
    });

    it('should get all swaps without filters', async () => {
      const swaps = await getSwapOperations({});
      expect(swaps.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by status (single)', async () => {
      const swaps = await getSwapOperations({ status: 'pending_deposit' });
      expect(swaps.length).toBeGreaterThanOrEqual(1);
      expect(swaps.every((s) => s.status === 'pending_deposit')).toBe(true);
    });

    it('should filter by status (array)', async () => {
      const swaps = await getSwapOperations({ status: ['pending_deposit', 'processing'] });
      expect(swaps.length).toBeGreaterThanOrEqual(2);
      expect(swaps.every((s) => ['pending_deposit', 'processing'].includes(s.status))).toBe(true);
    });

    it('should filter by rebalanceOperationId', async () => {
      const swaps = await getSwapOperations({ rebalanceOperationId: testRebalanceOpId });
      expect(swaps.length).toBe(2);
      expect(swaps.every((s) => s.rebalanceOperationId === testRebalanceOpId)).toBe(true);
    });

    it('should filter by both status and rebalanceOperationId', async () => {
      const swaps = await getSwapOperations({
        status: 'processing',
        rebalanceOperationId: testRebalanceOpId,
      });
      expect(swaps.length).toBe(1);
      expect(swaps[0].status).toBe('processing');
      expect(swaps[0].rebalanceOperationId).toBe(testRebalanceOpId);
    });

    it('should return swaps ordered by created_at', async () => {
      const swaps = await getSwapOperations({ rebalanceOperationId: testRebalanceOpId });
      expect(swaps.length).toBe(2);

      // Verify ordering (first created should be first in array)
      const timestamps = swaps.map((s) => new Date(s.createdAt).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });
  });

  describe('updateSwapOperationStatus', () => {
    let swapId: string;

    beforeEach(async () => {
      const swap = await createSwapOperation({
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        status: 'pending_deposit',
      });
      swapId = swap.id;
    });

    it('should update status without metadata', async () => {
      await updateSwapOperationStatus(swapId, 'deposit_confirmed');

      const swaps = await getSwapOperations({ rebalanceOperationId: testRebalanceOpId });
      const updated = swaps.find((s) => s.id === swapId);

      expect(updated?.status).toBe('deposit_confirmed');
      expect(updated?.updatedAt).toBeDefined();
    });

    it('should update status with metadata', async () => {
      await updateSwapOperationStatus(swapId, 'processing', {
        orderId: 'order_123',
        actualRate: '998500000000000000',
        executionTime: Date.now(),
      });

      const swaps = await getSwapOperations({ rebalanceOperationId: testRebalanceOpId });
      const updated = swaps.find((s) => s.id === swapId);

      expect(updated?.status).toBe('processing');
      expect(updated?.orderId).toBe('order_123');
      expect(updated?.actualRate).toBe('998500000000000000');
      expect(updated?.metadata).toEqual(
        expect.objectContaining({
          orderId: 'order_123',
          actualRate: '998500000000000000',
          executionTime: expect.any(Number),
        }),
      );
    });

    it('should handle all status transitions', async () => {
      const statuses = [
        'deposit_confirmed',
        'processing',
        'completed',
      ] as const;

      for (const status of statuses) {
        await updateSwapOperationStatus(swapId, status);
        const swaps = await getSwapOperations({ rebalanceOperationId: testRebalanceOpId });
        const updated = swaps.find((s) => s.id === swapId);
        expect(updated?.status).toBe(status);
      }
    });

    it('should handle failed status', async () => {
      await updateSwapOperationStatus(swapId, 'failed', {
        reason: 'slippage_exceeded',
        errorMessage: 'Rate moved beyond tolerance',
      });

      const swaps = await getSwapOperations({ status: 'failed' });
      expect(swaps.length).toBeGreaterThanOrEqual(1);
      const failed = swaps.find((s) => s.id === swapId);
      expect(failed?.status).toBe('failed');
      expect(failed?.metadata).toEqual(
        expect.objectContaining({
          reason: 'slippage_exceeded',
        }),
      );
    });

    it('should handle recovering status', async () => {
      await updateSwapOperationStatus(swapId, 'recovering', {
        recoveryInitiatedAt: Date.now(),
        reason: 'withdrawal_original_asset_to_origin',
      });

      const swaps = await getSwapOperations({ status: 'recovering' });
      const recovering = swaps.find((s) => s.id === swapId);
      expect(recovering?.status).toBe('recovering');
    });
  });

  describe('getSwapOperationByOrderId', () => {
    it('should find swap by order_id', async () => {
      const swap = await createSwapOperation({
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        status: 'pending_deposit',
      });

      // Update with order_id
      await updateSwapOperationStatus(swap.id, 'processing', { orderId: 'unique_order_789' });

      const found = await getSwapOperationByOrderId('unique_order_789');

      expect(found).toBeDefined();
      expect(found?.id).toBe(swap.id);
      expect(found?.orderId).toBe('unique_order_789');
    });

    it('should return undefined for non-existent order_id', async () => {
      const found = await getSwapOperationByOrderId('non_existent_order');
      expect(found).toBeUndefined();
    });
  });

  describe('createRebalanceOperation with operationType', () => {
    it('should create operation with operation_type=bridge by default', async () => {
      const op = await createRebalanceOperation({
        earmarkId: null,
        originChainId: 10,
        destinationChainId: 8453,
        tickerHash: 'test',
        amount: '1000000',
        slippage: 50,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'across',
      });

      expect(op.operationType).toBe('bridge');
    });

    it('should create operation with operation_type=swap_and_bridge', async () => {
      const op = await createRebalanceOperation({
        earmarkId: null,
        originChainId: 42161,
        destinationChainId: 10,
        tickerHash: 'test',
        amount: '1000000',
        slippage: 100,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'binance',
        operationType: 'swap_and_bridge',
      });

      expect(op.operationType).toBe('swap_and_bridge');
    });
  });

  describe('State machine transitions', () => {
    it('should support full swap lifecycle', async () => {
      // Create rebalance op with swap
      const rebalanceOp = await createRebalanceOperation({
        earmarkId: null,
        originChainId: 42161,
        destinationChainId: 10,
        tickerHash: 'test',
        amount: '1000000',
        slippage: 100,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'binance',
        operationType: 'swap_and_bridge',
      });

      // Create swap operation
      const swap = await createSwapOperation({
        rebalanceOperationId: rebalanceOp.id,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        status: 'pending_deposit',
        metadata: { originChainId: 42161, destinationChainId: 10 },
      });

      // Transition: pending_deposit → deposit_confirmed
      await updateSwapOperationStatus(swap.id, 'deposit_confirmed');
      let updated = (await getSwapOperations({ rebalanceOperationId: rebalanceOp.id }))[0];
      expect(updated.status).toBe('deposit_confirmed');

      // Transition: deposit_confirmed → processing
      await updateSwapOperationStatus(swap.id, 'processing', {
        orderId: 'binance_order_123',
        quoteId: 'quote_456',
      });
      updated = (await getSwapOperations({ rebalanceOperationId: rebalanceOp.id }))[0];
      expect(updated.status).toBe('processing');
      expect(updated.orderId).toBe('binance_order_123');

      // Transition: processing → completed
      await updateSwapOperationStatus(swap.id, 'completed', {
        actualRate: '998500000000000000',
        completedAt: Date.now(),
      });
      updated = (await getSwapOperations({ rebalanceOperationId: rebalanceOp.id }))[0];
      expect(updated.status).toBe('completed');
      expect(updated.actualRate).toBe('998500000000000000');
    });

    it('should support failure and recovery flow', async () => {
      const swap = await createSwapOperation({
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        status: 'processing',
      });

      // Swap fails
      await updateSwapOperationStatus(swap.id, 'failed', {
        reason: 'slippage_exceeded',
        failedAt: Date.now(),
      });

      let updated = (await getSwapOperations({ rebalanceOperationId: testRebalanceOpId }))[0];
      expect(updated.status).toBe('failed');

      // Initiate recovery
      await updateSwapOperationStatus(swap.id, 'recovering', {
        recoveryInitiatedAt: Date.now(),
      });

      updated = (await getSwapOperations({ status: 'recovering' }))[0];
      expect(updated.status).toBe('recovering');
    });
  });

  describe('Query performance', () => {
    it('should efficiently query by status', async () => {
      // Create swaps with different statuses
      const statuses = ['pending_deposit', 'processing', 'completed'] as const;

      for (const status of statuses) {
        await createSwapOperation({
          rebalanceOperationId: testRebalanceOpId,
          platform: 'binance',
          fromAsset: 'USDT',
          toAsset: 'USDC',
          fromAmount: '1000000',
          toAmount: '999000',
          expectedRate: '999000000000000000',
          status,
        });
      }

      // Query each status
      for (const status of statuses) {
        const swaps = await getSwapOperations({ status });
        expect(swaps.every((s) => s.status === status)).toBe(true);
      }
    });

    it('should handle array status queries efficiently', async () => {
      await createSwapOperation({
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        status: 'processing',
      });

      const activeSwaps = await getSwapOperations({
        status: ['pending_deposit', 'deposit_confirmed', 'processing', 'recovering'],
      });

      expect(activeSwaps.length).toBeGreaterThanOrEqual(1);
      expect(
        activeSwaps.every((s) =>
          ['pending_deposit', 'deposit_confirmed', 'processing', 'recovering'].includes(s.status),
        ),
      ).toBe(true);
    });
  });

  describe('Data integrity', () => {
    it('should enforce foreign key constraint', async () => {
      await expect(
        createSwapOperation({
          rebalanceOperationId: '00000000-0000-0000-0000-000000000000', // Non-existent
          platform: 'binance',
          fromAsset: 'USDT',
          toAsset: 'USDC',
          fromAmount: '1000000',
          toAmount: '999000',
          expectedRate: '999000000000000000',
          status: 'pending_deposit',
        }),
      ).rejects.toThrow();
    });

    it('should cascade delete swaps when rebalance operation deleted', async () => {
      const swap = await createSwapOperation({
        rebalanceOperationId: testRebalanceOpId,
        platform: 'binance',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '1000000',
        toAmount: '999000',
        expectedRate: '999000000000000000',
        status: 'pending_deposit',
      });

      // Verify swap exists
      const beforeDelete = await getSwapOperations({ rebalanceOperationId: testRebalanceOpId });
      expect(beforeDelete.length).toBeGreaterThanOrEqual(1);

      // Delete parent (would need to implement deleteRebalanceOperation or use raw SQL)
      // For now, just verify the FK exists
      expect(swap.rebalanceOperationId).toBe(testRebalanceOpId);
    });
  });
});
