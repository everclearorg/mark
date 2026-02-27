// Unit tests for database adapter - all tests use mocked dependencies
import { Pool } from 'pg';
import {
  initializeDatabase,
  closeDatabase,
  checkDatabaseHealth,
  connectWithRetry,
  gracefulShutdown,
  DatabaseConfig,
  HealthCheckResult,
} from '../src';
import { getRebalanceOperationByTransactionHash, getPool } from '../src/db';
import { RebalanceOperationStatus } from '@mark/core';
import { createMockPool, MOCK_DATABASE_CONFIG } from './setup';

// Mock pg module
jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

describe('Database Adapter - Unit Tests', () => {
  let mockPoolInstance: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolInstance = createMockPool();
    (Pool as jest.MockedClass<typeof Pool>).mockImplementation(() => mockPoolInstance as unknown as Pool);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  describe('Connection Management', () => {
    it('should initialize database with correct configuration', () => {
      const pool = initializeDatabase(MOCK_DATABASE_CONFIG);

      expect(Pool).toHaveBeenCalledWith({
        connectionString: MOCK_DATABASE_CONFIG.connectionString,
        max: MOCK_DATABASE_CONFIG.maxConnections,
        idleTimeoutMillis: MOCK_DATABASE_CONFIG.idleTimeoutMillis,
        connectionTimeoutMillis: MOCK_DATABASE_CONFIG.connectionTimeoutMillis,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });

      expect(pool).toBe(mockPoolInstance);
    });

    it('should use default values when optional config is not provided', () => {
      const minimalConfig: DatabaseConfig = {
        connectionString: 'postgresql://localhost:5432/test',
      };

      initializeDatabase(minimalConfig);

      expect(Pool).toHaveBeenCalledWith({
        connectionString: minimalConfig.connectionString,
        max: 40,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });
    });

    it('should configure SSL when connection string contains sslmode=require', () => {
      const sslConfig: DatabaseConfig = {
        connectionString: 'postgresql://localhost:5432/test_db?sslmode=require',
      };

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      initializeDatabase(sslConfig);

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: 'postgresql://localhost:5432/test_db',
          ssl: { rejectUnauthorized: false },
        }),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        'Database SSL: Configured for AWS RDS (accepting self-signed certificates)',
      );
      consoleSpy.mockRestore();
    });

    it('should throw when getPool() is called before initialization', async () => {
      // closeDatabase is called in afterEach, so pool is null here
      expect(() => getPool()).toThrow('Database not initialized. Call initializeDatabase() first.');
    });

    it('should close database connection', async () => {
      initializeDatabase(MOCK_DATABASE_CONFIG);
      mockPoolInstance.end.mockResolvedValue(undefined);

      await closeDatabase();

      expect(mockPoolInstance.end).toHaveBeenCalled();
    });
  });

  describe('Health Checks', () => {
    beforeEach(() => {
      initializeDatabase(MOCK_DATABASE_CONFIG);
    });

    it('should return healthy status when database responds correctly', async () => {
      mockPoolInstance.query.mockResolvedValue({
        rows: [{ health_check: 1 }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result: HealthCheckResult = await checkDatabaseHealth();

      expect(result.healthy).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.error).toBeUndefined();
    });

    it('should return unhealthy status when database query fails', async () => {
      const errorMessage = 'Connection failed';
      mockPoolInstance.query.mockRejectedValue(new Error(errorMessage));

      const result: HealthCheckResult = await checkDatabaseHealth();

      expect(result.healthy).toBe(false);
      expect(result.error).toBe(errorMessage);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should return unhealthy status for unexpected query result', async () => {
      mockPoolInstance.query.mockResolvedValue({
        rows: [{ health_check: 2 }], // Unexpected value
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result: HealthCheckResult = await checkDatabaseHealth();

      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Unexpected health check result');
    });
  });

  describe('Retry Logic', () => {
    it('should connect on first attempt', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [] });

      const pool = await connectWithRetry(MOCK_DATABASE_CONFIG, 3, 100);

      expect(pool).toBe(mockPoolInstance);
      expect(mockPoolInstance.query).toHaveBeenCalledTimes(1);
    });

    it('should retry on connection failure', async () => {
      mockPoolInstance.query.mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValueOnce({ rows: [] });

      const pool = await connectWithRetry(MOCK_DATABASE_CONFIG, 3, 100);

      expect(pool).toBe(mockPoolInstance);
      expect(mockPoolInstance.query).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      mockPoolInstance.query.mockRejectedValue(new Error('Connection failed'));

      await expect(connectWithRetry(MOCK_DATABASE_CONFIG, 2, 100)).rejects.toThrow(
        'Failed to connect to database after 2 attempts',
      );

      expect(mockPoolInstance.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('Graceful Shutdown', () => {
    beforeEach(() => {
      initializeDatabase(MOCK_DATABASE_CONFIG);
    });

    it('should shutdown gracefully within timeout', async () => {
      mockPoolInstance.end.mockResolvedValue(undefined);

      await expect(gracefulShutdown(1000)).resolves.not.toThrow();
      expect(mockPoolInstance.end).toHaveBeenCalled();
    });

    it('should handle shutdown timeout', async () => {
      // Simulate a hanging shutdown
      mockPoolInstance.end.mockImplementation(() => new Promise(() => {}));

      // Mock console.warn to prevent output during test
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await expect(gracefulShutdown(100)).rejects.toThrow('Database shutdown timeout');

      expect(consoleWarnSpy).toHaveBeenCalledWith('Database shutdown timed out, forcing close');
      expect(processExitSpy).toHaveBeenCalledWith(1);

      // Restore mocks AND fix the pool.end mock for cleanup
      consoleWarnSpy.mockRestore();
      processExitSpy.mockRestore();
      mockPoolInstance.end.mockResolvedValue(undefined); // Reset to working implementation
    }, 10000); // Increase timeout for this test
  });

  describe('Type Definitions', () => {
    it('should validate operation status types from @mark/core', () => {
      const validStatuses = [
        RebalanceOperationStatus.PENDING,
        RebalanceOperationStatus.AWAITING_CALLBACK,
        RebalanceOperationStatus.COMPLETED,
        RebalanceOperationStatus.EXPIRED,
      ];

      expect(validStatuses).toContain('pending');
      expect(validStatuses).toContain('awaiting_callback');
      expect(validStatuses).toContain('completed');
      expect(validStatuses).toContain('expired');
    });
  });

  describe('Type Exports', () => {
    it('should export all necessary types', () => {
      // This test ensures that all types are properly exported
      const typeChecks = {
        DatabaseConfig: {} as DatabaseConfig,
        HealthCheckResult: {} as HealthCheckResult,
      };

      expect(typeChecks.DatabaseConfig).toBeDefined();
      expect(typeChecks.HealthCheckResult).toBeDefined();
    });
  });

  describe('getRebalanceOperationByTransactionHash (unit)', () => {
    beforeEach(() => {
      initializeDatabase(MOCK_DATABASE_CONFIG);
    });

    it('returns undefined when no matching transaction', async () => {
      // First query returns no transaction rows
      mockPoolInstance.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await getRebalanceOperationByTransactionHash('0xabc', 1);

      // Ensure first query matches our expected SQL shape
      expect(mockPoolInstance.query).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(transaction_hash) = LOWER($1) AND chain_id = $2'),
        ['0xabc', '1']
      );
      expect(result).toBeUndefined();
    });

    it('returns operation and associated transactions when found', async () => {
      const operationId = '11111111-1111-1111-1111-111111111111';
      const txRow = {
        id: '22222222-2222-2222-2222-222222222222',
        rebalance_operation_id: operationId,
        transaction_hash: '0xdeadbeef',
        chain_id: '1',
        cumulative_gas_used: '21000',
        effective_gas_price: '10000000000',
        from: '0xfrom',
        to: '0xto',
        reason: 'Rebalance',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      };

      const opRow = {
        id: operationId,
        earmark_id: null,
        origin_chain_id: 1,
        destination_chain_id: 10,
        ticker_hash: '0xasset',
        amount: '100',
        slippage: 100,
        bridge: 'test-bridge',
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      };

      // 1) Find transaction
      mockPoolInstance.query.mockResolvedValueOnce({ rows: [txRow], rowCount: 1 });
      // 2) Load operation
      mockPoolInstance.query.mockResolvedValueOnce({ rows: [opRow], rowCount: 1 });
      // 3) Load all transactions for operation
      const opTxRow2 = {
        ...txRow,
        id: '33333333-3333-3333-3333-333333333333',
        transaction_hash: '0xfeedface',
        chain_id: '10',
      };
      mockPoolInstance.query.mockResolvedValueOnce({ rows: [txRow, opTxRow2], rowCount: 2 });

      const result = await getRebalanceOperationByTransactionHash('0xDEADBEEF', 1);

      expect(result).toBeDefined();
      expect(result!.id).toBe(operationId);
      expect(result!.originChainId).toBe(1);
      expect(result!.destinationChainId).toBe(10);
      expect(result!.transactions).toBeDefined();
      // Should be keyed by chainId as strings
      expect(Object.keys(result!.transactions)).toEqual(expect.arrayContaining(['1', '10']));
      expect(result!.transactions['1'].transactionHash).toBe('0xdeadbeef');
      expect(result!.transactions['10'].transactionHash).toBe('0xfeedface');
    });
  });
});
