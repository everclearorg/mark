// Simplified transaction patterns for blockchain recording
import { PoolClient } from 'pg';
import { getPool } from './db';

export interface BasicTransactionOptions {
  retryAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface RebalanceOperationRecord {
  invoiceId: string;
  originChainId: number;
  destinationChainId: number;
  ticker: string;
  amount: string;
  txHash: string;
  status: 'SUBMITTED' | 'COMPLETED' | 'FAILED';
  submittedAt: Date;
  completedAt?: Date;
  blockNumber?: number;
  metadata?: Record<string, unknown>;
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class ConnectionError extends DatabaseError {
  constructor(message: string) {
    super(message, 'CONNECTION_FAILED', true);
    this.name = 'ConnectionError';
  }
}

// Basic transaction wrapper for simple database operations
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  options: BasicTransactionOptions = {},
): Promise<T> {
  const { retryAttempts = 3, retryDelayMs = 100, timeoutMs = 30000 } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    const client = await getPool().connect();

    try {
      // Set transaction timeout
      if (timeoutMs > 0) {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
      }

      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');

      return result;
    } catch (error) {
      await client.query('ROLLBACK');

      const pgError = error as { code?: string; message?: string };
      lastError = error as Error;

      // Check for retryable network/connection errors
      if (isRetryableError(pgError) && attempt < retryAttempts) {
        const delay = calculateRetryDelay(attempt, retryDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Transform connection errors
      if (isConnectionError(pgError)) {
        throw new ConnectionError(pgError.message || 'Database connection failed');
      }

      throw error;
    } finally {
      client.release();
    }
  }

  throw lastError || new DatabaseError('Transaction failed after all retry attempts');
}

// Record a rebalance operation after blockchain submission
export async function recordRebalanceOperation(operation: RebalanceOperationRecord): Promise<string> {
  return withTransaction(async (client) => {
    const query = `
      INSERT INTO rebalance_operations (
        invoiceId, originChainId, destinationChainId, ticker,
        amount, txHash, status, submittedAt, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `;

    const result = await client.query(query, [
      operation.invoiceId,
      operation.originChainId,
      operation.destinationChainId,
      operation.ticker,
      operation.amount,
      operation.txHash,
      operation.status,
      operation.submittedAt,
      JSON.stringify(operation.metadata || {}),
    ]);

    return result.rows[0].id;
  });
}

// Idempotent update for blockchain event completion
export async function updateOperationStatus(
  operationId: string,
  status: 'COMPLETED' | 'FAILED',
  completionData: {
    txHash?: string;
    blockNumber?: number;
    timestamp?: Date;
    errorMessage?: string;
  } = {},
): Promise<void> {
  await withTransaction(async (client) => {
    // Check if already updated to prevent duplicate processing
    const existingQuery = `
      SELECT status, completedAt FROM rebalance_operations WHERE id = $1
    `;
    const existing = await client.query(existingQuery, [operationId]);

    if (existing.rows.length === 0) {
      throw new DatabaseError(`Operation ${operationId} not found`);
    }

    // If already completed/failed, this is idempotent - no-op
    if (existing.rows[0].status !== 'SUBMITTED') {
      return;
    }

    const updateQuery = `
      UPDATE rebalance_operations
      SET status = $1, completedAt = $2, blockNumber = $3, metadata = $4
      WHERE id = $5 AND status = 'SUBMITTED'
    `;

    const metadata = {
      completedTxHash: completionData.txHash,
      errorMessage: completionData.errorMessage,
      updatedAt: new Date().toISOString(),
    };

    await client.query(updateQuery, [
      status,
      completionData.timestamp || new Date(),
      completionData.blockNumber,
      JSON.stringify(metadata),
      operationId,
    ]);
  });
}

// Get pending rebalance operations for processing
export async function getPendingOperations(
  filters: {
    invoiceId?: string;
    chainId?: number;
    ticker?: string;
    olderThan?: Date;
  } = {},
): Promise<RebalanceOperationRecord[]> {
  const client = await getPool().connect();
  try {
    let query = `
      SELECT
        id, invoiceId, originChainId, destinationChainId, ticker,
        amount, txHash, status, submittedAt, completedAt, blockNumber,
        metadata
      FROM rebalance_operations
      WHERE status = 'SUBMITTED'
    `;

    const params: unknown[] = [];
    let paramCount = 0;

    if (filters.invoiceId) {
      query += ` AND invoiceId = $${++paramCount}`;
      params.push(filters.invoiceId);
    }

    if (filters.chainId) {
      query += ` AND (originChainId = $${++paramCount} OR destinationChainId = $${paramCount})`;
      params.push(filters.chainId);
    }

    if (filters.ticker) {
      query += ` AND ticker = $${++paramCount}`;
      params.push(filters.ticker);
    }

    if (filters.olderThan) {
      query += ` AND submittedAt < $${++paramCount}`;
      params.push(filters.olderThan);
    }

    query += ` ORDER BY submittedAt ASC`;

    const result = await client.query(query, params);
    return result.rows.map((row) => ({
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    }));
  } finally {
    client.release();
  }
}

// Helper functions
function isRetryableError(error: { code?: string }): boolean {
  const retryableCodes = [
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08004', // sqlserver_rejected_establishment_of_sqlconnection
    '53300', // too_many_connections
  ];

  return retryableCodes.includes(error.code || '');
}

function isConnectionError(error: { code?: string }): boolean {
  const connectionCodes = [
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08004', // sqlserver_rejected_establishment_of_sqlconnection
  ];

  return connectionCodes.includes(error.code || '');
}

function calculateRetryDelay(attempt: number, baseDelayMs: number): number {
  // Exponential backoff with jitter
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, 5000); // Cap at 5 seconds
}
