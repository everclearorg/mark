// Test setup for database adapter
import { initializeDatabase, closeDatabase, getPool } from '../src/db';

process.env.NODE_ENV = 'test';

// Set test database URL if not provided
if (!process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:password@localhost:5432/mark_test?sslmode=disable';
}

export async function setupDatabase(): Promise<void> {
  const config = {
    connectionString: process.env.TEST_DATABASE_URL!,
    maxConnections: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  };

  initializeDatabase(config);
}

export async function teardownDatabase(): Promise<void> {
  await closeDatabase();
}

export function getTestConnection() {
  return getPool();
}
