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
  DatabaseError,
  ConnectionError,
  BasicTransactionOptions,
} from '../src';
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
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });
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

  describe('Error Classes', () => {
    describe('DatabaseError', () => {
      it('should create DatabaseError with retryable flag', () => {
        const error = new DatabaseError('Test error', 'TEST_ERROR', true);
        expect(error.message).toBe('Test error');
        expect(error.code).toBe('TEST_ERROR');
        expect(error.retryable).toBe(true);
        expect(error.name).toBe('DatabaseError');
      });

      it('should create DatabaseError with default non-retryable flag', () => {
        const error = new DatabaseError('Test error');
        expect(error.message).toBe('Test error');
        expect(error.retryable).toBe(false);
      });
    });

    describe('ConnectionError', () => {
      it('should create ConnectionError as retryable', () => {
        const error = new ConnectionError('Connection lost');
        expect(error.message).toBe('Connection lost');
        expect(error.retryable).toBe(true);
        expect(error.name).toBe('ConnectionError');
      });

      it('should inherit from DatabaseError', () => {
        const error = new ConnectionError('Connection lost');
        expect(error).toBeInstanceOf(DatabaseError);
      });
    });
  });

  describe('Type Definitions', () => {
    it('should validate BasicTransactionOptions interface', () => {
      const options: BasicTransactionOptions = {
        retryAttempts: 3,
        retryDelayMs: 1000,
        timeoutMs: 30000,
      };

      expect(options.retryAttempts).toBe(3);
      expect(options.retryDelayMs).toBe(1000);
      expect(options.timeoutMs).toBe(30000);
    });

    it('should allow all optional fields in BasicTransactionOptions', () => {
      const options: BasicTransactionOptions = {};
      expect(options.retryAttempts).toBeUndefined();
      expect(options.retryDelayMs).toBeUndefined();
      expect(options.timeoutMs).toBeUndefined();
    });

    it('should validate operation status types from @mark/core', () => {
      const validStatuses = [
        RebalanceOperationStatus.PENDING,
        RebalanceOperationStatus.IN_PROGRESS,
        RebalanceOperationStatus.COMPLETED,
        RebalanceOperationStatus.FAILED,
      ];

      expect(validStatuses).toContain('pending');
      expect(validStatuses).toContain('in_progress');
      expect(validStatuses).toContain('completed');
      expect(validStatuses).toContain('failed');
    });
  });

  describe('Type Exports', () => {
    it('should export all necessary types', () => {
      // This test ensures that all types are properly exported
      const typeChecks = {
        DatabaseConfig: {} as DatabaseConfig,
        HealthCheckResult: {} as HealthCheckResult,
        DatabaseError: new DatabaseError('test'),
        ConnectionError: new ConnectionError('test'),
      };

      expect(typeChecks.DatabaseError).toBeInstanceOf(DatabaseError);
      expect(typeChecks.ConnectionError).toBeInstanceOf(ConnectionError);
    });
  });
});
