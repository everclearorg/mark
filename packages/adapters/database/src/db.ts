// Database connection and query utilities with zapatos integration

import { Pool, PoolClient } from 'pg';
import { DatabaseConfig } from './types';
import {
  earmarks,
  rebalance_operations,
  earmark_audit_log,
  earmarks_insert,
  rebalance_operations_insert,
  earmark_audit_log_insert,
  earmarks_update,
  rebalance_operations_update,
  earmark_audit_log_update,
  WhereCondition,
  DatabaseSchema,
} from './zapatos/schema';

let pool: Pool | null = null;

export function initializeDatabase(config: DatabaseConfig): Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections || 20,
    idleTimeoutMillis: config.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
  });

  // Handle pool errors
  pool.on('error', (err) => {
    console.error('Unexpected database error', err);
    process.exit(-1);
  });

  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Zapatos-style query helper functions
export async function queryWithClient<T>(query: string, values?: unknown[]): Promise<T[]> {
  const client = getPool();
  const result = await client.query(query, values);
  return result.rows;
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Typed database operations
export const db = {
  earmarks: {
    async select(where?: WhereCondition<earmarks>): Promise<earmarks[]> {
      let query = 'SELECT * FROM earmarks';
      const values: unknown[] = [];

      if (where && typeof where === 'object') {
        const conditions: string[] = [];
        let paramCount = 1;

        Object.entries(where).forEach(([key, value]) => {
          if (value !== undefined) {
            conditions.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
          }
        });

        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' AND ');
        }
      }

      return queryWithClient<earmarks>(query, values);
    },

    async insert(data: earmarks_insert): Promise<earmarks> {
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

      const query = `
        INSERT INTO earmarks (${keys.join(', ')})
        VALUES (${placeholders})
        RETURNING *
      `;

      const result = await queryWithClient<earmarks>(query, values);
      return result[0];
    },

    async update(where: WhereCondition<earmarks>, data: earmarks_update): Promise<earmarks[]> {
      const updateKeys = Object.keys(data);
      const updateValues = Object.values(data);
      let paramCount = 1;

      const setClause = updateKeys.map((key) => `${key} = $${paramCount++}`).join(', ');

      let whereClause = '';
      if (where && typeof where === 'object') {
        const conditions: string[] = [];
        Object.entries(where).forEach(([key, value]) => {
          if (value !== undefined) {
            conditions.push(`${key} = $${paramCount++}`);
            updateValues.push(value);
          }
        });
        whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
      }

      const query = `UPDATE earmarks SET ${setClause}${whereClause} RETURNING *`;
      return queryWithClient<earmarks>(query, updateValues);
    },

    async delete(where: WhereCondition<earmarks>): Promise<earmarks[]> {
      let query = 'DELETE FROM earmarks';
      const values: unknown[] = [];

      if (where && typeof where === 'object') {
        const conditions: string[] = [];
        let paramCount = 1;

        Object.entries(where).forEach(([key, value]) => {
          if (value !== undefined) {
            conditions.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
          }
        });

        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' AND ');
        }
      }

      query += ' RETURNING *';
      return queryWithClient<earmarks>(query, values);
    },
  },

  rebalance_operations: {
    async select(where?: WhereCondition<rebalance_operations>): Promise<rebalance_operations[]> {
      let query = 'SELECT * FROM rebalance_operations';
      const values: unknown[] = [];

      if (where && typeof where === 'object') {
        const conditions: string[] = [];
        let paramCount = 1;

        Object.entries(where).forEach(([key, value]) => {
          if (value !== undefined) {
            conditions.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
          }
        });

        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' AND ');
        }
      }

      return queryWithClient<rebalance_operations>(query, values);
    },

    async insert(data: rebalance_operations_insert): Promise<rebalance_operations> {
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

      const query = `
        INSERT INTO rebalance_operations (${keys.join(', ')})
        VALUES (${placeholders})
        RETURNING *
      `;

      const result = await queryWithClient<rebalance_operations>(query, values);
      return result[0];
    },
  },

  earmark_audit_log: {
    async insert(data: earmark_audit_log_insert): Promise<earmark_audit_log> {
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

      const query = `
        INSERT INTO earmark_audit_log (${keys.join(', ')})
        VALUES (${placeholders})
        RETURNING *
      `;

      const result = await queryWithClient<earmark_audit_log>(query, values);
      return result[0];
    },

    async select(where?: WhereCondition<earmark_audit_log>): Promise<earmark_audit_log[]> {
      let query = 'SELECT * FROM earmark_audit_log';
      const values: unknown[] = [];

      if (where && typeof where === 'object') {
        const conditions: string[] = [];
        let paramCount = 1;

        Object.entries(where).forEach(([key, value]) => {
          if (value !== undefined) {
            conditions.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
          }
        });

        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' AND ');
        }
      }

      query += ' ORDER BY timestamp DESC';
      return queryWithClient<earmark_audit_log>(query, values);
    },
  },
};

// Core earmark operations with business logic
export interface CreateEarmarkInput {
  invoiceId: string;
  destinationChainId: number;
  tickerHash: string;
  invoiceAmount: string;
  initialRebalanceOperations?: {
    originChainId: number;
    amount: string;
    slippage?: string;
  }[];
}

export interface GetEarmarksFilter {
  status?: string | string[];
  destinationChainId?: number | number[];
  tickerHash?: string | string[];
  invoiceId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

export async function createEarmark(input: CreateEarmarkInput): Promise<earmarks> {
  return withTransaction(async (client) => {
    // Insert earmark
    const earmarkData: earmarks_insert = {
      invoiceId: input.invoiceId,
      destinationChainId: input.destinationChainId,
      tickerHash: input.tickerHash,
      invoiceAmount: input.invoiceAmount,
      status: 'pending',
    };

    const insertQuery = `
      INSERT INTO earmarks (invoiceId, destinationChainId, tickerHash, invoiceAmount, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const earmarkResult = await client.query(insertQuery, [
      earmarkData.invoiceId,
      earmarkData.destinationChainId,
      earmarkData.tickerHash,
      earmarkData.invoiceAmount,
      earmarkData.status,
    ]);

    const earmark = earmarkResult.rows[0] as earmarks;

    // Create associated rebalance operations if provided
    if (input.initialRebalanceOperations && input.initialRebalanceOperations.length > 0) {
      for (const operation of input.initialRebalanceOperations) {
        const operationQuery = `
          INSERT INTO rebalance_operations (earmarkId, originChainId, destinationChainId, tickerHash, amount, slippage, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;

        await client.query(operationQuery, [
          earmark.id,
          operation.originChainId,
          input.destinationChainId,
          input.tickerHash,
          operation.amount,
          operation.slippage || '0.005',
          'pending',
        ]);
      }
    }

    // Create audit log entry
    const auditQuery = `
      INSERT INTO earmark_audit_log (earmarkId, operation, new_status, details)
      VALUES ($1, $2, $3, $4)
    `;

    await client.query(auditQuery, [
      earmark.id,
      'CREATE',
      'pending',
      JSON.stringify({
        invoiceId: input.invoiceId,
        destinationChainId: input.destinationChainId,
        tickerHash: input.tickerHash,
        invoiceAmount: input.invoiceAmount,
        initialOperationsCount: input.initialRebalanceOperations?.length || 0,
      }),
    ]);

    return earmark;
  });
}

export async function getEarmarks(filter?: GetEarmarksFilter): Promise<earmarks[]> {
  let query = 'SELECT * FROM earmarks';
  const values: unknown[] = [];
  const conditions: string[] = [];
  let paramCount = 1;

  if (filter) {
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        const placeholders = filter.status.map(() => `$${paramCount++}`).join(', ');
        conditions.push(`status IN (${placeholders})`);
        values.push(...filter.status);
      } else {
        conditions.push(`status = $${paramCount++}`);
        values.push(filter.status);
      }
    }

    if (filter.destinationChainId) {
      if (Array.isArray(filter.destinationChainId)) {
        const placeholders = filter.destinationChainId.map(() => `$${paramCount++}`).join(', ');
        conditions.push(`destinationChainId IN (${placeholders})`);
        values.push(...filter.destinationChainId);
      } else {
        conditions.push(`destinationChainId = $${paramCount++}`);
        values.push(filter.destinationChainId);
      }
    }

    if (filter.tickerHash) {
      if (Array.isArray(filter.tickerHash)) {
        const placeholders = filter.tickerHash.map(() => `$${paramCount++}`).join(', ');
        conditions.push(`tickerHash IN (${placeholders})`);
        values.push(...filter.tickerHash);
      } else {
        conditions.push(`tickerHash = $${paramCount++}`);
        values.push(filter.tickerHash);
      }
    }

    if (filter.invoiceId) {
      conditions.push(`invoiceId = $${paramCount++}`);
      values.push(filter.invoiceId);
    }

    if (filter.createdAfter) {
      conditions.push(`created_at >= $${paramCount++}`);
      values.push(filter.createdAfter);
    }

    if (filter.createdBefore) {
      conditions.push(`created_at <= $${paramCount++}`);
      values.push(filter.createdBefore);
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  return queryWithClient<earmarks>(query, values);
}

export async function getEarmarkForInvoice(invoiceId: string): Promise<earmarks | null> {
  const query = 'SELECT * FROM earmarks WHERE invoiceId = $1';
  const result = await queryWithClient<earmarks>(query, [invoiceId]);

  if (result.length === 0) {
    return null;
  }

  if (result.length > 1) {
    throw new Error(`Multiple earmarks found for invoice ${invoiceId}. Expected unique constraint violation.`);
  }

  return result[0];
}

export async function removeEarmark(earmarkId: string): Promise<void> {
  return withTransaction(async (client) => {
    // Get earmark details for audit log
    const earmarkQuery = 'SELECT * FROM earmarks WHERE id = $1';
    const earmarkResult = await client.query(earmarkQuery, [earmarkId]);

    if (earmarkResult.rows.length === 0) {
      throw new Error(`Earmark with id ${earmarkId} not found`);
    }

    const earmark = earmarkResult.rows[0] as earmarks;

    // Create audit log entry before deletion
    const auditQuery = `
      INSERT INTO earmark_audit_log (earmarkId, operation, previous_status, details)
      VALUES ($1, $2, $3, $4)
    `;

    await client.query(auditQuery, [
      earmarkId,
      'DELETE',
      earmark.status,
      JSON.stringify({
        deletedAt: new Date().toISOString(),
        finalStatus: earmark.status,
        invoiceId: earmark.invoiceId,
      }),
    ]);

    // Delete rebalance operations (will cascade due to FK constraint)
    const deleteOperationsQuery = 'DELETE FROM rebalance_operations WHERE earmarkId = $1';
    await client.query(deleteOperationsQuery, [earmarkId]);

    // Delete the earmark (audit log entries will cascade)
    const deleteEarmarkQuery = 'DELETE FROM earmarks WHERE id = $1';
    await client.query(deleteEarmarkQuery, [earmarkId]);
  });
}

// Additional helper functions for on-demand rebalancing

export async function updateEarmarkStatus(
  earmarkId: string,
  status: 'pending' | 'completed' | 'failed',
): Promise<earmarks> {
  return withTransaction(async (client) => {
    // Get current earmark for audit
    const currentQuery = 'SELECT * FROM earmarks WHERE id = $1';
    const currentResult = await client.query(currentQuery, [earmarkId]);

    if (currentResult.rows.length === 0) {
      throw new Error(`Earmark with id ${earmarkId} not found`);
    }

    const current = currentResult.rows[0] as earmarks;

    // Update earmark status
    const updateQuery = 'UPDATE earmarks SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *';
    const updateResult = await client.query(updateQuery, [status, earmarkId]);
    const updated = updateResult.rows[0] as earmarks;

    // Create audit log entry
    const auditQuery = `
      INSERT INTO earmark_audit_log (earmarkId, operation, previous_status, new_status, details)
      VALUES ($1, $2, $3, $4, $5)
    `;

    await client.query(auditQuery, [
      earmarkId,
      'STATUS_CHANGE',
      current.status,
      status,
      JSON.stringify({
        reason: `Status changed from ${current.status} to ${status}`,
        timestamp: new Date().toISOString(),
      }),
    ]);

    return updated;
  });
}

export async function getActiveEarmarksForChain(chainId: number): Promise<earmarks[]> {
  const query = `
    SELECT * FROM earmarks
    WHERE destinationChainId = $1
    AND status = 'pending'
    ORDER BY created_at ASC
  `;
  return queryWithClient<earmarks>(query, [chainId]);
}

export async function createRebalanceOperation(input: {
  earmarkId: string;
  originChainId: number;
  destinationChainId: number;
  amountSent: string;
  amountReceived: string;
  slippage: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  recipient: string;
  originTxHash?: string;
}): Promise<rebalance_operations> {
  const query = `
    INSERT INTO rebalance_operations (
      earmarkId, originChainId, destinationChainId,
      amountSent, amountReceived, maxSlippage,
      status, recipient, originTxHash
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `;

  const values = [
    input.earmarkId,
    input.originChainId,
    input.destinationChainId,
    input.amountSent,
    input.amountReceived,
    input.slippage,
    input.status,
    input.recipient,
    input.originTxHash || null,
  ];

  const result = await queryWithClient<rebalance_operations>(query, values);
  return result[0];
}

export async function updateRebalanceOperation(
  operationId: string,
  updates: {
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    originTxHash?: string;
    destinationTxHash?: string;
    callbackTxHash?: string;
  },
): Promise<rebalance_operations> {
  const setClause: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let paramCount = 1;

  if (updates.status !== undefined) {
    setClause.push(`status = $${paramCount++}`);
    values.push(updates.status);
  }

  if (updates.originTxHash !== undefined) {
    setClause.push(`originTxHash = $${paramCount++}`);
    values.push(updates.originTxHash);
  }

  if (updates.destinationTxHash !== undefined) {
    setClause.push(`destinationTxHash = $${paramCount++}`);
    values.push(updates.destinationTxHash);
  }

  if (updates.callbackTxHash !== undefined) {
    setClause.push(`callbackTxHash = $${paramCount++}`);
    values.push(updates.callbackTxHash);
  }

  values.push(operationId);

  const query = `
    UPDATE rebalance_operations
    SET ${setClause.join(', ')}
    WHERE id = $${paramCount}
    RETURNING *
  `;

  const result = await queryWithClient<rebalance_operations>(query, values);

  if (result.length === 0) {
    throw new Error(`Rebalance operation with id ${operationId} not found`);
  }

  return result[0];
}

export async function getRebalanceOperationsByEarmark(earmarkId: string): Promise<rebalance_operations[]> {
  const query = `
    SELECT * FROM rebalance_operations
    WHERE earmarkId = $1
    ORDER BY created_at ASC
  `;
  return queryWithClient<rebalance_operations>(query, [earmarkId]);
}

// Re-export types for convenience
export type {
  earmarks,
  rebalance_operations,
  earmark_audit_log,
  earmarks_insert,
  rebalance_operations_insert,
  earmark_audit_log_insert,
  earmarks_update,
  rebalance_operations_update,
  earmark_audit_log_update,
  DatabaseSchema,
};
