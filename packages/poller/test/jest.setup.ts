// Jest setup for database integration tests
import { initializeDatabase, closeDatabase } from '@mark/database';
import { reset, restore } from 'sinon';

// Import Jest globals for TypeScript
import '@jest/globals';

// Import shared console suppression
import '../../../jest.setup.shared.js';

// Set test database URL if not provided
if (!process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/mark_test?sslmode=disable';
}

beforeAll(async () => {
  const config = {
    connectionString: process.env.TEST_DATABASE_URL!,
    maxConnections: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  };

  initializeDatabase(config);
});

afterEach(() => {
  // Clean up all Sinon stubs after each test
  restore();
  reset();
});

afterAll(async () => {
  await closeDatabase();
});
