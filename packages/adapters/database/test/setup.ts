// Test setup for database adapter
process.env.NODE_ENV = 'test';

// Set test database URL if not provided
if (!process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:password@localhost:5432/mark_test?sslmode=disable';
}