import { initializeDatabase, closeDatabase, getPool } from '../src/db';

describe('Database Connection', () => {
  afterEach(async () => {
    await closeDatabase();
  });

  it('should initialize database connection', () => {
    const pool = initializeDatabase({
      connectionString: process.env.TEST_DATABASE_URL!,
    });

    expect(pool).toBeDefined();
    expect(getPool()).toBe(pool);
  });

  it('should throw error when getting pool without initialization', () => {
    expect(() => getPool()).toThrow('Database not initialized');
  });

  it('should close database connection', async () => {
    initializeDatabase({
      connectionString: process.env.TEST_DATABASE_URL!,
    });

    await expect(closeDatabase()).resolves.not.toThrow();
  });
});