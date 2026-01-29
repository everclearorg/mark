/**
 * Unit tests for path-utils.ts
 * 
 * Tests JSON path parsing and traversal functionality.
 */

import {
  parsePath,
  getValueByPath,
  setValueByPath,
  deleteValueByPath,
  hasPath,
  findPaths,
} from '../../src/shard/path-utils';

describe('path-utils', () => {
  describe('parsePath', () => {
    it('should parse simple dot-notation paths', () => {
      expect(parsePath('a.b.c')).toEqual(['a', 'b', 'c']);
      expect(parsePath('single')).toEqual(['single']);
      expect(parsePath('two.parts')).toEqual(['two', 'parts']);
    });

    it('should parse numeric indices', () => {
      expect(parsePath('array.0.field')).toEqual(['array', '0', 'field']);
      expect(parsePath('data.1.2.3')).toEqual(['data', '1', '2', '3']);
    });

    it('should handle bracket notation', () => {
      expect(parsePath('array[0].field')).toEqual(['array', '0', 'field']);
      expect(parsePath('data[1][2].value')).toEqual(['data', '1', '2', 'value']);
    });

    it('should handle empty and whitespace paths', () => {
      expect(parsePath('')).toEqual([]);
      expect(parsePath('   ')).toEqual([]);
    });

    it('should filter out empty segments', () => {
      expect(parsePath('a..b')).toEqual(['a', 'b']);
      expect(parsePath('.a.b.')).toEqual(['a', 'b']);
    });
  });

  describe('getValueByPath', () => {
    const testObj = {
      simple: 'value',
      nested: {
        deep: {
          value: 42,
        },
      },
      array: [
        { id: 1, name: 'first' },
        { id: 2, name: 'second' },
      ],
      chains: {
        '1': { privateKey: 'key1' },
        '42': { privateKey: 'key42' },
      },
    };

    it('should get simple values', () => {
      expect(getValueByPath(testObj, 'simple')).toBe('value');
    });

    it('should get nested values', () => {
      expect(getValueByPath(testObj, 'nested.deep.value')).toBe(42);
    });

    it('should get array elements', () => {
      expect(getValueByPath(testObj, 'array.0.name')).toBe('first');
      expect(getValueByPath(testObj, 'array.1.id')).toBe(2);
    });

    it('should get numeric object keys', () => {
      expect(getValueByPath(testObj, 'chains.1.privateKey')).toBe('key1');
      expect(getValueByPath(testObj, 'chains.42.privateKey')).toBe('key42');
    });

    it('should return undefined for non-existent paths', () => {
      expect(getValueByPath(testObj, 'nonexistent')).toBeUndefined();
      expect(getValueByPath(testObj, 'nested.nonexistent.path')).toBeUndefined();
      expect(getValueByPath(testObj, 'array.99.name')).toBeUndefined();
    });

    it('should handle null and undefined inputs', () => {
      expect(getValueByPath(null, 'any.path')).toBeUndefined();
      expect(getValueByPath(undefined, 'any.path')).toBeUndefined();
    });

    it('should return the object itself for empty path', () => {
      expect(getValueByPath(testObj, '')).toBe(testObj);
    });
  });

  describe('setValueByPath', () => {
    it('should set simple values', () => {
      const obj = { existing: 'old' };
      setValueByPath(obj, 'existing', 'new');
      expect(obj.existing).toBe('new');
    });

    it('should create nested structures', () => {
      const obj: Record<string, unknown> = {};
      setValueByPath(obj, 'a.b.c', 'value');
      expect((obj as { a: { b: { c: string } } }).a.b.c).toBe('value');
    });

    it('should create array structures for numeric keys', () => {
      const obj: Record<string, unknown> = {};
      setValueByPath(obj, 'items.0.name', 'first');
      expect(Array.isArray((obj as { items: unknown[] }).items)).toBe(true);
    });

    it('should update existing nested values', () => {
      const obj = {
        chains: {
          '1': { privateKey: 'old' },
        },
      };
      setValueByPath(obj, 'chains.1.privateKey', 'new');
      expect(obj.chains['1'].privateKey).toBe('new');
    });

    it('should throw for null/undefined objects', () => {
      expect(() => setValueByPath(null, 'path', 'value')).toThrow();
      expect(() => setValueByPath(undefined, 'path', 'value')).toThrow();
    });

    it('should throw for empty path', () => {
      expect(() => setValueByPath({}, '', 'value')).toThrow();
    });
  });

  describe('deleteValueByPath', () => {
    it('should delete simple values', () => {
      const obj = { a: 1, b: 2 };
      const result = deleteValueByPath(obj, 'a');
      expect(result).toBe(true);
      expect('a' in obj).toBe(false);
      expect(obj.b).toBe(2);
    });

    it('should delete nested values', () => {
      const obj = { nested: { deep: { value: 42, other: 'keep' } } };
      const result = deleteValueByPath(obj, 'nested.deep.value');
      expect(result).toBe(true);
      expect('value' in obj.nested.deep).toBe(false);
      expect(obj.nested.deep.other).toBe('keep');
    });

    it('should return false for non-existent paths', () => {
      const obj = { a: 1 };
      expect(deleteValueByPath(obj, 'nonexistent')).toBe(false);
      expect(deleteValueByPath(obj, 'a.b.c')).toBe(false);
    });

    it('should return false for null/undefined objects', () => {
      expect(deleteValueByPath(null, 'path')).toBe(false);
      expect(deleteValueByPath(undefined, 'path')).toBe(false);
    });
  });

  describe('hasPath', () => {
    const obj = {
      a: {
        b: {
          c: null,
        },
      },
      empty: undefined,
    };

    it('should return true for existing paths', () => {
      expect(hasPath(obj, 'a')).toBe(true);
      expect(hasPath(obj, 'a.b')).toBe(true);
      expect(hasPath(obj, 'a.b.c')).toBe(true);
    });

    it('should return true for paths with null values', () => {
      expect(hasPath(obj, 'a.b.c')).toBe(true);
    });

    it('should return true for paths with undefined values', () => {
      expect(hasPath(obj, 'empty')).toBe(true);
    });

    it('should return false for non-existent paths', () => {
      expect(hasPath(obj, 'nonexistent')).toBe(false);
      expect(hasPath(obj, 'a.nonexistent')).toBe(false);
      expect(hasPath(obj, 'a.b.c.d')).toBe(false);
    });

    it('should return false for null/undefined objects', () => {
      expect(hasPath(null, 'path')).toBe(false);
      expect(hasPath(undefined, 'path')).toBe(false);
    });
  });

  describe('findPaths', () => {
    const obj = {
      chains: {
        '1': { privateKey: 'key1', address: 'addr1' },
        '2': { privateKey: 'key2', address: 'addr2' },
      },
      solana: {
        privateKey: 'solana-key',
      },
      publicData: 'not-a-key',
    };

    it('should find paths matching pattern', () => {
      const result = findPaths(obj, /privateKey$/);
      expect(result).toContain('chains.1.privateKey');
      expect(result).toContain('chains.2.privateKey');
      expect(result).toContain('solana.privateKey');
      expect(result).not.toContain('chains.1.address');
    });

    it('should return empty array for no matches', () => {
      const result = findPaths(obj, /nonexistent/);
      expect(result).toEqual([]);
    });

    it('should handle empty objects', () => {
      expect(findPaths({}, /anything/)).toEqual([]);
    });
  });
});
