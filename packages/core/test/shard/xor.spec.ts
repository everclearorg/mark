/**
 * Unit tests for xor.ts
 * 
 * Tests XOR-based secret splitting as alternative to Shamir.
 */

import {
  xorSplit,
  xorReconstruct,
  xorVerify,
  isValidBase64,
} from '../../src/shard/xor';
import { ShardError, ShardErrorCode } from '../../src/shard/types';

describe('xor', () => {
  describe('xorSplit', () => {
    it('should split a secret into two base64 shards', () => {
      const secret = 'my-secret-key';
      const result = xorSplit(secret);

      expect(result).toHaveProperty('share1');
      expect(result).toHaveProperty('share2');
      expect(isValidBase64(result.share1)).toBe(true);
      expect(isValidBase64(result.share2)).toBe(true);
    });

    it('should generate different shards each time (random)', () => {
      const secret = 'test-secret';
      const result1 = xorSplit(secret);
      const result2 = xorSplit(secret);

      expect(result1.share1).not.toBe(result2.share1);
      expect(result1.share2).not.toBe(result2.share2);
    });

    it('should throw for empty secret', () => {
      expect(() => xorSplit('')).toThrow(ShardError);
    });
  });

  describe('xorReconstruct', () => {
    it('should reconstruct secret from two shards', () => {
      const secret = 'my-secret-key';
      const { share1, share2 } = xorSplit(secret);

      const reconstructed = xorReconstruct(share1, share2);

      expect(reconstructed).toBe(secret);
    });

    it('should handle unicode and special characters', () => {
      const secret = 'パスワード 🔐 special!';
      const { share1, share2 } = xorSplit(secret);

      const reconstructed = xorReconstruct(share1, share2);
      expect(reconstructed).toBe(secret);
    });

    it('should handle long secrets', () => {
      const secret = '0x' + 'a'.repeat(64);
      const { share1, share2 } = xorSplit(secret);

      const reconstructed = xorReconstruct(share1, share2);
      expect(reconstructed).toBe(secret);
    });

    it('should throw for missing shards', () => {
      expect(() => xorReconstruct('', 'valid')).toThrow(ShardError);
      expect(() => xorReconstruct('valid', '')).toThrow(ShardError);
    });

    it('should throw for length mismatch', () => {
      const { share1 } = xorSplit('short');
      const { share2 } = xorSplit('much longer secret');

      expect(() => xorReconstruct(share1, share2)).toThrow(ShardError);
    });

    it('should throw for invalid base64', () => {
      expect(() => xorReconstruct('not-valid-base64!!!', 'abc=')).toThrow(ShardError);
    });
  });

  describe('xorVerify', () => {
    it('should return true for matching reconstruction', () => {
      const secret = 'test';
      const { share1, share2 } = xorSplit(secret);

      expect(xorVerify(secret, share1, share2)).toBe(true);
    });

    it('should return false for wrong secret', () => {
      const { share1, share2 } = xorSplit('original');

      expect(xorVerify('different', share1, share2)).toBe(false);
    });

    it('should return false for invalid shards', () => {
      expect(xorVerify('secret', 'invalid', 'shards')).toBe(false);
    });
  });

  describe('isValidBase64', () => {
    it('should return true for valid base64', () => {
      expect(isValidBase64('YWJj')).toBe(true);
      expect(isValidBase64('YWJjZA==')).toBe(true);
      expect(isValidBase64('YWJjZGU=')).toBe(true);
    });

    it('should return false for invalid base64', () => {
      expect(isValidBase64('')).toBe(false);
      expect(isValidBase64('not valid!')).toBe(false);
    });

    it('should return false for non-strings', () => {
      expect(isValidBase64(null as unknown as string)).toBe(false);
      expect(isValidBase64(undefined as unknown as string)).toBe(false);
    });
  });

  describe('Security Properties', () => {
    it('should produce shards that look random', () => {
      const secret = 'a'.repeat(100);
      const { share1, share2 } = xorSplit(secret);

      // Decode and check entropy
      const shard1Bytes = Buffer.from(share1, 'base64');
      const uniqueBytes = new Set(Array.from(shard1Bytes));

      // Random bytes should have high diversity
      expect(uniqueBytes.size).toBeGreaterThan(10);
    });

    it('should not leak secret content in shards', () => {
      const secret = 'SECRET_CONTENT';
      const { share1, share2 } = xorSplit(secret);

      // Shards should not contain the secret as plaintext
      expect(share1).not.toContain(secret);
      expect(share2).not.toContain(secret);
    });
  });
});
