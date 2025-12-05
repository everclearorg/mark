// Jest setup for database integration tests
import { initializeDatabase, closeDatabase } from '@mark/database';
import { reset, restore } from 'sinon';

// Import Jest globals for TypeScript
import '@jest/globals';

// Import shared console suppression
import '../../../jest.setup.shared.js';

const skipDbSetup = process.env.SKIP_DB_SETUP === 'true';

// Set test database URL if not provided (unless skipping DB entirely)
if (!skipDbSetup && !process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/mark_test?sslmode=disable';
}

beforeAll(async () => {
  if (skipDbSetup) {
    return;
  }
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
  if (skipDbSetup) {
    return;
  }
  await closeDatabase();
});
