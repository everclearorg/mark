import { Pool } from 'pg';
import {
  initializeDatabase,
  closeDatabase,
  checkDatabaseHealth,
  connectWithRetry,
  gracefulShutdown,
  db,
  DatabaseConfig,
  HealthCheckResult,
} from '../src';

// Mock configuration for testing
const mockConfig: DatabaseConfig = {
  connectionString: 'postgresql://localhost:5432/test_db',
  maxConnections: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 1000,
};

// Create a mock pool object
const mockPoolInstance = {
  query: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
  connect: jest.fn(),
};

// Mock pg Pool for testing
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => mockPoolInstance),
}));

describe('Database Adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up after each test
    await closeDatabase();
  });

  describe('Connection Management', () => {
    it('should initialize database with correct configuration', () => {
      const pool = initializeDatabase(mockConfig);

      expect(Pool).toHaveBeenCalledWith({
        connectionString: mockConfig.connectionString,
        max: mockConfig.maxConnections,
        idleTimeoutMillis: mockConfig.idleTimeoutMillis,
        connectionTimeoutMillis: mockConfig.connectionTimeoutMillis,
      });

      expect(pool).toBe(mockPoolInstance);
    });

    it('should return existing pool on subsequent calls', () => {
      const pool1 = initializeDatabase(mockConfig);
      const pool2 = initializeDatabase(mockConfig);

      expect(pool1).toBe(pool2);
      expect(Pool).toHaveBeenCalledTimes(1);
    });

    it('should close database connection', async () => {
      initializeDatabase(mockConfig);
      await closeDatabase();

      expect(mockPoolInstance.end).toHaveBeenCalled();
    });
  });

  describe('Health Check', () => {
    beforeEach(() => {
      initializeDatabase(mockConfig);
    });

    it('should return healthy status when database responds correctly', async () => {
      mockPoolInstance.query.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  rows: [{ health_check: 1 }],
                  command: 'SELECT',
                  rowCount: 1,
                  oid: 0,
                  fields: [],
                }),
              1,
            ),
          ),
      );

      const result: HealthCheckResult = await checkDatabaseHealth();

      expect(result.healthy).toBe(true);
      expect(result.latency).toBeGreaterThan(0);
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

    it('should return unhealthy status when health check returns unexpected result', async () => {
      mockPoolInstance.query.mockResolvedValue({
        rows: [{ health_check: 0 }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result: HealthCheckResult = await checkDatabaseHealth();

      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Unexpected health check result');
    });
  });

  describe('Connection Retry Logic', () => {
    it('should succeed on first attempt when connection works', async () => {
      mockPoolInstance.query.mockResolvedValue({
        rows: [{ test: 1 }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const pool = await connectWithRetry(mockConfig, 3, 100);

      expect(pool).toBe(mockPoolInstance);
      expect(mockPoolInstance.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('should retry on connection failure and eventually succeed', async () => {
      mockPoolInstance.query
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockResolvedValue({
          rows: [{ test: 1 }],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      const pool = await connectWithRetry(mockConfig, 3, 10); // Short delay for testing

      expect(pool).toBe(mockPoolInstance);
      expect(mockPoolInstance.query).toHaveBeenCalledTimes(3);
    });

    it('should throw error after max retries exceeded', async () => {
      const errorMessage = 'Persistent connection failure';
      mockPoolInstance.query.mockRejectedValue(new Error(errorMessage));

      await expect(connectWithRetry(mockConfig, 2, 10)).rejects.toThrow(
        'Failed to connect to database after 2 attempts',
      );

      expect(mockPoolInstance.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('Graceful Shutdown', () => {
    beforeEach(() => {
      initializeDatabase(mockConfig);
    });

    it('should shutdown gracefully within timeout', async () => {
      mockPoolInstance.end.mockResolvedValue(undefined);

      await expect(gracefulShutdown(1000)).resolves.toBeUndefined();
      expect(mockPoolInstance.end).toHaveBeenCalled();
    });

    it('should handle shutdown timeout', async () => {
      mockPoolInstance.end.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 2000)));

      // Mock process.exit to prevent actual exit in tests
      const originalExit = process.exit;
      process.exit = jest.fn() as never;

      await expect(gracefulShutdown(100)).rejects.toThrow('Database shutdown timeout');

      process.exit = originalExit;
    });
  });

  describe('Database Operations', () => {
    beforeEach(() => {
      initializeDatabase(mockConfig);
    });

    it('should have properly typed database operations', () => {
      expect(db.earmarks).toBeDefined();
      expect(db.rebalance_operations).toBeDefined();

      expect(typeof db.earmarks.select).toBe('function');
      expect(typeof db.earmarks.insert).toBe('function');
      expect(typeof db.earmarks.update).toBe('function');
      expect(typeof db.earmarks.delete).toBe('function');
    });

    it('should call correct SQL for earmarks select', async () => {
      mockPoolInstance.query.mockResolvedValue({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      await db.earmarks.select({ status: 'pending' });

      expect(mockPoolInstance.query).toHaveBeenCalledWith('SELECT * FROM earmarks WHERE status = $1', ['pending']);
    });
  });

  describe('Type Exports', () => {
    it('should export all necessary types', () => {
      // Import types to ensure they're properly exported
      const config: DatabaseConfig = {
        connectionString: 'test',
      };

      expect(config).toBeDefined();
    });
  });
});

describe('Module Integration', () => {
  it('should export all required functions and types', () => {
    expect(initializeDatabase).toBeDefined();
    expect(closeDatabase).toBeDefined();
    expect(checkDatabaseHealth).toBeDefined();
    expect(connectWithRetry).toBeDefined();
    expect(gracefulShutdown).toBeDefined();
    expect(db).toBeDefined();
  });

  it('should have proper TypeScript types', () => {
    // Type-only test - ensures TypeScript compilation passes
    const config: DatabaseConfig = {
      connectionString: 'postgresql://localhost:5432/test',
      maxConnections: 10,
    };

    expect(config.connectionString).toBe('postgresql://localhost:5432/test');
    expect(config.maxConnections).toBe(10);
  });
});
