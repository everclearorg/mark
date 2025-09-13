import { serializeBigInt } from '@mark/core';
import { CamelCasedProperties, SnakeCasedProperties, TransactionReceipt } from './types';

/**
 * Converts snake-cased object keys to camel-cased in nested objects.
 * i.e.: { input_a: { key_b: 'value' } } -> { inputA: { keyB: 'value' } }
 * @param input Camel-cased input object to cast to snake
 */
export const snakeToCamel = <T extends object>(input: T): CamelCasedProperties<T> => {
  if (input === null || input === undefined) {
    return input as unknown as CamelCasedProperties<T>;
  }

  if (Array.isArray(input)) {
    return input.map((item) =>
      typeof item === 'object' && item !== null ? snakeToCamel(item) : item,
    ) as unknown as CamelCasedProperties<T>;
  }

  if (typeof input !== 'object') {
    return input as unknown as CamelCasedProperties<T>;
  }

  const result: Record<string, unknown> = {};

  for (const key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = (input as Record<string, unknown>)[key];

      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        result[camelKey] = Array.isArray(value)
          ? value.map((item) => (typeof item === 'object' && item !== null ? snakeToCamel(item) : item))
          : snakeToCamel(value as object);
      } else {
        result[camelKey] = value;
      }
    }
  }

  return result as CamelCasedProperties<T>;
};

/**
 * Converts camel-cased object keys to snake-cased in nested objects.
 * i.e.: { inputA: { keyB: 'value' } } -> { input_a: { key_b: 'value' } }
 * @param input Camel-cased input object to cast to snake
 */
export const camelToSnake = <T extends object>(input: T): SnakeCasedProperties<T> => {
  if (input === null || input === undefined) {
    return input as unknown as SnakeCasedProperties<T>;
  }

  if (Array.isArray(input)) {
    return input.map((item) =>
      typeof item === 'object' && item !== null ? camelToSnake(item) : item,
    ) as unknown as SnakeCasedProperties<T>;
  }

  if (typeof input !== 'object') {
    return input as unknown as SnakeCasedProperties<T>;
  }

  const result: Record<string, unknown> = {};

  for (const key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, '');
      const value = (input as Record<string, unknown>)[key];

      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        result[snakeKey] = Array.isArray(value)
          ? value.map((item) => (typeof item === 'object' && item !== null ? camelToSnake(item) : item))
          : camelToSnake(value as object);
      } else {
        result[snakeKey] = value;
      }
    }
  }

  return result as SnakeCasedProperties<T>;
};

/**
 * Normalizes a transaction receipt from any source (Viem, Tron, etc.)
 * Handles BigInt conversions, null fields, and ensures consistent structure for database storage
 *
 * @param receipt - Raw receipt that may contain:
 *   - BigInt values for gas fields
 *   - null/undefined for optional fields
 *   - status as 'success'/'failed' or 1/0
 *   - gasPrice as fallback for effectiveGasPrice
 */
export function normalizeReceipt(receipt: unknown): TransactionReceipt {
  // First serialize BigInt values to handle nested BigInts
  const serialized = serializeBigInt(receipt) as Record<string, unknown>;

  // Validate required fields
  if (!serialized.transactionHash || typeof serialized.transactionHash !== 'string') {
    throw new Error(
      `Cannot normalize receipt: missing or invalid transactionHash. ` +
        `Receipt: ${JSON.stringify(serialized).slice(0, 500)}`,
    );
  }

  if (!serialized.from || typeof serialized.from !== 'string') {
    throw new Error(
      `Cannot normalize receipt for tx ${serialized.transactionHash}: missing or invalid 'from' address. ` +
        `Receipt: ${JSON.stringify(serialized).slice(0, 500)}`,
    );
  }

  // Database expects logs as unknown[]
  const logs = Array.isArray(serialized.logs) ? serialized.logs : [];

  return {
    transactionHash: serialized.transactionHash,
    from: serialized.from,
    to: typeof serialized.to === 'string' ? serialized.to : '', // Handle contract creation (null to field)
    cumulativeGasUsed: String(serialized.cumulativeGasUsed || '0'),
    effectiveGasPrice: String(serialized.effectiveGasPrice || serialized.gasPrice || '0'),
    blockNumber: Number(serialized.blockNumber || 0),
    status: serialized.status === 'success' || serialized.status === 1 ? 1 : undefined,
    logs: logs,
    confirmations: typeof serialized.confirmations === 'number' ? serialized.confirmations : undefined,
  };
}

/**
 * Type guard to check if an object is a TransactionReceipt
 */
export function isNormalizedReceipt(obj: unknown): obj is TransactionReceipt {
  if (!obj || typeof obj !== 'object') return false;

  const receipt = obj as Record<string, unknown>;
  return (
    typeof receipt.transactionHash === 'string' &&
    typeof receipt.from === 'string' &&
    typeof receipt.to === 'string' &&
    typeof receipt.cumulativeGasUsed === 'string' &&
    typeof receipt.effectiveGasPrice === 'string' &&
    typeof receipt.blockNumber === 'number' &&
    typeof receipt.status === 'number' &&
    Array.isArray(receipt.logs)
  );
}
