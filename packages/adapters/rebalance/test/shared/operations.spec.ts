import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { Logger } from '@mark/logger';
import { RebalanceRoute, RebalanceOperationStatus } from '@mark/core';
import { TransactionReceipt } from 'viem';
import * as database from '@mark/database';
import { cancelRebalanceOperation } from '../../src/shared/operations';

// Mock the database module
jest.mock('@mark/database', () => ({
  getRebalanceOperationByTransactionHash: jest.fn(),
  updateRebalanceOperation: jest.fn(),
}));

// Mock logger
const mockLogger: Logger = {
  debug: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
} as any;

describe('cancelRebalanceOperation', () => {
  const mockDb = database as jest.Mocked<typeof database>;
  const mockRoute: RebalanceRoute = {
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    origin: 1,
    destination: 8453,
  };

  const mockTransaction: TransactionReceipt = {
    transactionHash: '0xabcdef123456789abcdef123456789abcdef123456789abcdef123456789abc',
    blockHash: '0x123456789abcdef123456789abcdef123456789abcdef123456789abcdef1234',
    blockNumber: 12345678n,
    logsBloom: '0x0000000000000000000000000000000000000000000000000000000000000000',
    contractAddress: null,
    cumulativeGasUsed: 21000n,
    effectiveGasPrice: 20000000000n,
    from: '0x0000000000000000000000000000000000000000',
    gasUsed: 21000n,
    to: '0x0000000000000000000000000000000000000000',
    status: 'success',
    type: 'legacy',
    transactionIndex: 0,
    logs: [],
  } as TransactionReceipt;

  const mockError = new Error('Insufficient balance (Kraken)');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should cancel rebalance operation successfully', async () => {
    const mockOperation = {
      id: 123,
      status: RebalanceOperationStatus.PENDING,
      isOrphaned: false,
      earmarkId: null,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);
    mockDb.updateRebalanceOperation.mockResolvedValue(undefined as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockDb.getRebalanceOperationByTransactionHash).toHaveBeenCalledWith(
      mockTransaction.transactionHash,
      1, // mockRoute.origin
    );
    expect(mockDb.updateRebalanceOperation).toHaveBeenCalledWith(mockOperation.id, {
      status: RebalanceOperationStatus.CANCELLED,
      isOrphaned: false,
    });
    expect(mockLogger.info).toHaveBeenCalledWith('Rebalance operation cancelled', {
      operationId: mockOperation.id,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      previousStatus: RebalanceOperationStatus.PENDING,
      error: mockError.message,
    });
  });

  it('should set isOrphaned to true when earmarkId is present', async () => {
    const mockOperation = {
      id: 124,
      status: RebalanceOperationStatus.AWAITING_CALLBACK,
      isOrphaned: false,
      earmarkId: 'earmark-123',
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);
    mockDb.updateRebalanceOperation.mockResolvedValue(undefined as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockDb.updateRebalanceOperation).toHaveBeenCalledWith(mockOperation.id, {
      status: RebalanceOperationStatus.CANCELLED,
      isOrphaned: true,
    });
  });

  it('should preserve existing isOrphaned value when earmarkId is null', async () => {
    const mockOperation = {
      id: 125,
      status: RebalanceOperationStatus.AWAITING_CALLBACK,
      isOrphaned: true,
      earmarkId: null,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);
    mockDb.updateRebalanceOperation.mockResolvedValue(undefined as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockDb.updateRebalanceOperation).toHaveBeenCalledWith(mockOperation.id, {
      status: RebalanceOperationStatus.CANCELLED,
      isOrphaned: true,
    });
  });

  it('should warn when operation is not found', async () => {
    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(null as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockLogger.warn).toHaveBeenCalledWith('Cannot cancel rebalance operation: operation not found', {
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      error: mockError.message,
    });
    expect(mockDb.updateRebalanceOperation).not.toHaveBeenCalled();
  });

  it('should warn when operation cannot be cancelled by status', async () => {
    const mockOperation = {
      id: 126,
      status: RebalanceOperationStatus.CANCELLED, // Already cancelled
      isOrphaned: false,
      earmarkId: null,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockLogger.warn).toHaveBeenCalledWith('Cannot cancel rebalance operation: invalid status', {
      operationId: mockOperation.id,
      currentStatus: RebalanceOperationStatus.CANCELLED,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      error: mockError.message,
    });
    expect(mockDb.updateRebalanceOperation).not.toHaveBeenCalled();
  });

  it('should warn for other invalid statuses like COMPLETE', async () => {
    const mockOperation = {
      id: 127,
      status: RebalanceOperationStatus.COMPLETED,
      isOrphaned: false,
      earmarkId: null,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockLogger.warn).toHaveBeenCalledWith('Cannot cancel rebalance operation: invalid status', {
      operationId: mockOperation.id,
      currentStatus: RebalanceOperationStatus.COMPLETED,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      error: mockError.message,
    });
    expect(mockDb.updateRebalanceOperation).not.toHaveBeenCalled();
  });

  it('should handle database errors gracefully', async () => {
    const mockOperation = {
      id: 128,
      status: RebalanceOperationStatus.PENDING,
      isOrphaned: false,
      earmarkId: null,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    const dbError = new Error('Database connection failed');
    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);
    mockDb.updateRebalanceOperation.mockRejectedValue(dbError);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockLogger.error).toHaveBeenCalledWith('Failed to cancel rebalance operation', {
      error: expect.objectContaining({
        name: 'Error',
        message: 'Database connection failed',
      }),
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      originalError: mockError.message,
    });
  });

  it('should handle getRebalanceOperationByTransactionHash errors gracefully', async () => {
    const dbError = new Error('Query failed');
    mockDb.getRebalanceOperationByTransactionHash.mockRejectedValue(dbError);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockLogger.error).toHaveBeenCalledWith('Failed to cancel rebalance operation', {
      error: expect.objectContaining({
        name: 'Error',
        message: 'Query failed',
      }),
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      originalError: mockError.message,
    });
    expect(mockDb.updateRebalanceOperation).not.toHaveBeenCalled();
  });

  it('should allow cancellation for PENDING status', async () => {
    const mockOperation = {
      id: 129,
      status: RebalanceOperationStatus.PENDING,
      isOrphaned: false,
      earmarkId: null,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);
    mockDb.updateRebalanceOperation.mockResolvedValue(undefined as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockDb.updateRebalanceOperation).toHaveBeenCalledWith(mockOperation.id, {
      status: RebalanceOperationStatus.CANCELLED,
      isOrphaned: false,
    });
    expect(mockLogger.info).toHaveBeenCalledWith('Rebalance operation cancelled', {
      operationId: mockOperation.id,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      previousStatus: RebalanceOperationStatus.PENDING,
      error: mockError.message,
    });
  });

  it('should allow cancellation for AWAITING_CALLBACK status', async () => {
    const mockOperation = {
      id: 130,
      status: RebalanceOperationStatus.AWAITING_CALLBACK,
      isOrphaned: false,
      earmarkId: null,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
    };

    mockDb.getRebalanceOperationByTransactionHash.mockResolvedValue(mockOperation as any);
    mockDb.updateRebalanceOperation.mockResolvedValue(undefined as any);

    await cancelRebalanceOperation(mockDb as any, mockLogger, mockRoute, mockTransaction, mockError);

    expect(mockDb.updateRebalanceOperation).toHaveBeenCalledWith(mockOperation.id, {
      status: RebalanceOperationStatus.CANCELLED,
      isOrphaned: false,
    });
    expect(mockLogger.info).toHaveBeenCalledWith('Rebalance operation cancelled', {
      operationId: mockOperation.id,
      transactionHash: mockTransaction.transactionHash,
      route: mockRoute,
      previousStatus: RebalanceOperationStatus.AWAITING_CALLBACK,
      error: mockError.message,
    });
  });
});
