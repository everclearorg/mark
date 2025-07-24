import { DatabaseError, ConnectionError, type RebalanceOperationRecord, type BasicTransactionOptions } from '../src';

describe('Simplified Transaction Types and Interfaces', () => {
  describe('DatabaseError', () => {
    it('should create DatabaseError with retryable flag', () => {
      const error = new DatabaseError('Test error', 'TEST_CODE', true);
      expect(error.name).toBe('DatabaseError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.retryable).toBe(true);
    });

    it('should create DatabaseError with default non-retryable flag', () => {
      const error = new DatabaseError('Test error', 'TEST_CODE');
      expect(error.name).toBe('DatabaseError');
      expect(error.retryable).toBe(false);
    });
  });

  describe('ConnectionError', () => {
    it('should create ConnectionError as retryable', () => {
      const error = new ConnectionError('Connection failed');
      expect(error.name).toBe('ConnectionError');
      expect(error.retryable).toBe(true);
      expect(error.code).toBe('CONNECTION_FAILED');
    });

    it('should inherit from DatabaseError', () => {
      const error = new ConnectionError('Connection failed');
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('RebalanceOperationRecord Interface', () => {
    it('should validate RebalanceOperationRecord structure', () => {
      const operation: RebalanceOperationRecord = {
        invoiceId: 'invoice-123',
        originChainId: 137,
        destinationChainId: 1,
        tickerHash: '0xusdcticker',
        amount: '1000.00',
        txHash: '0xabc123',
        status: 'SUBMITTED',
        submittedAt: new Date('2023-01-01T00:00:00Z'),
        metadata: { source: 'test' },
      };

      expect(operation.invoiceId).toBe('invoice-123');
      expect(operation.originChainId).toBe(137);
      expect(operation.status).toBe('SUBMITTED');
      expect(operation.metadata).toEqual({ source: 'test' });
    });

    it('should allow optional fields', () => {
      const operation: RebalanceOperationRecord = {
        invoiceId: 'invoice-123',
        originChainId: 137,
        destinationChainId: 1,
        tickerHash: '0xusdcticker',
        amount: '1000.00',
        txHash: '0xabc123',
        status: 'COMPLETED',
        submittedAt: new Date('2023-01-01T00:00:00Z'),
        completedAt: new Date('2023-01-01T01:00:00Z'),
        blockNumber: 12345,
      };

      expect(operation.completedAt).toBeInstanceOf(Date);
      expect(operation.blockNumber).toBe(12345);
      expect(operation.metadata).toBeUndefined();
    });
  });

  describe('BasicTransactionOptions Interface', () => {
    it('should validate BasicTransactionOptions structure', () => {
      const options: BasicTransactionOptions = {
        retryAttempts: 5,
        retryDelayMs: 200,
        timeoutMs: 45000,
      };

      expect(options.retryAttempts).toBe(5);
      expect(options.retryDelayMs).toBe(200);
      expect(options.timeoutMs).toBe(45000);
    });

    it('should allow all optional fields', () => {
      const options: BasicTransactionOptions = {};

      expect(options.retryAttempts).toBeUndefined();
      expect(options.retryDelayMs).toBeUndefined();
      expect(options.timeoutMs).toBeUndefined();
    });
  });

  describe('Status Types', () => {
    it('should validate operation status types', () => {
      const validStatuses: Array<RebalanceOperationRecord['status']> = ['SUBMITTED', 'COMPLETED', 'FAILED'];

      expect(validStatuses).toHaveLength(3);
      expect(validStatuses).toContain('SUBMITTED');
      expect(validStatuses).toContain('COMPLETED');
      expect(validStatuses).toContain('FAILED');
    });
  });
});
