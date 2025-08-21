// Integration tests for database adapter - tests against real PostgreSQL instance
import {
  createEarmark,
  getEarmarks,
  updateEarmarkStatus,
  getEarmarkForInvoice,
  getActiveEarmarksForChain,
  getRebalanceOperationsByEarmark,
  removeEarmark,
  createRebalanceOperation,
} from '../src/db';
import { setupTestDatabase, teardownTestDatabase, cleanupTestDatabase } from './setup';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';

describe('Database Adapter - Integration Tests', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    await teardownTestDatabase();
  });

  describe('Earmark Operations', () => {
    describe('createEarmark', () => {
      it('should create a new earmark', async () => {
        const earmarkData = {
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        };

        const earmark = await createEarmark(earmarkData);

        expect(earmark).toBeDefined();
        expect(earmark.invoiceId).toBe(earmarkData.invoiceId);
        expect(earmark.designatedPurchaseChain).toBe(earmarkData.designatedPurchaseChain);
        expect(earmark.tickerHash).toBe(earmarkData.tickerHash);
        expect(earmark.minAmount).toBe('100000000000'); // Stored as TEXT, no trailing zeros
        expect(earmark.status).toBe('pending');
        expect(earmark.createdAt).toBeDefined();
      });

      it('should prevent duplicate earmarks for the same invoice', async () => {
        const earmarkData = {
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        };

        await createEarmark(earmarkData);

        await expect(createEarmark(earmarkData)).rejects.toThrow();
      });

      it('should create earmark and then create rebalance operations separately', async () => {
        const earmarkData = {
          invoiceId: 'invoice-002',
          designatedPurchaseChain: 10,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '200000000000',
        };

        const earmark = await createEarmark(earmarkData);

        // Create rebalance operations separately
        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '100000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'test-bridge',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 137,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '100000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'test-bridge',
        });

        const operations = await getRebalanceOperationsByEarmark(earmark.id);

        expect(operations).toHaveLength(2);
        expect(operations[0].originChainId).toBe(1);
        expect(operations[0].destinationChainId).toBe(10);
        expect(operations[1].originChainId).toBe(137);
      });
    });

    describe('getEarmarks', () => {
      it('should return all earmarks', async () => {
        const earmarks = [
          {
            invoiceId: 'invoice-001',
            designatedPurchaseChain: 1,
            tickerHash: '0x1234567890123456789012345678901234567890',
            minAmount: '100000000000',
          },
          {
            invoiceId: 'invoice-002',
            designatedPurchaseChain: 10,
            tickerHash: '0x1234567890123456789012345678901234567890',
            minAmount: '200000000000',
          },
        ];

        for (const earmark of earmarks) {
          await createEarmark(earmark);
        }

        const result = await getEarmarks();

        expect(result).toHaveLength(2);
        expect(result.map((e) => e.invoiceId).sort()).toEqual(['invoice-001', 'invoice-002']);
      });

      it('should filter by status', async () => {
        await createEarmark({
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        });

        const earmark2 = await createEarmark({
          invoiceId: 'invoice-002',
          designatedPurchaseChain: 10,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '200000000000',
        });

        await updateEarmarkStatus(earmark2.id, EarmarkStatus.COMPLETED);

        const pendingEarmarks = await getEarmarks({ status: 'pending' });
        const completedEarmarks = await getEarmarks({ status: 'completed' });

        expect(pendingEarmarks).toHaveLength(1);
        expect(pendingEarmarks[0].invoiceId).toBe('invoice-001');
        expect(completedEarmarks).toHaveLength(1);
        expect(completedEarmarks[0].invoiceId).toBe('invoice-002');
      });

      it('should filter by multiple criteria', async () => {
        await createEarmark({
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0xabc',
          minAmount: '100',
        });

        await createEarmark({
          invoiceId: 'invoice-002',
          designatedPurchaseChain: 10,
          tickerHash: '0xdef',
          minAmount: '200',
        });

        await createEarmark({
          invoiceId: 'invoice-003',
          designatedPurchaseChain: 1,
          tickerHash: '0xabc',
          minAmount: '300',
        });

        const filtered = await getEarmarks({
          designatedPurchaseChain: 1,
          tickerHash: '0xabc',
        });

        expect(filtered).toHaveLength(2);
        expect(filtered.map((e) => e.invoiceId).sort()).toEqual(['invoice-001', 'invoice-003']);
      });
    });

    describe('updateEarmarkStatus', () => {
      it('should update earmark status', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        });

        expect(earmark.status).toBe('pending');

        await updateEarmarkStatus(earmark.id, EarmarkStatus.COMPLETED);
        const updated = await getEarmarkForInvoice('invoice-001');
        expect(updated?.status).toBe('completed');
        expect(updated?.updatedAt).toBeDefined();
      });

      it('should handle invalid earmark ID', async () => {
        await expect(updateEarmarkStatus('invalid-id', EarmarkStatus.COMPLETED)).rejects.toThrow();
      });
    });

    describe('getEarmarkForInvoice', () => {
      it('should return earmark for specific invoice', async () => {
        await createEarmark({
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        });

        const earmark = await getEarmarkForInvoice('invoice-001');
        expect(earmark).toBeDefined();
        expect(earmark?.invoiceId).toBe('invoice-001');
      });

      it('should return null for non-existent invoice', async () => {
        const earmark = await getEarmarkForInvoice('non-existent');
        expect(earmark).toBeNull();
      });
    });

    describe('getActiveEarmarksForChain', () => {
      it('should return only pending earmarks for specific chain', async () => {
        await createEarmark({
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        });

        await createEarmark({
          invoiceId: 'invoice-002',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '200000000000',
        });

        const earmark3 = await createEarmark({
          invoiceId: 'invoice-003',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '300000000000',
        });

        await createEarmark({
          invoiceId: 'invoice-004',
          designatedPurchaseChain: 10,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '400000000000',
        });

        // Update status of one earmark
        await updateEarmarkStatus(earmark3.id, EarmarkStatus.COMPLETED);

        const activeEarmarks = await getActiveEarmarksForChain(1);

        expect(activeEarmarks).toHaveLength(2);
        expect(activeEarmarks.map((e) => e.invoiceId).sort()).toEqual(['invoice-001', 'invoice-002']);
      });
    });

    describe('removeEarmark', () => {
      it('should remove an earmark and its operations', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        });

        // Verify earmark exists
        expect(await getEarmarkForInvoice('invoice-001')).toBeDefined();

        // Remove earmark
        await removeEarmark(earmark.id);

        // Verify earmark is gone
        expect(await getEarmarkForInvoice('invoice-001')).toBeNull();

        // Verify operations are also gone (cascade delete)
        const operations = await getRebalanceOperationsByEarmark(earmark.id);
        expect(operations).toHaveLength(0);
      });
    });
  });

  describe('Database Constraints', () => {
    it('should handle database constraints gracefully', async () => {
      // First create an earmark
      await createEarmark({
        invoiceId: 'invoice-constraint-test',
        designatedPurchaseChain: 1,
        tickerHash: '0x1234567890123456789012345678901234567890',
        minAmount: '100000000000',
      });

      // Try to create another with same invoice ID - should fail
      await expect(
        createEarmark({
          invoiceId: 'invoice-constraint-test',
          designatedPurchaseChain: 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '200000000000',
        }),
      ).rejects.toThrow();

      // Verify only one earmark exists
      const earmarks = await getEarmarks({ invoiceId: 'invoice-constraint-test' });
      expect(earmarks).toHaveLength(1);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multiple earmarks with different statuses', async () => {
      // Create multiple earmarks
      const earmarks = [];
      for (let i = 1; i <= 5; i++) {
        const earmark = await createEarmark({
          invoiceId: `invoice-${i}`,
          designatedPurchaseChain: i % 2 === 0 ? 10 : 1,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: `${i}00000000000`,
        });
        earmarks.push(earmark);
      }

      // Update some statuses
      await updateEarmarkStatus(earmarks[1].id, EarmarkStatus.READY);
      await updateEarmarkStatus(earmarks[2].id, EarmarkStatus.COMPLETED);
      await updateEarmarkStatus(earmarks[3].id, EarmarkStatus.CANCELLED);

      // Query by different filters
      const pendingEarmarks = await getEarmarks({ status: 'pending' });
      const readyEarmarks = await getEarmarks({ status: 'ready' });
      const chain1Earmarks = await getEarmarks({ designatedPurchaseChain: 1 });
      const chain10Earmarks = await getEarmarks({ designatedPurchaseChain: 10 });

      expect(pendingEarmarks).toHaveLength(2);
      expect(readyEarmarks).toHaveLength(1);
      expect(chain1Earmarks).toHaveLength(3);
      expect(chain10Earmarks).toHaveLength(2);

      // Test multiple status filter
      const activeEarmarks = await getEarmarks({ status: ['pending', 'ready'] });
      expect(activeEarmarks).toHaveLength(3);
    });

    it('should maintain data integrity across operations', async () => {
      // Create earmark
      const earmark = await createEarmark({
        invoiceId: 'integrity-test',
        designatedPurchaseChain: 10,
        tickerHash: '0xabc',
        minAmount: '1000000',
      });

      // Create rebalance operations separately
      await createRebalanceOperation({
        earmarkId: earmark.id,
        originChainId: 1,
        destinationChainId: 10,
        tickerHash: earmark.tickerHash,
        amount: '500000',
        slippage: 100,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'test-bridge',
      });

      await createRebalanceOperation({
        earmarkId: earmark.id,
        originChainId: 137,
        destinationChainId: 10,
        tickerHash: earmark.tickerHash,
        amount: '500000',
        slippage: 100,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'test-bridge',
      });

      // Update earmark status
      await updateEarmarkStatus(earmark.id, EarmarkStatus.READY);

      // Verify all data is consistent
      const updatedEarmark = await getEarmarkForInvoice('integrity-test');
      const operations = await getRebalanceOperationsByEarmark(earmark.id);

      expect(updatedEarmark?.status).toBe('ready');
      expect(operations).toHaveLength(2);
      expect(operations.every((op) => op.earmarkId === earmark.id)).toBe(true);
    });
  });
});
