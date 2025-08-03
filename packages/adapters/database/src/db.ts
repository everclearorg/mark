// Database connection and query utilities with zapatos integration

import { Pool, PoolClient } from 'pg';
import { DatabaseConfig } from './types';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';
import * as schema from 'zapatos/schema';

type earmarks = schema.earmarks.Selectable;
type rebalance_operations = schema.rebalance_operations.Selectable;
type earmarks_insert = schema.earmarks.Insertable;
type rebalance_operations_insert = schema.rebalance_operations.Insertable;
type earmarks_update = schema.earmarks.Updatable;
type rebalance_operations_update = schema.rebalance_operations.Updatable;

// Custom types not provided by Zapatos
type WhereCondition<T> = Partial<T>;
type JSONObject = Record<string, unknown>;

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
export const database = {
  earmarks: {
    async select(where?: WhereCondition<earmarks>): Promise<earmarks[]> {
      let query = 'SELECT * FROM earmarks';
      const values: unknown[] = [];

      if (where && typeof where === 'object') {
        const conditions: string[] = [];
        let paramCount = 1;

        Object.entries(where).forEach(([key, value]) => {
          if (value !== undefined) {
            // Only quote camelCase identifiers, not simple lowercase ones
            const quotedKey = /[A-Z]/.test(key) ? `"${key}"` : key;
            conditions.push(`${quotedKey} = $${paramCount}`);
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

      const setClause = updateKeys
        .map((key) => {
          const quotedKey = /[A-Z]/.test(key) ? `"${key}"` : key;
          return `${quotedKey} = $${paramCount++}`;
        })
        .join(', ');

      let whereClause = '';
      if (where && typeof where === 'object') {
        const conditions: string[] = [];
        Object.entries(where).forEach(([key, value]) => {
          if (value !== undefined) {
            const quotedKey = /[A-Z]/.test(key) ? `"${key}"` : key;
            conditions.push(`${quotedKey} = $${paramCount++}`);
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
            // Only quote camelCase identifiers, not simple lowercase ones
            const quotedKey = /[A-Z]/.test(key) ? `"${key}"` : key;
            conditions.push(`${quotedKey} = $${paramCount}`);
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
            // Only quote camelCase identifiers, not simple lowercase ones
            const quotedKey = /[A-Z]/.test(key) ? `"${key}"` : key;
            conditions.push(`${quotedKey} = $${paramCount}`);
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
};

// Core earmark operations with business logic
export interface CreateEarmarkInput {
  invoiceId: string;
  designatedPurchaseChain: number;
  tickerHash: string;
  minAmount: string;
}

export interface GetEarmarksFilter {
  status?: string | string[];
  designatedPurchaseChain?: number | number[];
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
      designatedPurchaseChain: input.designatedPurchaseChain,
      tickerHash: input.tickerHash,
      minAmount: input.minAmount,
      status: EarmarkStatus.PENDING,
    };

    const insertQuery = `
      INSERT INTO earmarks ("invoiceId", "designatedPurchaseChain", "tickerHash", "minAmount", status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const earmarkResult = await client.query(insertQuery, [
      earmarkData.invoiceId,
      earmarkData.designatedPurchaseChain,
      input.tickerHash,
      earmarkData.minAmount,
      earmarkData.status,
    ]);

    const earmark = earmarkResult.rows[0] as earmarks;

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

    if (filter.designatedPurchaseChain) {
      if (Array.isArray(filter.designatedPurchaseChain)) {
        const placeholders = filter.designatedPurchaseChain.map(() => `$${paramCount++}`).join(', ');
        conditions.push(`"designatedPurchaseChain" IN (${placeholders})`);
        values.push(...filter.designatedPurchaseChain);
      } else {
        conditions.push(`"designatedPurchaseChain" = $${paramCount++}`);
        values.push(filter.designatedPurchaseChain);
      }
    }

    if (filter.tickerHash) {
      if (Array.isArray(filter.tickerHash)) {
        const placeholders = filter.tickerHash.map(() => `$${paramCount++}`).join(', ');
        conditions.push(`"tickerHash" IN (${placeholders})`);
        values.push(...filter.tickerHash);
      } else {
        conditions.push(`"tickerHash" = $${paramCount++}`);
        values.push(filter.tickerHash);
      }
    }

    if (filter.invoiceId) {
      conditions.push(`"invoiceId" = $${paramCount++}`);
      values.push(filter.invoiceId);
    }

    if (filter.createdAfter) {
      conditions.push(`"createdAt" >= $${paramCount++}`);
      values.push(filter.createdAfter);
    }

    if (filter.createdBefore) {
      conditions.push(`"createdAt" <= $${paramCount++}`);
      values.push(filter.createdBefore);
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY "createdAt" DESC';

  return queryWithClient<earmarks>(query, values);
}

export async function getEarmarkForInvoice(invoiceId: string): Promise<earmarks | null> {
  const query = 'SELECT * FROM earmarks WHERE "invoiceId" = $1';
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
    // Verify earmark exists
    const earmarkQuery = 'SELECT * FROM earmarks WHERE id = $1';
    const earmarkResult = await client.query(earmarkQuery, [earmarkId]);

    if (earmarkResult.rows.length === 0) {
      throw new Error(`Earmark with id ${earmarkId} not found`);
    }

    // Delete rebalance operations (will cascade due to FK constraint)
    const deleteOperationsQuery = 'DELETE FROM rebalance_operations WHERE "earmarkId" = $1';
    await client.query(deleteOperationsQuery, [earmarkId]);

    // Delete the earmark
    const deleteEarmarkQuery = 'DELETE FROM earmarks WHERE id = $1';
    await client.query(deleteEarmarkQuery, [earmarkId]);
  });
}

// Additional helper functions for on-demand rebalancing

export async function updateEarmarkStatus(earmarkId: string, status: EarmarkStatus): Promise<earmarks> {
  return withTransaction(async (client) => {
    // Get current earmark
    const currentQuery = 'SELECT * FROM earmarks WHERE id = $1';
    const currentResult = await client.query(currentQuery, [earmarkId]);

    if (currentResult.rows.length === 0) {
      throw new Error(`Earmark with id ${earmarkId} not found`);
    }

    // Update earmark status
    const updateQuery = 'UPDATE earmarks SET status = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING *';
    const updateResult = await client.query(updateQuery, [status, earmarkId]);
    const updated = updateResult.rows[0] as earmarks;

    return updated;
  });
}

export async function getActiveEarmarksForChain(chainId: number): Promise<earmarks[]> {
  const query = `
    SELECT * FROM earmarks
    WHERE "designatedPurchaseChain" = $1
    AND status = 'pending'
    ORDER BY "createdAt" ASC
  `;
  return queryWithClient<earmarks>(query, [chainId]);
}

export async function createRebalanceOperation(input: {
  earmarkId: string | null;
  originChainId: number;
  destinationChainId: number;
  tickerHash: string;
  amount: string;
  slippage: number;
  status: RebalanceOperationStatus;
  bridge: string;
  txHashes?: JSONObject;
}): Promise<rebalance_operations> {
  const query = `
    INSERT INTO rebalance_operations (
      "earmarkId", "originChainId", "destinationChainId",
      "tickerHash", amount, slippage, status, bridge, "txHashes"
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `;

  const values = [
    input.earmarkId,
    input.originChainId,
    input.destinationChainId,
    input.tickerHash,
    input.amount,
    input.slippage,
    input.status,
    input.bridge,
    input.txHashes || {},
  ];

  const result = await queryWithClient<rebalance_operations>(query, values);
  return result[0];
}

export async function updateRebalanceOperation(
  operationId: string,
  updates: {
    status?: RebalanceOperationStatus;
    txHashes?: JSONObject;
  },
): Promise<rebalance_operations> {
  const setClause: string[] = ['"updatedAt" = NOW()'];
  const values: unknown[] = [];
  let paramCount = 1;

  if (updates.status !== undefined) {
    setClause.push(`status = $${paramCount++}`);
    values.push(updates.status);
  }

  if (updates.txHashes !== undefined) {
    setClause.push(`"txHashes" = $${paramCount++}`);
    values.push(updates.txHashes);
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
    WHERE "earmarkId" = $1
    ORDER BY "createdAt" ASC
  `;
  return queryWithClient<rebalance_operations>(query, [earmarkId]);
}

export async function getRebalanceOperations(filter?: {
  status?: RebalanceOperationStatus | RebalanceOperationStatus[];
  chainId?: number;
  earmarkId?: string | null;
}): Promise<rebalance_operations[]> {
  let query = 'SELECT * FROM rebalance_operations';
  const values: unknown[] = [];
  const conditions: string[] = [];
  let paramCount = 1;

  if (filter) {
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        conditions.push(`status = ANY($${paramCount})`);
        values.push(filter.status);
      } else {
        conditions.push(`status = $${paramCount}`);
        values.push(filter.status);
      }
      paramCount++;
    }

    if (filter.chainId !== undefined) {
      conditions.push(`"originChainId" = $${paramCount}`);
      values.push(filter.chainId);
      paramCount++;
    }

    if (filter.earmarkId !== undefined) {
      if (filter.earmarkId === null) {
        conditions.push('"earmarkId" IS NULL');
      } else {
        conditions.push(`"earmarkId" = $${paramCount}`);
        values.push(filter.earmarkId);
        paramCount++;
      }
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY "createdAt" ASC';

  return queryWithClient<rebalance_operations>(query, values);
}

// Re-export types for convenience
export type {
  earmarks,
  rebalance_operations,
  earmarks_insert,
  rebalance_operations_insert,
  earmarks_update,
  rebalance_operations_update,
};

// Export database operations as 'db' for shorter access
export { database as db };
