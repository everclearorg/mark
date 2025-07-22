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
