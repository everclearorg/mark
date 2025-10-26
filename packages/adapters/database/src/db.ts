// Database connection and query utilities with zapatos integration

import { Pool, PoolClient, PoolConfig } from 'pg';
import {
  CamelCasedProperties,
  DatabaseConfig,
  TransactionEntry,
  TransactionReasons,
  TransactionReceipt,
} from './types';
import { EarmarkStatus, RebalanceOperationStatus, serializeBigInt } from '@mark/core';

// Import from the module declared in the schema file
import type * as schema from 'zapatos/schema';
import { camelToSnake, snakeToCamel } from './utils';
import { JSONObject } from 'zapatos/db';

type earmarks = schema.earmarks.Selectable;
type rebalance_operations = schema.rebalance_operations.Selectable;
type transactions = schema.transactions.Selectable;
type earmarks_insert = schema.earmarks.Insertable;
type rebalance_operations_insert = schema.rebalance_operations.Insertable;
type transactions_insert = schema.transactions.Insertable;
type earmarks_update = schema.earmarks.Updatable;
type rebalance_operations_update = schema.rebalance_operations.Updatable;
type cex_withdrawals = schema.cex_withdrawals.Selectable;

let pool: Pool | null = null;

export function initializeDatabase(config: DatabaseConfig): Pool {
  if (pool) {
    return pool;
  }

  // Check if we need SSL based on connection string
  const needsSSL = config.connectionString.includes('sslmode=require');

  // Remove sslmode from connection string to avoid conflicts
  let connectionString = config.connectionString;
  if (needsSSL) {
    // Remove sslmode parameter to prevent it from overriding our ssl config
    connectionString = config.connectionString.replace(/\?sslmode=require/, '').replace(/&sslmode=require/, '');
  }

  const poolConfig: PoolConfig = {
    connectionString,
    max: config.maxConnections || 20,
    idleTimeoutMillis: config.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
  };

  // Configure SSL if needed
  if (needsSSL) {
    // For AWS RDS within VPC, accept self-signed certificates
    poolConfig.ssl = {
      rejectUnauthorized: false,
    };
    console.log('Database SSL: Configured for AWS RDS (accepting self-signed certificates)');
  }

  pool = new Pool(poolConfig);

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
  status?: EarmarkStatus;
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
    try {
      // Insert earmark
      const earmarkData: earmarks_insert = {
        ...camelToSnake(input),
        status: input.status || EarmarkStatus.PENDING,
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
    } catch (error: unknown) {
      // Add error handling for unique constraint violations
      const dbError = error as { code?: string; constraint?: string };
      if (dbError.code === '23505' && dbError.constraint === 'unique_active_earmark_per_invoice') {
        const enrichedError = new Error(`An active earmark already exists for invoice ${input.invoiceId}`) as Error & {
          code: string;
          constraint: string;
        };
        enrichedError.code = '23505';
        enrichedError.constraint = 'unique_active_earmark_per_invoice';
        throw enrichedError;
      }
      throw error;
    }
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

export async function getActiveEarmarkForInvoice(invoiceId: string): Promise<CamelCasedProperties<earmarks> | null> {
  const query = `
    SELECT * FROM earmarks
    WHERE "invoice_id" = $1
    AND status IN ('pending', 'ready')
  `;
  const result = await queryWithClient<earmarks>(query, [invoiceId]);

  if (result.length === 0) {
    return null;
  }

  if (result.length > 1) {
    throw new Error(`Multiple active earmarks found for invoice ${invoiceId}. Expected unique constraint violation.`);
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

export async function getEarmarksWithOperations(
  limit: number,
  offset: number,
  filter?: {
    status?: string;
    chainId?: number;
    invoiceId?: string;
  },
): Promise<
  Array<
    CamelCasedProperties<earmarks> & {
      operations?: Array<Record<string, string | number | Date | null>>;
    }
  >
> {
  let query = `
    SELECT e.*,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', ro.id,
                 'status', ro.status,
                 'origin_chain_id', ro.origin_chain_id,
                 'destination_chain_id', ro.destination_chain_id,
                 'ticker_hash', ro.ticker_hash,
                 'amount', ro.amount,
                 'slippage', ro.slippage,
                 'bridge', ro.bridge,
                 'recipient', ro.recipient,
                 'is_orphaned', ro.is_orphaned,
                 'created_at', ro.created_at,
                 'updated_at', ro.updated_at
               ) ORDER BY ro.created_at DESC
             ) FILTER (WHERE ro.id IS NOT NULL),
             '[]'::json
           ) as operations
    FROM earmarks e
    LEFT JOIN rebalance_operations ro ON e.id = ro.earmark_id
  `;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramCount = 1;

  if (filter) {
    if (filter.status) {
      conditions.push(`e.status = $${paramCount++}`);
      values.push(filter.status);
    }
    if (filter.chainId) {
      conditions.push(`e.designated_purchase_chain = $${paramCount++}`);
      values.push(filter.chainId);
    }
    if (filter.invoiceId) {
      conditions.push(`e.invoice_id = $${paramCount++}`);
      values.push(filter.invoiceId);
    }
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += `
    GROUP BY e.id
    ORDER BY e.created_at DESC
    LIMIT $${paramCount++} OFFSET $${paramCount}
  `;

  values.push(limit, offset);

  interface QueryResult extends earmarks {
    operations: Array<{
      id: string;
      status: string;
      origin_chain_id: number;
      destination_chain_id: number;
      ticker_hash: string;
      amount: string;
      slippage: number;
      bridge: string | null;
      recipient: string | null;
      created_at: Date;
      updated_at: Date;
    }>;
  }

  const results = await queryWithClient<QueryResult>(query, values);

  return results.map((row) => {
    const { operations, ...earmark } = row;
    return {
      ...snakeToCamel(earmark),
      operations: operations.map((op: Record<string, string | number | Date | null>) => snakeToCamel(op)),
    };
  });
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
  recipient?: string;
  transactions?: Record<string, TransactionReceipt>;
  operationType?: 'bridge' | 'swap_and_bridge';
}): Promise<CamelCasedProperties<rebalance_operations> & { transactions?: Record<string, TransactionEntry> }> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const rebalanceQuery = `
      INSERT INTO rebalance_operations (
        "earmark_id", "origin_chain_id", "destination_chain_id",
        "ticker_hash", amount, slippage, status, bridge, recipient, operation_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      input.recipient || null,
      input.operationType || 'bridge',
    ];

    const rebalanceResult = await client.query<rebalance_operations>(rebalanceQuery, rebalanceValues);
    const rebalanceOperation = rebalanceResult.rows[0];
    const transactions: CamelCasedProperties<transactions>[] = [];
    for (const [chainId, receipt] of Object.entries(input.transactions ?? {})) {
      const { transactionHash, cumulativeGasUsed, effectiveGasPrice, from, to } = receipt;
      const transactionQuery = `
        INSERT INTO transactions (
          rebalance_operation_id,
          transaction_hash,
          chain_id,
          "from",
          "to",
          cumulative_gas_used,
          effective_gas_price,
          reason,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `;

      const transactionValues = [
        rebalanceOperation.id,
        transactionHash,
        chainId,
        from,
        to,
        cumulativeGasUsed,
        effectiveGasPrice,
        TransactionReasons.Rebalance,
        JSON.stringify(serializeBigInt({ receipt })),
      ];

      const response = await client.query<transactions>(transactionQuery, transactionValues);
      const raw = response.rows[0];
      const meta = typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : (raw.metadata ?? {});
      const converted = snakeToCamel({ ...raw, metadata: meta }) as CamelCasedProperties<transactions>;
      transactions.push(converted);
    }

    await client.query('COMMIT');
    return {
      ...snakeToCamel(rebalanceOperation),
      transactions: transactions.length
        ? (Object.fromEntries(transactions.map((t) => [t.chainId, t])) as Record<string, TransactionEntry>)
        : undefined,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Helper function to fetch transactions for rebalance operations
export async function getTransactionsForRebalanceOperations(
  operationIds: string[],
  client?: PoolClient,
): Promise<Record<string, Record<string, TransactionEntry>>> {
  if (operationIds.length === 0) return {};

  const queryExecutor = client || getPool();
  const placeholders = operationIds.map((_, i) => `$${i + 1}`).join(', ');
  const transactionsQuery = `
    SELECT * FROM transactions
    WHERE rebalance_operation_id IN (${placeholders})
    ORDER BY created_at ASC
  `;

  const transactionsResult = await queryExecutor.query<transactions>(transactionsQuery, operationIds);
  const transactions = transactionsResult.rows.map((row) => {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {});
    return snakeToCamel({ ...row, metadata: meta }) as CamelCasedProperties<transactions>;
  });

  // Group transactions by rebalance operation ID, then by chain ID
  const transactionsByOperation: Record<string, Record<string, TransactionEntry>> = {};

  for (const transaction of transactions) {
    const { rebalanceOperationId, chainId, metadata } = transaction;
    if (!rebalanceOperationId) {
      continue;
    }

    if (!transactionsByOperation[rebalanceOperationId]) {
      transactionsByOperation[rebalanceOperationId] = {};
    }

    transactionsByOperation[rebalanceOperationId][chainId] = {
      ...transaction,
      metadata: JSON.parse(JSON.stringify(metadata)),
    };
  }

  return transactionsByOperation;
}

export async function updateRebalanceOperation(
  operationId: string,
  updates: {
    status?: RebalanceOperationStatus;
    txHashes?: Record<string, TransactionReceipt>;
    isOrphaned?: boolean;
  },
): Promise<CamelCasedProperties<rebalance_operations> & { transactions?: Record<string, TransactionEntry> }> {
  return withTransaction(async (client) => {
    // Update the rebalance operation status if provided
    const setClause: string[] = ['"updated_at" = NOW()'];
    const values: unknown[] = [];
    let paramCount = 1;

    if (updates.status !== undefined) {
      setClause.push(`status = $${paramCount++}`);
      values.push(updates.status);
    }

    if (updates.isOrphaned !== undefined) {
      setClause.push(`is_orphaned = $${paramCount++}`);
      values.push(updates.isOrphaned);
    }

    values.push(operationId);

    const query = `
      UPDATE rebalance_operations
      SET ${setClause.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await client.query<rebalance_operations>(query, values);

    if (result.rows.length === 0) {
      throw new Error(`Rebalance operation with id ${operationId} not found`);
    }

    const operation = snakeToCamel(result.rows[0]);

    if (!updates.txHashes) {
      return {
        ...operation,
        transactions: undefined,
      };
    }

    // Insert new transactions for this rebalance operation
    for (const [chainId, receipt] of Object.entries(updates.txHashes)) {
      // Validate required fields exist
      if (!receipt.transactionHash) {
        throw new Error(
          `Invalid receipt for chain ${chainId}: missing transactionHash. ` + `Receipt: ${JSON.stringify(receipt)}`,
        );
      }

      if (!receipt.from) {
        throw new Error(
          `Invalid receipt for chain ${chainId}, tx ${receipt.transactionHash}: missing 'from' address. ` +
            `Receipt: ${JSON.stringify(receipt)}`,
        );
      }

      if (!receipt.to) {
        throw new Error(
          `Invalid receipt for chain ${chainId}, tx ${receipt.transactionHash}: missing 'to' address. ` +
            `Receipt: ${JSON.stringify(receipt)}`,
        );
      }

      const transactionHash = receipt.transactionHash;
      const from = receipt.from;
      const to = receipt.to;

      // Gas values can default to '0' if missing
      const cumulativeGasUsed = String(receipt.cumulativeGasUsed || '0');
      const effectiveGasPrice = String(receipt.effectiveGasPrice || '0');

      const transactionQuery = `
          INSERT INTO transactions (
            rebalance_operation_id,
            transaction_hash,
            chain_id,
            "from",
            "to",
            cumulative_gas_used,
            effective_gas_price,
            reason,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;

      const transactionValues = [
        operationId,
        transactionHash,
        chainId,
        from,
        to,
        cumulativeGasUsed,
        effectiveGasPrice,
        TransactionReasons.Rebalance,
        JSON.stringify({
          receipt,
        }),
      ];

      await client.query(transactionQuery, transactionValues);
    }

    // Fetch transactions for this operation (normalize metadata inside helper)
    const transactionsByOperation = await getTransactionsForRebalanceOperations([operationId], client);

    return {
      ...operation,
      transactions: transactionsByOperation[operationId] || undefined,
    };
  });
}

export async function getRebalanceOperationsByEarmark(
  earmarkId: string,
): Promise<(CamelCasedProperties<rebalance_operations> & { transactions?: Record<string, TransactionEntry> })[]> {
  const query = `
    SELECT * FROM rebalance_operations
    WHERE "earmark_id" = $1
    ORDER BY "created_at" ASC
  `;
  const operations = await queryWithClient<rebalance_operations>(query, [earmarkId]);

  if (operations.length === 0) {
    return [];
  }

  // Fetch transactions for all operations
  const operationIds = operations.map((op) => op.id);
  const transactionsByOperation = await getTransactionsForRebalanceOperations(operationIds);

  return operations.map((op) => {
    const camelCasedOp = snakeToCamel(op);
    return {
      ...camelCasedOp,
      transactions: transactionsByOperation[op.id] || undefined,
    };
  });
}

export async function getRebalanceOperations(
  limit?: number,
  offset?: number,
  filter?: {
    status?: RebalanceOperationStatus | RebalanceOperationStatus[];
    chainId?: number;
    earmarkId?: string | null;
    invoiceId?: string;
  },
): Promise<{
  operations: (CamelCasedProperties<rebalance_operations> & { transactions?: Record<string, TransactionEntry> })[];
  total: number;
}> {
  const values: unknown[] = [];
  const conditions: string[] = [];
  let paramCount = 1;

  // Build WHERE conditions
  if (filter) {
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        conditions.push(`ro.status = ANY($${paramCount})`);
        values.push(filter.status);
      } else {
        conditions.push(`ro.status = $${paramCount}`);
        values.push(filter.status);
      }
      paramCount++;
    }

    if (filter.chainId !== undefined) {
      conditions.push(`ro."origin_chain_id" = $${paramCount}`);
      values.push(filter.chainId);
      paramCount++;
    }

    if (filter.earmarkId !== undefined) {
      if (filter.earmarkId === null) {
        conditions.push('ro."earmark_id" IS NULL');
      } else {
        conditions.push(`ro."earmark_id" = $${paramCount}`);
        values.push(filter.earmarkId);
        paramCount++;
      }
    }

    if (filter.invoiceId !== undefined) {
      conditions.push(`e."invoice_id" = $${paramCount}`);
      values.push(filter.invoiceId);
      paramCount++;
    }
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Get total count
  const needsJoin = filter?.invoiceId !== undefined;
  const countQuery = needsJoin
    ? `SELECT COUNT(*) FROM rebalance_operations ro LEFT JOIN earmarks e ON ro."earmark_id" = e.id ${whereClause}`
    : `SELECT COUNT(*) FROM rebalance_operations ro ${whereClause}`;

  const countResult = await queryWithClient<{ count: string }>(countQuery, values);
  const total = parseInt(countResult[0].count, 10);

  // Get operations with pagination
  const dataQuery = needsJoin
    ? `SELECT ro.* FROM rebalance_operations ro LEFT JOIN earmarks e ON ro."earmark_id" = e.id ${whereClause} ORDER BY ro."created_at" ASC`
    : `SELECT * FROM rebalance_operations ro ${whereClause} ORDER BY ro."created_at" ASC`;

  let finalQuery = dataQuery;
  if (limit !== undefined) {
    finalQuery += ` LIMIT $${paramCount++}`;
    values.push(limit);
  }
  if (offset !== undefined) {
    finalQuery += ` OFFSET $${paramCount}`;
    values.push(offset);
  }

  const operations = await queryWithClient<rebalance_operations>(finalQuery, values);

  if (operations.length === 0) {
    return { operations: [], total };
  }

  // Fetch transactions for all operations
  const operationIds = operations.map((op) => op.id);
  const transactionsByOperation = await getTransactionsForRebalanceOperations(operationIds);

  const operationsWithTransactions = operations.map((op) => {
    const camelCasedOp = snakeToCamel(op);
    return {
      ...camelCasedOp,
      transactions: transactionsByOperation[op.id] || undefined,
    };
  });

  return { operations: operationsWithTransactions, total };
}

export async function getRebalanceOperationByTransactionHash(
  hash: string,
  chainId: number,
): Promise<
  (CamelCasedProperties<rebalance_operations> & { transactions: Record<string, TransactionEntry> }) | undefined
> {
  // Find the transaction with the given hash (case-insensitive) and chain ID
  const txQuery = `
    SELECT * FROM transactions
    WHERE LOWER(transaction_hash) = LOWER($1) AND chain_id = $2
    LIMIT 1
  `;

  const txResult = await queryWithClient<transactions>(txQuery, [hash, String(chainId)]);

  if (txResult.length === 0) {
    return undefined;
  }

  const tx = txResult[0];

  // If the transaction isn't associated with a rebalance operation, nothing to return
  if (!tx.rebalance_operation_id) {
    return undefined;
  }

  // Fetch the rebalance operation
  const opQuery = `SELECT * FROM rebalance_operations WHERE id = $1 LIMIT 1`;
  const opResult = await queryWithClient<rebalance_operations>(opQuery, [tx.rebalance_operation_id]);

  if (opResult.length === 0) {
    return undefined;
  }

  // Fetch all transactions associated with this operation
  const transactionsByOperation = await getTransactionsForRebalanceOperations([tx.rebalance_operation_id]);
  const camelOp = snakeToCamel(opResult[0]);

  return {
    ...camelOp,
    transactions: transactionsByOperation[tx.rebalance_operation_id] || {},
  };
}

export async function getRebalanceOperationById(
  operationId: string,
): Promise<
  (CamelCasedProperties<rebalance_operations> & { transactions?: Record<string, TransactionEntry> }) | undefined
> {
  const opQuery = `SELECT * FROM rebalance_operations WHERE id = $1 LIMIT 1`;
  const opResult = await queryWithClient<rebalance_operations>(opQuery, [operationId]);

  if (opResult.length === 0) {
    return undefined;
  }

  const operation = opResult[0];

  // Fetch all transactions associated with this operation
  const transactionsByOperation = await getTransactionsForRebalanceOperations([operationId]);
  const camelOp = snakeToCamel(operation);

  return {
    ...camelOp,
    transactions: transactionsByOperation[operationId] || undefined,
  };
}

export type CexWithdrawalRecord<T extends object> = Omit<CamelCasedProperties<cex_withdrawals>, 'metadata'> & {
  metadata: T;
};
export async function createCexWithdrawalRecord<T extends object = JSONObject>(input: {
  rebalanceOperationId: string;
  platform: string;
  metadata: T;
}): Promise<CexWithdrawalRecord<T>> {
  return withTransaction(async (client) => {
    const query = `
      INSERT INTO cex_withdrawals (rebalance_operation_id, platform, metadata)
      VALUES ($1, $2, $3)
      RETURNING id, rebalance_operation_id, platform, metadata, created_at, updated_at
    `;
    const insertResult = await client.query(query, [
      input.rebalanceOperationId,
      input.platform,
      JSON.stringify(input.metadata),
    ]);
    const withdrawal = insertResult.rows[0] as cex_withdrawals;
    return { ...snakeToCamel(withdrawal), metadata: JSON.parse(JSON.stringify(withdrawal.metadata ?? {})) };
  });
}

export async function getCexWithdrawalRecord<T extends object = JSONObject>(input: {
  rebalanceOperationId: string;
  platform: string;
}): Promise<CexWithdrawalRecord<T> | undefined> {
  const query = `
    SELECT id, rebalance_operation_id, platform, metadata, created_at, updated_at
    FROM cex_withdrawals
    WHERE rebalance_operation_id = $1 AND platform = $2
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const rows = await queryWithClient<cex_withdrawals>(query, [input.rebalanceOperationId, input.platform]);
  if (rows.length === 0) {
    return undefined;
  }
  const row = rows[0];
  return { ...snakeToCamel(row), metadata: JSON.parse(JSON.stringify(row.metadata ?? {})) };
}

// Swap operations functions
export interface CreateSwapOperationParams {
  rebalanceOperationId: string;
  platform: string;
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  expectedRate: string;
  quoteId?: string;
  status: 'pending_deposit' | 'deposit_confirmed' | 'processing' | 'completed' | 'failed' | 'recovering';
  metadata?: Record<string, any>;
}

export async function createSwapOperation(params: CreateSwapOperationParams): Promise<any> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO swap_operations (
      rebalance_operation_id, platform, from_asset, to_asset,
      from_amount, to_amount, expected_rate, quote_id, status, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      params.rebalanceOperationId,
      params.platform,
      params.fromAsset,
      params.toAsset,
      params.fromAmount,
      params.toAmount,
      params.expectedRate,
      params.quoteId,
      params.status,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ],
  );
  return snakeToCamel(result.rows[0]);
}

export async function getSwapOperations(filters: {
  status?: string | string[];
  rebalanceOperationId?: string;
}): Promise<any[]> {
  const pool = getPool();
  const whereClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (filters.status) {
    if (Array.isArray(filters.status)) {
      whereClauses.push(`status = ANY($${paramIndex})`);
      values.push(filters.status);
    } else {
      whereClauses.push(`status = $${paramIndex}`);
      values.push(filters.status);
    }
    paramIndex++;
  }

  if (filters.rebalanceOperationId) {
    whereClauses.push(`rebalance_operation_id = $${paramIndex}`);
    values.push(filters.rebalanceOperationId);
    paramIndex++;
  }

  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const result = await pool.query(`SELECT * FROM swap_operations ${whereClause} ORDER BY created_at ASC`, values);
  return result.rows.map((row) => snakeToCamel(row));
}

export async function updateSwapOperationStatus(
  id: string,
  status: 'pending_deposit' | 'deposit_confirmed' | 'processing' | 'completed' | 'failed' | 'recovering',
  metadata?: Record<string, any>,
): Promise<void> {
  const pool = getPool();

  // Build update fields and values dynamically
  const updates: string[] = ['status = $2', 'updated_at = NOW()'];
  const values: any[] = [id, status];
  let paramIndex = 3;

  if (metadata) {
    updates.push(`metadata = $${paramIndex}`);
    values.push(JSON.stringify(metadata));
    paramIndex++;

    // Extract specific fields from metadata if provided
    if (metadata.orderId) {
      updates.push(`order_id = $${paramIndex}`);
      values.push(metadata.orderId);
      paramIndex++;
    }
    if (metadata.actualRate) {
      updates.push(`actual_rate = $${paramIndex}`);
      values.push(metadata.actualRate);
      paramIndex++;
    }
  }

  await pool.query(`UPDATE swap_operations SET ${updates.join(', ')} WHERE id = $1`, values);
}

export async function getSwapOperationByOrderId(orderId: string): Promise<any | undefined> {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM swap_operations WHERE order_id = $1', [orderId]);
  return result.rows[0] ? snakeToCamel(result.rows[0]) : undefined;
}

// Admin functions
export async function setPause(type: 'rebalance' | 'purchase' | 'ondemand', input: boolean): Promise<void> {
  // Read the latest admin_actions row and insert a new snapshot with the updated pause flag
  return withTransaction(async (client) => {
    const latestQuery = `
      SELECT rebalance_paused, purchase_paused, ondemand_rebalance_paused
      FROM admin_actions
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const latest = await client.query(latestQuery);

    // Defaults when no prior admin_actions exist
    let rebalancePaused = false;
    let purchasePaused = false;
    let ondemandRebalancePaused = false;

    if (latest.rows.length > 0) {
      rebalancePaused = Boolean(latest.rows[0].rebalance_paused);
      purchasePaused = Boolean(latest.rows[0].purchase_paused);
      ondemandRebalancePaused = Boolean(latest.rows[0].ondemand_rebalance_paused);
    }

    if (type === 'rebalance') {
      rebalancePaused = input;
    } else if (type === 'purchase') {
      purchasePaused = input;
    } else {
      ondemandRebalancePaused = input;
    }

    const insertQuery = `
      INSERT INTO admin_actions (rebalance_paused, purchase_paused, ondemand_rebalance_paused, description)
      VALUES ($1, $2, $3, $4)
    `;
    await client.query(insertQuery, [rebalancePaused, purchasePaused, ondemandRebalancePaused, null]);
  });
}

export async function isPaused(type: 'rebalance' | 'purchase' | 'ondemand'): Promise<boolean> {
  const column =
    type === 'rebalance' ? 'rebalance_paused' : type === 'purchase' ? 'purchase_paused' : 'ondemand_rebalance_paused';
  const query = `
    SELECT ${column} AS paused
    FROM admin_actions
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const rows = await queryWithClient<{ paused: boolean }>(query);
  if (rows.length === 0) {
    return false;
  }
  return Boolean((rows[0] as unknown as { paused: unknown }).paused);
}

// Type aliases for convenience
export type Earmark = CamelCasedProperties<earmarks>;
export type RebalanceOperation = CamelCasedProperties<rebalance_operations>;
export type Transaction = CamelCasedProperties<transactions>;

// Re-export types for convenience
export type {
  cex_withdrawals,
  earmarks,
  rebalance_operations,
  transactions,
  earmarks_insert,
  rebalance_operations_insert,
  transactions_insert,
  earmarks_update,
  rebalance_operations_update,
};
