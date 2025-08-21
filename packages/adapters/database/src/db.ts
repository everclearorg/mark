// Database connection and query utilities with zapatos integration

import { Pool, PoolClient } from 'pg';
import { CamelCasedProperties, DatabaseConfig, TransactionReceipt } from './types';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';

// Import from the module declared in the schema file
import type * as schema from 'zapatos/schema';
import { camelToSnake, snakeToCamel } from './utils';

type earmarks = schema.earmarks.Selectable;
type rebalance_operations = schema.rebalance_operations.Selectable;
type transactions = schema.transactions.Selectable;
type earmarks_insert = schema.earmarks.Insertable;
type rebalance_operations_insert = schema.rebalance_operations.Insertable;
type transactions_insert = schema.transactions.Insertable;
type earmarks_update = schema.earmarks.Updatable;
type rebalance_operations_update = schema.rebalance_operations.Updatable;

// Custom types not provided by Zapatos
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

export async function createEarmark(input: CreateEarmarkInput): Promise<CamelCasedProperties<earmarks>> {
  return withTransaction(async (client) => {
    // Insert earmark
    const earmarkData: earmarks_insert = {
      ...camelToSnake(input),
      status: EarmarkStatus.PENDING,
    };

    const insertQuery = `
      INSERT INTO earmarks ("invoice_id", "designated_purchase_chain", "ticker_hash", "min_amount", status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const earmarkResult = await client.query(insertQuery, [
      earmarkData.invoice_id,
      earmarkData.designated_purchase_chain,
      input.tickerHash,
      earmarkData.min_amount,
      earmarkData.status,
    ]);

    const earmark = earmarkResult.rows[0] as earmarks;

    return snakeToCamel(earmark);
  });
}

export async function getEarmarks(filter?: GetEarmarksFilter): Promise<CamelCasedProperties<earmarks>[]> {
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
        conditions.push(`"designated_purchase_chain" IN (${placeholders})`);
        values.push(...filter.designatedPurchaseChain);
      } else {
        conditions.push(`"designated_purchase_chain" = $${paramCount++}`);
        values.push(filter.designatedPurchaseChain);
      }
    }

    if (filter.tickerHash) {
      if (Array.isArray(filter.tickerHash)) {
        const placeholders = filter.tickerHash.map(() => `$${paramCount++}`).join(', ');
        conditions.push(`"ticker_hash" IN (${placeholders})`);
        values.push(...filter.tickerHash);
      } else {
        conditions.push(`"ticker_hash" = $${paramCount++}`);
        values.push(filter.tickerHash);
      }
    }

    if (filter.invoiceId) {
      conditions.push(`"invoice_id" = $${paramCount++}`);
      values.push(filter.invoiceId);
    }

    if (filter.createdAfter) {
      conditions.push(`"created_at" >= $${paramCount++}`);
      values.push(filter.createdAfter);
    }

    if (filter.createdBefore) {
      conditions.push(`"created_at" <= $${paramCount++}`);
      values.push(filter.createdBefore);
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY "created_at" DESC';

  const ret = await queryWithClient<earmarks>(query, values);
  return ret.map(snakeToCamel);
}

export async function getEarmarkForInvoice(invoiceId: string): Promise<CamelCasedProperties<earmarks> | null> {
  const query = 'SELECT * FROM earmarks WHERE "invoice_id" = $1';
  const result = await queryWithClient<earmarks>(query, [invoiceId]);

  if (result.length === 0) {
    return null;
  }

  if (result.length > 1) {
    throw new Error(`Multiple earmarks found for invoice ${invoiceId}. Expected unique constraint violation.`);
  }

  return snakeToCamel(result[0]);
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
    const deleteOperationsQuery = 'DELETE FROM rebalance_operations WHERE "earmark_id" = $1';
    await client.query(deleteOperationsQuery, [earmarkId]);

    // Delete the earmark
    const deleteEarmarkQuery = 'DELETE FROM earmarks WHERE id = $1';
    await client.query(deleteEarmarkQuery, [earmarkId]);
  });
}

// Additional helper functions for on-demand rebalancing

export async function updateEarmarkStatus(
  earmarkId: string,
  status: EarmarkStatus,
): Promise<CamelCasedProperties<earmarks>> {
  return withTransaction(async (client) => {
    // Get current earmark
    const currentQuery = 'SELECT * FROM earmarks WHERE id = $1';
    const currentResult = await client.query(currentQuery, [earmarkId]);

    if (currentResult.rows.length === 0) {
      throw new Error(`Earmark with id ${earmarkId} not found`);
    }

    // Update earmark status
    const updateQuery = 'UPDATE earmarks SET status = $1, "updated_at" = NOW() WHERE id = $2 RETURNING *';
    const updateResult = await client.query(updateQuery, [status, earmarkId]);
    const updated = updateResult.rows[0] as earmarks;

    return snakeToCamel(updated);
  });
}

export async function getActiveEarmarksForChain(chainId: number): Promise<CamelCasedProperties<earmarks>[]> {
  const query = `
    SELECT * FROM earmarks
    WHERE "designated_purchase_chain" = $1
    AND status = 'pending'
    ORDER BY "created_at" ASC
  `;
  const ret = await queryWithClient<earmarks>(query, [chainId]);
  return ret.map(snakeToCamel);
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
  transactions?: Record<string, TransactionReceipt>;
}): Promise<CamelCasedProperties<rebalance_operations>> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const rebalanceQuery = `
      INSERT INTO rebalance_operations (
        "earmark_id", "origin_chain_id", "destination_chain_id",
        "ticker_hash", amount, slippage, status, bridge
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const rebalanceValues = [
      input.earmarkId,
      input.originChainId,
      input.destinationChainId,
      input.tickerHash,
      input.amount,
      input.slippage,
      input.status,
      input.bridge,
    ];

    const rebalanceResult = await client.query<rebalance_operations>(rebalanceQuery, rebalanceValues);
    const rebalanceOperation = rebalanceResult.rows[0];
    for (const [chainId, receipt] of Object.entries(input.transactions ?? {})) {
      const transactionQuery = `
        INSERT INTO transactions (
          rebalance_operation_id,
          transaction_hash,
          chain_id,
          cumulative_gas_used,
          effective_gas_price,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `;

      const transactionValues = [
        rebalanceOperation.id,
        receipt.transactionHash,
        chainId,
        receipt.cumulativeGasUsed,
        receipt.effectiveGasPrice,
        JSON.stringify({
          blockNumber: receipt.blockNumber,
          status: receipt.status,
          confirmations: receipt.confirmations,
        }),
      ];

      await client.query(transactionQuery, transactionValues);
    }

    await client.query('COMMIT');
    return snakeToCamel(rebalanceOperation);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateRebalanceOperation(
  operationId: string,
  updates: {
    status?: RebalanceOperationStatus;
    txHashes?: JSONObject;
  },
): Promise<rebalance_operations> {
  const setClause: string[] = ['"updated_at" = NOW()'];
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

export async function getRebalanceOperationsByEarmark(
  earmarkId: string,
): Promise<CamelCasedProperties<rebalance_operations>[]> {
  const query = `
    SELECT * FROM rebalance_operations
    WHERE "earmark_id" = $1
    ORDER BY "created_at" ASC
  `;
  const ret = await queryWithClient<rebalance_operations>(query, [earmarkId]);
  return ret.map(snakeToCamel);
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
      conditions.push(`"origin_chain_id" = $${paramCount}`);
      values.push(filter.chainId);
      paramCount++;
    }

    if (filter.earmarkId !== undefined) {
      if (filter.earmarkId === null) {
        conditions.push('"earmark_id" IS NULL');
      } else {
        conditions.push(`"earmark_id" = $${paramCount}`);
        values.push(filter.earmarkId);
        paramCount++;
      }
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY "created_at" ASC';

  return queryWithClient<rebalance_operations>(query, values);
}

// Re-export types for convenience
export type {
  earmarks,
  rebalance_operations,
  transactions,
  earmarks_insert,
  rebalance_operations_insert,
  transactions_insert,
  earmarks_update,
  rebalance_operations_update,
};
