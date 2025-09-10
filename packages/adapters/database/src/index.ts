// Database adapter module exports
import { Pool } from 'pg';
import { getPool, initializeDatabase, closeDatabase } from './db';
import { DatabaseConfig } from './types';

// Re-export all core functionality
export * from './db';
export * from './types';
// Schema types are exported via db.ts

// Core earmark operations
export {
  createEarmark,
  getEarmarks,
  getEarmarkForInvoice,
  removeEarmark,
  updateEarmarkStatus,
  getActiveEarmarksForChain,
  createRebalanceOperation,
  updateRebalanceOperation,
  getRebalanceOperationsByEarmark,
  getRebalanceOperations,
  getTransactionsForRebalanceOperations,
  getRebalanceOperationByTransactionHash,
  createCexWithdrawalRecord,
  getCexWithdrawalRecord,
  setPause,
  isPaused,
  withTransaction,
  type CreateEarmarkInput,
  type GetEarmarksFilter,
} from './db';

// Health check and utility functions
export interface HealthCheckResult {
  healthy: boolean;
  error?: string;
  latency?: number;
  timestamp: Date;
}

export async function checkDatabaseHealth(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const timestamp = new Date();

  try {
    const pool = getPool();
    const result = await pool.query('SELECT 1 as health_check');

    if (result.rows[0]?.health_check === 1) {
      return {
        healthy: true,
        latency: Date.now() - startTime,
        timestamp,
      };
    } else {
      return {
        healthy: false,
        error: 'Unexpected health check result',
        timestamp,
      };
    }
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp,
    };
  }
}

export async function connectWithRetry(
  config: DatabaseConfig,
  maxRetries: number = 5,
  delayMs: number = 1000,
): Promise<Pool> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const pool = initializeDatabase(config);

      // Test the connection
      await pool.query('SELECT 1');
      return pool;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown connection error');

      if (attempt === maxRetries) {
        throw new Error(`Failed to connect to database after ${maxRetries} attempts. Last error: ${lastError.message}`);
      }

      // Wait before retrying (exponential backoff)
      const delay = delayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Failed to connect to database');
}

export async function gracefulShutdown(timeoutMs: number = 5000): Promise<void> {
  const shutdownPromise = closeDatabase();
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Database shutdown timeout')), timeoutMs);
  });

  try {
    await Promise.race([shutdownPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    if (error instanceof Error && error.message === 'Database shutdown timeout') {
      console.warn('Database shutdown timed out, forcing close');
      // Force close if graceful shutdown times out
      process.exit(1);
    }
    throw error;
  }
}

// Setup process handlers for graceful shutdown
if (typeof process !== 'undefined') {
  const handleShutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down database connections...`);
    try {
      await gracefulShutdown();
      console.log('Database connections closed successfully');
      process.exit(0);
    } catch (error) {
      console.error('Error during database shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}
