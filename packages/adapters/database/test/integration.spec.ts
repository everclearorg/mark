import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';
import { TransactionReasons, TransactionReceipt } from '../src';
import {
  createEarmark,
  getEarmarks,
  updateEarmarkStatus,
  getEarmarkForInvoice,
  getActiveEarmarksForChain,
  getRebalanceOperationsByEarmark,
  removeEarmark,
  createRebalanceOperation,
  updateRebalanceOperation,
  getRebalanceOperations,
  getRebalanceOperationByTransactionHash,
} from '../src/db';
import { setupTestDatabase, teardownTestDatabase, cleanupTestDatabase } from './setup';

describe('Database Adapter - Integration Tests', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterAll(async () => {
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

  describe('Rebalance Operations', () => {
    describe('getRebalanceOperationByTransactionHash', () => {
      it('should return operation and all associated transactions for matching hash/chain', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-by-hash-001',
          designatedPurchaseChain: 10,
          tickerHash: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca',
          minAmount: '100000000000',
        });

        const txReceipts: Record<string, TransactionReceipt> = {
          '1': {
            from: '0xsender',
            to: '0xbridge',
            transactionHash: '0xhashlower',
            cumulativeGasUsed: '21000',
            effectiveGasPrice: '20000000000',
          } as TransactionReceipt,
          '10': {
            from: '0xsender',
            to: '0xbridge',
            transactionHash: '0xotherhash',
            cumulativeGasUsed: '31000',
            effectiveGasPrice: '22000000000',
          } as TransactionReceipt,
        };

        const op = await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'test-bridge',
          transactions: txReceipts,
        });

        // Query using uppercase hash to verify case-insensitive match
        const byHash = await getRebalanceOperationByTransactionHash('0xHASHLOWER'.toUpperCase(), 1);

        expect(byHash).toBeDefined();
        expect(byHash!.id).toBe(op.id);
        expect(byHash!.transactions).toBeDefined();
        expect(Object.keys(byHash!.transactions)).toEqual(expect.arrayContaining(['1', '10']));
        expect(byHash!.transactions['1'].transactionHash).toBe('0xhashlower');
        expect(byHash!.transactions['10'].transactionHash).toBe('0xotherhash');
      });

      it('should return undefined when chainId does not match', async () => {
        const txReceipts: Record<string, TransactionReceipt> = {
          '1': {
            from: '0xsender',
            to: '0xbridge',
            transactionHash: '0xnomatch',
            cumulativeGasUsed: '21000',
            effectiveGasPrice: '20000000000',
            blockNumber: 100,
            status: 1,
            confirmations: 1,
          } as TransactionReceipt,
        };

        const op = await createRebalanceOperation({
          earmarkId: null,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: '0x123',
          amount: '1',
          slippage: 1,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'bridge',
          transactions: txReceipts,
        });

        const notFound = await getRebalanceOperationByTransactionHash('0xnomatch', 10);
        expect(notFound).toBeUndefined();
        expect(op).toBeDefined();
      });

      it('should return undefined when no associated rebalance operation', async () => {
        // Insert a standalone transaction not tied to an operation
        // Use direct SQL insert via pool
        const { getPool } = await import('../src/db');
        const db = getPool();
        const txHash = '0xstandalone';
        await db.query(
          `INSERT INTO transactions (rebalance_operation_id, transaction_hash, chain_id, "from", "to", cumulative_gas_used, effective_gas_price, reason, metadata)
           VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8)`,
          [txHash, '1', '0xfrom', '0xto', '1', '1', 'Rebalance', JSON.stringify({})],
        );

        const result = await getRebalanceOperationByTransactionHash(txHash, 1);
        expect(result).toBeUndefined();
      });
    });
    describe('createRebalanceOperation', () => {
      it('should create a new rebalance operation with earmark', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-rebalance-001',
          designatedPurchaseChain: 10,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '100000000000',
        });

        const operationData = {
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'test-bridge',
        };

        const operation = await createRebalanceOperation(operationData);

        expect(operation).toBeDefined();
        expect(operation.earmarkId).toBe(earmark.id);
        expect(operation.originChainId).toBe(1);
        expect(operation.destinationChainId).toBe(10);
        expect(operation.tickerHash).toBe(earmark.tickerHash);
        expect(operation.amount).toBe('50000000000');
        expect(operation.slippage).toBe(100);
        expect(operation.status).toBe(RebalanceOperationStatus.PENDING);
        expect(operation.bridge).toBe('test-bridge');
        expect(operation.createdAt).toBeDefined();
        expect(operation.updatedAt).toBeDefined();
      });

      it('should create a rebalance operation without earmark (null earmarkId)', async () => {
        const operationData = {
          earmarkId: null,
          originChainId: 137,
          destinationChainId: 1,
          tickerHash: '0xabcdef1234567890abcdef1234567890abcdef12',
          amount: '75000000000',
          slippage: 200,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'polygon-bridge',
        };

        const operation = await createRebalanceOperation(operationData);

        expect(operation).toBeDefined();
        expect(operation.earmarkId).toBeNull();
        expect(operation.originChainId).toBe(137);
        expect(operation.destinationChainId).toBe(1);
        expect(operation.tickerHash).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
        expect(operation.amount).toBe('75000000000');
        expect(operation.slippage).toBe(200);
        expect(operation.status).toBe(RebalanceOperationStatus.PENDING);
        expect(operation.bridge).toBe('polygon-bridge');
      });

      it('should create rebalance operation with transaction receipts', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-rebalance-002',
          designatedPurchaseChain: 10,
          tickerHash: '0x1234567890123456789012345678901234567890',
          minAmount: '200000000000',
        });

        const transactionReceipts: Record<string, TransactionReceipt> = {
          '1': {
            from: '0xsender',
            to: '0xbridge',
            transactionHash: '0xtx1234567890abcdef',
            cumulativeGasUsed: '21000',
            effectiveGasPrice: '20000000000',
            blockNumber: 12345678,
            status: 1,
            confirmations: 12,
          } as TransactionReceipt,
          '10': {
            from: '0xsender',
            to: '0xbridge',
            transactionHash: '0xtx0987654321fedcba',
            cumulativeGasUsed: '45000',
            effectiveGasPrice: '15000000000',
            blockNumber: 87654321,
            status: 1,
            confirmations: 8,
          } as TransactionReceipt,
        };

        const operationData = {
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '100000000000',
          slippage: 150,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
          bridge: 'cross-chain-bridge',
          transactions: transactionReceipts,
        };

        const operation = await createRebalanceOperation(operationData);

        expect(operation).toBeDefined();
        expect(operation.earmarkId).toBe(earmark.id);
        expect(operation.status).toBe(RebalanceOperationStatus.AWAITING_CALLBACK);
        expect(operation.bridge).toBe('cross-chain-bridge');
        const expected = Object.fromEntries(
          Object.entries(transactionReceipts).map(([chain, receipt]) => {
            const { confirmations, blockNumber, status, ...ret } = receipt;
            return [
              chain,
              {
                ...ret,
                rebalanceOperationId: operation.id,
                reason: TransactionReasons.Rebalance,
                metadata: { receipt },
              },
            ];
          }),
        );
        expect(operation.transactions).toMatchObject(expected);
      });

      it('should handle different rebalance operation statuses', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-rebalance-003',
          designatedPurchaseChain: 1,
          tickerHash: '0x9999999999999999999999999999999999999999',
          minAmount: '300000000000',
        });

        const statuses = [
          RebalanceOperationStatus.PENDING,
          RebalanceOperationStatus.AWAITING_CALLBACK,
          RebalanceOperationStatus.COMPLETED,
          RebalanceOperationStatus.EXPIRED,
        ];

        const operations = [];
        for (let i = 0; i < statuses.length; i++) {
          const operation = await createRebalanceOperation({
            earmarkId: earmark.id,
            originChainId: 1,
            destinationChainId: 10,
            tickerHash: earmark.tickerHash,
            amount: `${(i + 1) * 10000000000}`,
            slippage: 100 + i * 50,
            status: statuses[i],
            bridge: `bridge-${i + 1}`,
          });
          operations.push(operation);
        }

        expect(operations).toHaveLength(4);
        operations.forEach((op, index) => {
          expect(op.status).toBe(statuses[index]);
          expect(op.bridge).toBe(`bridge-${index + 1}`);
        });
      });
    });

    describe('updateRebalanceOperation', () => {
      it('should update rebalance operation status only', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-update-001',
          designatedPurchaseChain: 10,
          tickerHash: '0x1111111111111111111111111111111111111111',
          minAmount: '100000000000',
        });

        const operation = await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'test-bridge',
        });

        expect(operation.status).toBe(RebalanceOperationStatus.PENDING);
        const originalUpdatedAt = operation.updatedAt;

        // Wait a small amount to ensure timestamp difference
        await new Promise((resolve) => setTimeout(resolve, 10));

        const updated = await updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
        });

        expect(updated.status).toBe(RebalanceOperationStatus.COMPLETED);
        expect(updated.id).toBe(operation.id);
        expect(updated.earmarkId).toBe(operation.earmarkId);
        expect(new Date(updated.updatedAt!).getTime()).toBeGreaterThan(new Date(originalUpdatedAt!).getTime());
      });

      it('should update txHashes only', async () => {
        const operation = await createRebalanceOperation({
          earmarkId: null,
          originChainId: 137,
          destinationChainId: 1,
          tickerHash: '0x2222222222222222222222222222222222222222',
          amount: '75000000000',
          slippage: 200,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
          bridge: 'polygon-bridge',
        });

        const txHashes: Record<string, TransactionReceipt> = {
          '137': {
            from: '0xsender',
            to: '0xreceiver',
            transactionHash: '0xtx123',
            cumulativeGasUsed: '21000',
            effectiveGasPrice: '20000000000',
            blockNumber: 12345,
            status: 1,
            confirmations: 5,
          } as TransactionReceipt,
          '1': {
            from: '0xsender2',
            to: '0xreceiver2',
            transactionHash: '0xtx456',
            cumulativeGasUsed: '25000',
            effectiveGasPrice: '18000000000',
            blockNumber: 12350,
            status: 1,
            confirmations: 3,
          } as TransactionReceipt,
        };

        const originalStatus = operation.status;
        const updated = await updateRebalanceOperation(operation.id, {
          txHashes,
        });

        expect(updated.status).toBe(originalStatus); // Status should remain unchanged
        expect(updated.id).toBe(operation.id);

        // Verify transactions are returned
        expect(updated.transactions).toBeDefined();
        expect(Object.keys(updated.transactions!)).toHaveLength(2);
        expect(updated.transactions!['137']).toBeDefined();
        expect(updated.transactions!['1']).toBeDefined();
        expect(updated.transactions!['137'].transactionHash).toBe('0xtx123');
        expect(updated.transactions!['1'].transactionHash).toBe('0xtx456');
      });

      it('should update both status and txHashes', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-update-002',
          designatedPurchaseChain: 1,
          tickerHash: '0x3333333333333333333333333333333333333333',
          minAmount: '200000000000',
        });

        const operation = await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 10,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '100000000000',
          slippage: 150,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'cross-chain-bridge',
        });

        const txHashes = {
          '10': {
            from: '0xbridge',
            to: '0xdestination',
            transactionHash: '0xbridge789',
            cumulativeGasUsed: '35000',
            effectiveGasPrice: '25000000000',
            blockNumber: 15000,
            status: 1,
            confirmations: 10,
          } as TransactionReceipt,
          '1': {
            from: '0xfinalize',
            to: '0xfinal',
            transactionHash: '0xfinalize101',
            cumulativeGasUsed: '40000',
            effectiveGasPrice: '30000000000',
            blockNumber: 15005,
            status: 1,
            confirmations: 8,
          } as TransactionReceipt,
        };

        const updated = await updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
          txHashes,
        });

        expect(updated.status).toBe(RebalanceOperationStatus.COMPLETED);
        expect(updated.id).toBe(operation.id);

        // Verify transactions are returned
        expect(updated.transactions).toBeDefined();
        expect(Object.keys(updated.transactions!)).toHaveLength(2);
        expect(updated.transactions!['10']).toBeDefined();
        expect(updated.transactions!['1']).toBeDefined();
        expect(updated.transactions!['10'].transactionHash).toBe('0xbridge789');
        expect(updated.transactions!['1'].transactionHash).toBe('0xfinalize101');
      });

      it('should handle non-existent operation ID', async () => {
        const nonExistentId = '12345678-1234-1234-1234-123456789012';

        await expect(
          updateRebalanceOperation(nonExistentId, {
            status: RebalanceOperationStatus.COMPLETED,
          }),
        ).rejects.toThrow(`Rebalance operation with id ${nonExistentId} not found`);
      });

      it('should update updatedAt timestamp on any update', async () => {
        const operation = await createRebalanceOperation({
          earmarkId: null,
          originChainId: 1,
          destinationChainId: 137,
          tickerHash: '0x4444444444444444444444444444444444444444',
          amount: '125000000000',
          slippage: 300,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'ethereum-bridge',
        });

        const originalUpdatedAt = operation.updatedAt;

        // Wait to ensure timestamp difference
        await new Promise((resolve) => setTimeout(resolve, 10));

        const updated = await updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
        });

        expect(new Date(updated.updatedAt!).getTime()).toBeGreaterThan(new Date(originalUpdatedAt!).getTime());
      });
    });

    describe('getRebalanceOperationsByEarmark', () => {
      it('should return all operations for an earmark in created_at order', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-get-ops-001',
          designatedPurchaseChain: 10,
          tickerHash: '0x5555555555555555555555555555555555555555',
          minAmount: '100000000000',
        });

        // Create multiple operations with slight delays to ensure ordering
        const operation1 = await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '25000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'bridge-1',
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        const operation2 = await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 137,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '35000000000',
          slippage: 150,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
          bridge: 'bridge-2',
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        const operation3 = await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 42161,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '40000000000',
          slippage: 200,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'bridge-3',
        });

        const operations = await getRebalanceOperationsByEarmark(earmark.id);

        expect(operations).toHaveLength(3);
        expect(operations[0].id).toBe(operation1.id);
        expect(operations[1].id).toBe(operation2.id);
        expect(operations[2].id).toBe(operation3.id);

        // Verify ordering by created_at ASC
        expect(new Date(operations[0].createdAt!).getTime()).toBeLessThanOrEqual(
          new Date(operations[1].createdAt!).getTime(),
        );
        expect(new Date(operations[1].createdAt!).getTime()).toBeLessThanOrEqual(
          new Date(operations[2].createdAt!).getTime(),
        );

        // Verify all operations belong to the same earmark
        operations.forEach((op) => {
          expect(op.earmarkId).toBe(earmark.id);
        });

        // Verify that operations without transactions have undefined transactions
        operations.forEach((op) => {
          expect(op.transactions).toBeUndefined();
        });
      });

      it('should return empty array for earmark with no operations', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-get-ops-002',
          designatedPurchaseChain: 1,
          tickerHash: '0x6666666666666666666666666666666666666666',
          minAmount: '200000000000',
        });

        const operations = await getRebalanceOperationsByEarmark(earmark.id);

        expect(operations).toHaveLength(0);
        expect(Array.isArray(operations)).toBe(true);
      });

      it('should return empty array for non-existent earmark', async () => {
        const nonExistentEarmarkId = '12345678-1234-1234-1234-123456789012';
        const operations = await getRebalanceOperationsByEarmark(nonExistentEarmarkId);

        expect(operations).toHaveLength(0);
        expect(Array.isArray(operations)).toBe(true);
      });

      it('should return operations with correct camelCase properties', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-get-ops-003',
          designatedPurchaseChain: 137,
          tickerHash: '0x7777777777777777777777777777777777777777',
          minAmount: '150000000000',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 137,
          tickerHash: earmark.tickerHash,
          amount: '75000000000',
          slippage: 250,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'test-bridge',
        });

        const operations = await getRebalanceOperationsByEarmark(earmark.id);

        expect(operations).toHaveLength(1);
        const op = operations[0];

        // Check all expected camelCase properties are present
        expect(op.id).toBeDefined();
        expect(op.earmarkId).toBe(earmark.id);
        expect(op.originChainId).toBe(1);
        expect(op.destinationChainId).toBe(137);
        expect(op.tickerHash).toBe(earmark.tickerHash);
        expect(op.amount).toBe('75000000000');
        expect(op.slippage).toBe(250);
        expect(op.status).toBe(RebalanceOperationStatus.PENDING);
        expect(op.bridge).toBe('test-bridge');
        expect(op.createdAt).toBeDefined();
        expect(op.updatedAt).toBeDefined();
      });

      it('should not return operations from other earmarks', async () => {
        const earmark1 = await createEarmark({
          invoiceId: 'invoice-isolation-001',
          designatedPurchaseChain: 10,
          tickerHash: '0x8888888888888888888888888888888888888888',
          minAmount: '100000000000',
        });

        const earmark2 = await createEarmark({
          invoiceId: 'invoice-isolation-002',
          designatedPurchaseChain: 1,
          tickerHash: '0x9999999999999999999999999999999999999999',
          minAmount: '200000000000',
        });

        // Create operations for both earmarks
        await createRebalanceOperation({
          earmarkId: earmark1.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark1.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'bridge-1',
        });

        await createRebalanceOperation({
          earmarkId: earmark2.id,
          originChainId: 137,
          destinationChainId: 1,
          tickerHash: earmark2.tickerHash,
          amount: '100000000000',
          slippage: 200,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'bridge-2',
        });

        // Get operations for earmark1 should only return operations for earmark1
        const operations1 = await getRebalanceOperationsByEarmark(earmark1.id);
        const operations2 = await getRebalanceOperationsByEarmark(earmark2.id);

        expect(operations1).toHaveLength(1);
        expect(operations1[0].earmarkId).toBe(earmark1.id);
        expect(operations1[0].destinationChainId).toBe(10);

        expect(operations2).toHaveLength(1);
        expect(operations2[0].earmarkId).toBe(earmark2.id);
        expect(operations2[0].destinationChainId).toBe(1);
      });

      it('should return operations with transactions when they exist', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-with-transactions',
          designatedPurchaseChain: 10,
          tickerHash: '0xdddddddddddddddddddddddddddddddddddddddd',
          minAmount: '100000000000',
        });

        // Create operation with transactions
        const transactionReceipts = {
          '1': {
            from: '0xsender',
            to: '0xbridge',
            transactionHash: '0xtx1111',
            cumulativeGasUsed: '21000',
            effectiveGasPrice: '20000000000',
            blockNumber: 12345678,
            status: 1,
            confirmations: 12,
          } as TransactionReceipt,
          '10': {
            from: '0xsender',
            to: '0xbridge',
            transactionHash: '0xtx2222',
            cumulativeGasUsed: '45000',
            effectiveGasPrice: '15000000000',
            blockNumber: 87654321,
            status: 1,
            confirmations: 8,
          } as TransactionReceipt,
        };

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'test-bridge',
          transactions: transactionReceipts,
        });

        const operations = await getRebalanceOperationsByEarmark(earmark.id);

        expect(operations).toHaveLength(1);
        expect(operations[0].transactions).toBeDefined();
        expect(Object.keys(operations[0].transactions!)).toHaveLength(2);
        expect(operations[0].transactions!['1']).toBeDefined();
        expect(operations[0].transactions!['10']).toBeDefined();
        expect(operations[0].transactions!['1'].transactionHash).toBe('0xtx1111');
        expect(operations[0].transactions!['10'].transactionHash).toBe('0xtx2222');
      });
    });

    describe('getRebalanceOperations', () => {
      it('should return all operations when no filter is provided', async () => {
        const earmark1 = await createEarmark({
          invoiceId: 'invoice-all-ops-001',
          designatedPurchaseChain: 10,
          tickerHash: '0xaaaa111111111111111111111111111111111111',
          minAmount: '100000000000',
        });

        const earmark2 = await createEarmark({
          invoiceId: 'invoice-all-ops-002',
          designatedPurchaseChain: 1,
          tickerHash: '0xbbbb222222222222222222222222222222222222',
          minAmount: '200000000000',
        });

        // Create operations for both earmarks and standalone operations
        await createRebalanceOperation({
          earmarkId: earmark1.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark1.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'bridge-1',
        });

        await createRebalanceOperation({
          earmarkId: earmark2.id,
          originChainId: 137,
          destinationChainId: 1,
          tickerHash: earmark2.tickerHash,
          amount: '75000000000',
          slippage: 150,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'bridge-2',
        });

        await createRebalanceOperation({
          earmarkId: null,
          originChainId: 42161,
          destinationChainId: 10,
          tickerHash: '0xcccc333333333333333333333333333333333333',
          amount: '100000000000',
          slippage: 200,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
          bridge: 'bridge-3',
        });

        const allOperations = await getRebalanceOperations();

        expect(allOperations.length).toBeGreaterThanOrEqual(3);

        // Check that operations are ordered by created_at ASC
        for (let i = 1; i < allOperations.length; i++) {
          expect(new Date(allOperations[i - 1].createdAt!).getTime()).toBeLessThanOrEqual(
            new Date(allOperations[i].createdAt!).getTime(),
          );
        }
      });

      it('should filter by single status', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-status-filter-001',
          designatedPurchaseChain: 10,
          tickerHash: '0xdddd444444444444444444444444444444444444',
          minAmount: '100000000000',
        });

        // Create operations with different statuses
        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '25000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'bridge-pending',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 137,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '35000000000',
          slippage: 150,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'bridge-completed',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 42161,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '40000000000',
          slippage: 200,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
          bridge: 'bridge-awaiting',
        });

        const pendingOperations = await getRebalanceOperations({
          status: RebalanceOperationStatus.PENDING,
        });

        const completedOperations = await getRebalanceOperations({
          status: RebalanceOperationStatus.COMPLETED,
        });

        // Check that filtering works
        const pendingFromEarmark = pendingOperations.filter((op) => op.earmarkId === earmark.id);
        const completedFromEarmark = completedOperations.filter((op) => op.earmarkId === earmark.id);

        expect(pendingFromEarmark.length).toBeGreaterThanOrEqual(1);
        expect(completedFromEarmark.length).toBeGreaterThanOrEqual(1);

        // Verify all returned operations have the correct status
        pendingFromEarmark.forEach((op) => {
          expect(op.status).toBe(RebalanceOperationStatus.PENDING);
        });

        completedFromEarmark.forEach((op) => {
          expect(op.status).toBe(RebalanceOperationStatus.COMPLETED);
        });
      });

      it('should filter by array of statuses', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-multi-status-001',
          designatedPurchaseChain: 1,
          tickerHash: '0xeeee555555555555555555555555555555555555',
          minAmount: '150000000000',
        });

        // Create operations with all statuses
        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 10,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '30000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'bridge-1',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 137,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '40000000000',
          slippage: 150,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
          bridge: 'bridge-2',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 42161,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 200,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'bridge-3',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 8453,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '20000000000',
          slippage: 250,
          status: RebalanceOperationStatus.EXPIRED,
          bridge: 'bridge-4',
        });

        const activeOperations = await getRebalanceOperations({
          status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
        });

        const finalOperations = await getRebalanceOperations({
          status: [RebalanceOperationStatus.COMPLETED, RebalanceOperationStatus.EXPIRED],
        });

        // Filter by earmark to check our specific operations
        const activeFromEarmark = activeOperations.filter((op) => op.earmarkId === earmark.id);
        const finalFromEarmark = finalOperations.filter((op) => op.earmarkId === earmark.id);

        expect(activeFromEarmark.length).toBe(2);
        expect(finalFromEarmark.length).toBe(2);

        // Verify statuses
        activeFromEarmark.forEach((op) => {
          expect([RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK]).toContain(op.status);
        });

        finalFromEarmark.forEach((op) => {
          expect([RebalanceOperationStatus.COMPLETED, RebalanceOperationStatus.EXPIRED]).toContain(op.status);
        });
      });

      it('should filter by chainId (origin_chain_id)', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-chain-filter-001',
          designatedPurchaseChain: 10,
          tickerHash: '0xffff666666666666666666666666666666666666',
          minAmount: '200000000000',
        });

        // Create operations with different origin chain IDs
        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1, // Ethereum
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'eth-bridge',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 137, // Polygon
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '75000000000',
          slippage: 150,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'polygon-bridge',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1, // Another Ethereum operation
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '60000000000',
          slippage: 120,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'eth-bridge-2',
        });

        const ethereumOperations = await getRebalanceOperations({
          chainId: 1,
        });

        const polygonOperations = await getRebalanceOperations({
          chainId: 137,
        });

        // Filter by earmark to check our specific operations
        const ethFromEarmark = ethereumOperations.filter((op) => op.earmarkId === earmark.id);
        const polygonFromEarmark = polygonOperations.filter((op) => op.earmarkId === earmark.id);

        expect(ethFromEarmark.length).toBe(2);
        expect(polygonFromEarmark.length).toBe(1);

        // Verify origin chain IDs
        ethFromEarmark.forEach((op) => {
          expect(op.originChainId).toBe(1);
        });

        polygonFromEarmark.forEach((op) => {
          expect(op.originChainId).toBe(137);
        });
      });

      it('should filter by earmarkId', async () => {
        const earmark1 = await createEarmark({
          invoiceId: 'invoice-earmark-filter-001',
          designatedPurchaseChain: 10,
          tickerHash: '0x1111777777777777777777777777777777777777',
          minAmount: '100000000000',
        });

        const earmark2 = await createEarmark({
          invoiceId: 'invoice-earmark-filter-002',
          designatedPurchaseChain: 1,
          tickerHash: '0x2222888888888888888888888888888888888888',
          minAmount: '200000000000',
        });

        // Create operations for both earmarks
        await createRebalanceOperation({
          earmarkId: earmark1.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark1.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'bridge-1',
        });

        await createRebalanceOperation({
          earmarkId: earmark2.id,
          originChainId: 137,
          destinationChainId: 1,
          tickerHash: earmark2.tickerHash,
          amount: '100000000000',
          slippage: 200,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'bridge-2',
        });

        // Create standalone operation (null earmarkId)
        await createRebalanceOperation({
          earmarkId: null,
          originChainId: 42161,
          destinationChainId: 10,
          tickerHash: '0x3333999999999999999999999999999999999999',
          amount: '75000000000',
          slippage: 150,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
          bridge: 'standalone-bridge',
        });

        const earmark1Operations = await getRebalanceOperations({
          earmarkId: earmark1.id,
        });

        const earmark2Operations = await getRebalanceOperations({
          earmarkId: earmark2.id,
        });

        const standaloneOperations = await getRebalanceOperations({
          earmarkId: null,
        });

        expect(earmark1Operations.length).toBe(1);
        expect(earmark2Operations.length).toBe(1);
        expect(standaloneOperations.length).toBeGreaterThanOrEqual(1);

        expect(earmark1Operations[0].earmarkId).toBe(earmark1.id);
        expect(earmark2Operations[0].earmarkId).toBe(earmark2.id);

        // Check that at least one standalone operation exists
        const hasNullEarmark = standaloneOperations.some((op) => op.earmarkId === null);
        expect(hasNullEarmark).toBe(true);
      });

      it('should handle combined filters', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-combined-filter-001',
          designatedPurchaseChain: 10,
          tickerHash: '0x4444aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          minAmount: '300000000000',
        });

        // Create operations to test combined filtering
        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'target-bridge',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 1,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '60000000000',
          slippage: 120,
          status: RebalanceOperationStatus.COMPLETED,
          bridge: 'different-bridge',
        });

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 137,
          destinationChainId: 10,
          tickerHash: earmark.tickerHash,
          amount: '70000000000',
          slippage: 150,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'polygon-bridge',
        });

        // Filter by earmark, status, and chainId
        const filteredOperations = await getRebalanceOperations({
          earmarkId: earmark.id,
          status: RebalanceOperationStatus.PENDING,
          chainId: 1,
        });

        expect(filteredOperations.length).toBe(1);
        expect(filteredOperations[0].earmarkId).toBe(earmark.id);
        expect(filteredOperations[0].status).toBe(RebalanceOperationStatus.PENDING);
        expect(filteredOperations[0].originChainId).toBe(1);
        expect(filteredOperations[0].bridge).toBe('target-bridge');
      });

      it('should return empty array when no operations match filter', async () => {
        const operations = await getRebalanceOperations({
          status: RebalanceOperationStatus.EXPIRED,
          chainId: 999999, // Non-existent chain
          earmarkId: '12345678-1234-1234-1234-123456789012',
        });

        expect(operations).toHaveLength(0);
        expect(Array.isArray(operations)).toBe(true);
      });

      it('should return operations with correct ordering (created_at ASC)', async () => {
        const earmark = await createEarmark({
          invoiceId: 'invoice-ordering-001',
          designatedPurchaseChain: 1,
          tickerHash: '0x5555bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          minAmount: '100000000000',
        });

        // Create operations with delays to ensure different timestamps
        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 10,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '30000000000',
          slippage: 100,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'first-bridge',
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 137,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '40000000000',
          slippage: 150,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'second-bridge',
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: 42161,
          destinationChainId: 1,
          tickerHash: earmark.tickerHash,
          amount: '50000000000',
          slippage: 200,
          status: RebalanceOperationStatus.PENDING,
          bridge: 'third-bridge',
        });

        const operations = await getRebalanceOperations({
          earmarkId: earmark.id,
          status: RebalanceOperationStatus.PENDING,
        });

        expect(operations.length).toBeGreaterThanOrEqual(3);

        // Find our specific operations in the results
        const op1 = operations.find((op) => op.bridge === 'first-bridge');
        const op2 = operations.find((op) => op.bridge === 'second-bridge');
        const op3 = operations.find((op) => op.bridge === 'third-bridge');

        expect(op1).toBeDefined();
        expect(op2).toBeDefined();
        expect(op3).toBeDefined();

        // Verify ordering
        const op1Index = operations.indexOf(op1!);
        const op2Index = operations.indexOf(op2!);
        const op3Index = operations.indexOf(op3!);

        expect(op1Index).toBeLessThan(op2Index);
        expect(op2Index).toBeLessThan(op3Index);
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
