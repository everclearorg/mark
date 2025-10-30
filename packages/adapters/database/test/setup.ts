// Consolidated test setup for database adapter
import { Client, Pool } from 'pg';
import { exec } from 'child_process';
import { promisify } from 'util';
import { initializeDatabase, closeDatabase, getPool } from '../src/db';
import { DatabaseConfig } from '../src/types';

const execAsync = promisify(exec);

// Test database configuration
export const TEST_DATABASE_CONFIG: DatabaseConfig = {
  connectionString:
    process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/mark_test?sslmode=disable',
  maxConnections: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
};

// Global Jest setup - runs once before all test suites
export default async function globalSetup() {
  // Connect to postgres database to create test database
  const client = new Client({
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres', // Connect to default postgres db
  });

  try {
    await client.connect();

    // Try to create database, ignore error if it already exists
    try {
      await client.query('CREATE DATABASE mark_test');
      console.log('Created test database: mark_test');

      // Run migrations on test database
      const testDbUrl = TEST_DATABASE_CONFIG.connectionString;
      await execAsync(`DATABASE_URL="${testDbUrl}" yarn db:migrate`);
      console.log('Ran migrations on test database');
    } catch (error) {
      // Database already exists, which is fine
      const pgError = error as { code?: string };
      if (pgError.code !== '42P04') {
        // 42P04 is "database already exists"
        throw error;
      }
    }
  } catch (error) {
    console.error('Error setting up test database:', error);
    throw error;
  } finally {
    await client.end();
  }
}

// Setup test database connection for integration tests
export async function setupTestDatabase(): Promise<void> {
  process.env.NODE_ENV = 'test';
  initializeDatabase(TEST_DATABASE_CONFIG);
}

// Cleanup test database for integration tests
export async function cleanupTestDatabase(): Promise<void> {
  const db = getPool();
  if (db) {
    // Clean up all test data in correct dependency order
    await db.query('DELETE FROM transactions');
    await db.query('DELETE FROM cex_withdrawals');
    await db.query('DELETE FROM rebalance_operations');
    await db.query('DELETE FROM earmarks');
    await db.query('DELETE FROM admin_actions');
  }
}

// Teardown database connection
export async function teardownTestDatabase(): Promise<void> {
  await closeDatabase();
}

// Get test database connection
export function getTestConnection(): Pool {
  return getPool();
}

// Mock factory for unit tests - creates a mock Pool instance
export function createMockPool() {
  const mockPool = {
    query: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
    connect: jest.fn(),
  };

  // Default successful responses
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockPool.end.mockResolvedValue(undefined);
  mockPool.connect.mockResolvedValue({
    query: mockPool.query,
    release: jest.fn(),
  });

  return mockPool;
}

// Mock configuration for unit tests
export const MOCK_DATABASE_CONFIG: DatabaseConfig = {
  connectionString: 'postgresql://localhost:5432/test_db',
  maxConnections: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 1000,
};
