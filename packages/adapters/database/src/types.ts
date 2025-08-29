// Database type definitions

import { earmarks, transactions } from './db';

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

// TODO: improve type source, should be whats returned from `submitAndMonitor`
export interface TransactionReceipt {
  from: string;
  to: string;
  cumulativeGasUsed: string;
  effectiveGasPrice: string;
  blockNumber: number;
  status?: number;
  transactionHash: string;
  logs: unknown[];
  confirmations: number | undefined;
}

export type TransactionEntry<T = object> = Omit<CamelCasedProperties<transactions>, 'metadata'> & {
  metadata: T;
};

export enum TransactionReasons {
  Rebalance = 'Rebalance',
}

////////////////////////////////////////////
///// Camel / snake case helper types /////
///////////////////////////////////////////

// Utility type to convert camelCase -> snake_case
type SnakeCase<S extends string> = S extends `${infer T}${infer U}`
  ? U extends Uncapitalize<U>
    ? `${Lowercase<T>}${SnakeCase<U>}`
    : `${Lowercase<T>}_${SnakeCase<Uncapitalize<U>>}`
  : S;

// Recursively map object keys to snake_case
export type SnakeCasedProperties<T> = {
  [K in keyof T as SnakeCase<string & K>]: T[K] extends object ? SnakeCasedProperties<T[K]> : T[K];
};

// Utility type to convert snake_case -> camelCase
type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}${infer Rest}`
  ? `${Head}${Uppercase<Tail>}${CamelCase<Rest>}`
  : S;

// Map object keys to camelCase
export type CamelCasedProperties<T> = {
  [K in keyof T as CamelCase<string & K>]: T[K] extends object ? CamelCasedProperties<T[K]> : T[K];
};

export type DatabaseEarmarks = CamelCasedProperties<earmarks>;
