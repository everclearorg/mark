import { CamelCasedProperties, SnakeCasedProperties } from './types';

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
