/**
 * Utilities for traversing and manipulating nested JSON objects using dot-notation paths.
 *
 * Supports paths like:
 * - "simple.path"
 * - "array.0.field" (numeric indices)
 * - "array[0].field" (bracket notation)
 * - "deeply.nested.object.path"
 */

/**
 * Parse a path string into segments.
 * Handles both dot notation and bracket notation for arrays.
 *
 * @param path - Path string like "a.b.c" or "a[0].b"
 * @returns Array of path segments
 *
 * @example
 * parsePath("a.b.c") // ["a", "b", "c"]
 * parsePath("a[0].b") // ["a", "0", "b"]
 * parsePath("chains.1.privateKey") // ["chains", "1", "privateKey"]
 */
export function parsePath(path: string): string[] {
  if (!path || path.trim() === '') {
    return [];
  }

  // Convert bracket notation to dot notation: a[0].b -> a.0.b
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');

  // Split by dots and filter out empty segments
  return normalized.split('.').filter((segment) => segment !== '');
}

/**
 * Get a value from a nested object using dot notation path.
 *
 * @param obj - The object to traverse
 * @param path - Dot-notation path like "a.b.c" or "chains.1.privateKey"
 * @returns The value at the path, or undefined if not found
 *
 * @example
 * const obj = { a: { b: { c: 42 } } };
 * getValueByPath(obj, "a.b.c") // 42
 * getValueByPath(obj, "a.b.d") // undefined
 */
export function getValueByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) {
    return undefined;
  }

  const segments = parsePath(path);
  if (segments.length === 0) {
    return obj;
  }

  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Set a value in a nested object using dot notation path.
 * Creates intermediate objects/arrays as needed.
 *
 * @param obj - The object to modify (mutates in place)
 * @param path - Dot-notation path like "a.b.c"
 * @param value - The value to set
 *
 * @example
 * const obj = { a: { b: {} } };
 * setValueByPath(obj, "a.b.c", 42);
 * // obj is now { a: { b: { c: 42 } } }
 */
export function setValueByPath(obj: unknown, path: string, value: unknown): void {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    throw new Error('Cannot set value on non-object');
  }

  const segments = parsePath(path);
  if (segments.length === 0) {
    throw new Error('Cannot set value with empty path');
  }

  let current = obj as Record<string, unknown>;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];

    // Determine if next level should be an array or object
    const isNextArray = /^\d+$/.test(nextSegment);

    if (current[segment] === undefined || current[segment] === null) {
      current[segment] = isNextArray ? [] : {};
    }

    const next = current[segment];
    if (typeof next !== 'object' || next === null) {
      // Can't traverse further - create new structure
      current[segment] = isNextArray ? [] : {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  const lastSegment = segments[segments.length - 1];
  current[lastSegment] = value;
}

/**
 * Delete a value from a nested object using dot notation path.
 *
 * @param obj - The object to modify (mutates in place)
 * @param path - Dot-notation path to the value to delete
 * @returns true if the value was deleted, false if it didn't exist
 */
export function deleteValueByPath(obj: unknown, path: string): boolean {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return false;
  }

  const segments = parsePath(path);
  if (segments.length === 0) {
    return false;
  }

  let current = obj as Record<string, unknown>;

  // Navigate to the parent of the target
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = current[segment];

    if (next === undefined || next === null || typeof next !== 'object') {
      return false; // Path doesn't exist
    }

    current = next as Record<string, unknown>;
  }

  const lastSegment = segments[segments.length - 1];

  if (lastSegment in current) {
    delete current[lastSegment];
    return true;
  }

  return false;
}

/**
 * Check if a path exists in a nested object.
 *
 * @param obj - The object to check
 * @param path - Dot-notation path
 * @returns true if the path exists (even if value is null/undefined)
 */
export function hasPath(obj: unknown, path: string): boolean {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return false;
  }

  const segments = parsePath(path);
  if (segments.length === 0) {
    return true;
  }

  let current = obj as Record<string, unknown>;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (!(segment in current)) {
      return false;
    }

    if (i < segments.length - 1) {
      const next = current[segment];
      if (next === null || typeof next !== 'object') {
        return false;
      }
      current = next as Record<string, unknown>;
    }
  }

  return true;
}

/**
 * Get all paths in an object that match a pattern.
 * Useful for finding all fields that need sharding.
 *
 * @param obj - The object to search
 * @param pattern - RegExp pattern to match against full paths
 * @returns Array of matching paths
 *
 * @example
 * const obj = { chains: { "1": { privateKey: "..." }, "2": { privateKey: "..." } } };
 * findPaths(obj, /privateKey$/);
 * // ["chains.1.privateKey", "chains.2.privateKey"]
 */
export function findPaths(obj: unknown, pattern: RegExp): string[] {
  const results: string[] = [];

  function traverse(current: unknown, currentPath: string) {
    if (current === null || current === undefined) {
      return;
    }

    if (typeof current !== 'object') {
      // Leaf node - check if path matches
      if (pattern.test(currentPath)) {
        results.push(currentPath);
      }
      return;
    }

    // Check if current path matches (for object-valued fields)
    if (currentPath && pattern.test(currentPath)) {
      results.push(currentPath);
    }

    // Recurse into object
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      traverse(value, nextPath);
    }
  }

  traverse(obj, '');
  return results;
}
