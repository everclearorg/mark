/**
 * Unit tests for shamir.ts
 * 
 * Tests Shamir's Secret Sharing implementation.
 */

import {
  shamirSplit,
  shamirSplitPair,
  shamirReconstruct,
  shamirReconstructPair,
  parseShare,
  formatShare,
  isValidShare,
  verifyShares,
  generateRandomHex,
} from '../../src/shard/shamir';
import { ShardError, ShardErrorCode } from '../../src/shard/types';

describe('shamir', () => {
  describe('shamirSplit', () => {
    it('should generate 2 shares for a simple secret', () => {
      const secret = 'my-secret-key';
      const shares = shamirSplit(secret);

      expect(shares).toHaveLength(2);
      expect(isValidShare(shares[0])).toBe(true);
      expect(isValidShare(shares[1])).toBe(true);
    });

    it('should generate different shares each time (randomness)', () => {
      const secret = 'test-secret';
      const shares1 = shamirSplit(secret);
      const shares2 = shamirSplit(secret);

      // Shares should be different due to random polynomial coefficient
      expect(shares1[0]).not.toBe(shares2[0]);
      expect(shares1[1]).not.toBe(shares2[1]);
    });

    it('should handle long secrets (private keys)', () => {
      // 64-character hex string (256-bit key)
      const secret = '0x' + 'a'.repeat(64);
      const shares = shamirSplit(secret);

      expect(shares).toHaveLength(2);

      // Verify reconstruction works
      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });

    it('should handle unicode and special characters', () => {
      const secret = 'パスワード 🔐 special chars: !@#$%^&*()';
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });

    it('should handle very short secrets', () => {
      const secret = 'a';
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });

    it('should handle multiline secrets', () => {
      const secret = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7
-----END PRIVATE KEY-----`;

      const shares = shamirSplit(secret);
      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });

    it('should throw for empty secret', () => {
      expect(() => shamirSplit('')).toThrow(ShardError);
    });

    it('should throw if threshold exceeds shares', () => {
      expect(() => shamirSplit('secret', { numShares: 2, threshold: 3 })).toThrow(ShardError);
    });

    it('should throw if threshold is less than 2', () => {
      expect(() => shamirSplit('secret', { threshold: 1 })).toThrow(ShardError);
    });

    describe('padding', () => {
      it('should pad short secrets to fixed length', () => {
        const shortSecret = 'abc';
        const shares = shamirSplit(shortSecret, { padLength: 64 });

        // Shares should be longer than without padding
        const unpaddedShares = shamirSplit(shortSecret);
        expect(shares[0].length).toBeGreaterThan(unpaddedShares[0].length);

        // Reconstruction should still work and return original secret
        const reconstructed = shamirReconstruct(shares);
        expect(reconstructed).toBe(shortSecret);
      });

      it('should not pad secrets longer than padLength', () => {
        const longSecret = 'a'.repeat(100);
        const shares = shamirSplit(longSecret, { padLength: 32 });

        // Shares should be same length as without padding config
        const unpaddedShares = shamirSplit(longSecret);
        expect(shares[0].length).toBe(unpaddedShares[0].length);

        // Reconstruction should work
        const reconstructed = shamirReconstruct(shares);
        expect(reconstructed).toBe(longSecret);
      });

      it('should correctly unpad during reconstruction', () => {
        const secret = 'short';
        const shares = shamirSplit(secret, { padLength: 128 });

        // Verify the marker is present by checking share length increased
        const unpaddedShares = shamirSplit(secret);
        expect(shares[0].length).toBeGreaterThan(unpaddedShares[0].length);

        // Most importantly - reconstruction must return exact original
        const reconstructed = shamirReconstruct(shares);
        expect(reconstructed).toBe(secret);
        expect(reconstructed.length).toBe(secret.length);
      });

      it('should handle padLength that equals secret hex length', () => {
        const secret = 'test1234'; // 8 chars = 16 hex chars
        const shares = shamirSplit(secret, { padLength: 8 }); // 8 bytes = 16 hex chars

        const reconstructed = shamirReconstruct(shares);
        expect(reconstructed).toBe(secret);
      });
    });
  });

  describe('shamirSplitPair', () => {
    it('should return an object with share1 and share2', () => {
      const secret = 'my-secret';
      const result = shamirSplitPair(secret);

      expect(result).toHaveProperty('share1');
      expect(result).toHaveProperty('share2');
      expect(isValidShare(result.share1)).toBe(true);
      expect(isValidShare(result.share2)).toBe(true);
    });
  });

  describe('shamirReconstruct', () => {
    it('should reconstruct secret from 2 shares', () => {
      const secret = 'my-sensitive-private-key';
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);

      expect(reconstructed).toBe(secret);
    });

    it('should fail with only 1 share', () => {
      const shares = shamirSplit('secret');

      expect(() => shamirReconstruct([shares[0]])).toThrow(ShardError);
    });

    it('should fail with duplicate shares (same index)', () => {
      const shares = shamirSplit('secret');

      expect(() => shamirReconstruct([shares[0], shares[0]])).toThrow(ShardError);
    });

    it('should fail when shares have different data lengths', () => {
      const shares1 = shamirSplit('short');
      const shares2 = shamirSplit('a-much-longer-secret-string');

      // Try to combine shares from different secrets
      expect(() => shamirReconstruct([shares1[0], shares2[1]])).toThrow(ShardError);
      expect(() => shamirReconstruct([shares1[0], shares2[1]])).toThrow(/same data length/);
    });

    it('should work with shares in any order', () => {
      const secret = 'order-test';
      const shares = shamirSplit(secret);

      const reconstructed1 = shamirReconstruct([shares[0], shares[1]]);
      const reconstructed2 = shamirReconstruct([shares[1], shares[0]]);

      expect(reconstructed1).toBe(secret);
      expect(reconstructed2).toBe(secret);
    });

    it('should fail with empty array', () => {
      expect(() => shamirReconstruct([])).toThrow(ShardError);
    });

    it('should fail with invalid share format', () => {
      expect(() => shamirReconstruct(['invalid', '1-abc'])).toThrow(ShardError);
    });
  });

  describe('shamirReconstructPair', () => {
    it('should reconstruct from exactly two shares', () => {
      const secret = 'pair-test';
      const { share1, share2 } = shamirSplitPair(secret);

      const reconstructed = shamirReconstructPair(share1, share2);

      expect(reconstructed).toBe(secret);
    });
  });

  describe('parseShare', () => {
    it('should parse valid share format (native secrets.js format)', () => {
      // Generate a real share to test with
      const { share1 } = shamirSplitPair('test');
      const parsed = parseShare(share1);

      expect(parsed.index).toBe(1);
      expect(parsed.data).toBeTruthy();
      expect(parsed.data.length).toBeGreaterThan(0);
    });

    it('should parse shares with different indices', () => {
      const { share1, share2 } = shamirSplitPair('test');
      const parsed1 = parseShare(share1);
      const parsed2 = parseShare(share2);

      expect(parsed1.index).toBe(1);
      expect(parsed2.index).toBe(2);
    });

    it('should throw for empty string', () => {
      expect(() => parseShare('')).toThrow(ShardError);
    });

    it('should throw for too short string', () => {
      expect(() => parseShare('abc')).toThrow(ShardError);
    });

    it('should throw for invalid hex', () => {
      expect(() => parseShare('xyz123')).toThrow(ShardError);
    });
  });

  describe('formatShare', () => {
    it('should format share object to native format', () => {
      const share = { index: 1, data: 'abcdef' };
      const formatted = formatShare(share);
      // Format: bits(1) + id(2) + data
      expect(formatted).toBe('801abcdef');
    });

    it('should format hex indices correctly', () => {
      const share = { index: 15, data: 'abc' };
      const formatted = formatShare(share);
      expect(formatted).toBe('80fabc');
    });

    it('should produce valid shares that can be parsed', () => {
      const { share1 } = shamirSplitPair('roundtrip');
      const parsed = parseShare(share1);
      const formatted = formatShare(parsed);
      
      // The formatted version should be parseable
      const reparsed = parseShare(formatted);
      expect(reparsed.index).toBe(parsed.index);
      expect(reparsed.data).toBe(parsed.data);
    });
  });

  describe('isValidShare', () => {
    it('should return true for valid shares', () => {
      const { share1, share2 } = shamirSplitPair('test');
      expect(isValidShare(share1)).toBe(true);
      expect(isValidShare(share2)).toBe(true);
    });

    it('should return false for invalid shares', () => {
      expect(isValidShare('')).toBe(false);
      expect(isValidShare('xyz')).toBe(false);
      expect(isValidShare('ab')).toBe(false); // too short
    });
  });

  describe('verifyShares', () => {
    it('should return true when shares reconstruct correctly', () => {
      const secret = 'verify-test';
      const { share1, share2 } = shamirSplitPair(secret);

      expect(verifyShares(secret, share1, share2)).toBe(true);
    });

    it('should return false when secret does not match', () => {
      const { share1, share2 } = shamirSplitPair('original');

      expect(verifyShares('different', share1, share2)).toBe(false);
    });

    it('should return false for invalid shares', () => {
      expect(verifyShares('secret', 'invalid', '1-abc')).toBe(false);
    });
  });

  describe('generateRandomHex', () => {
    it('should generate hex string of correct length', () => {
      const hex = generateRandomHex(16);
      expect(hex).toMatch(/^[0-9a-f]+$/);
      expect(hex.length).toBe(32); // 16 bytes = 32 hex chars
    });

    it('should generate different values each time', () => {
      const hex1 = generateRandomHex(32);
      const hex2 = generateRandomHex(32);

      expect(hex1).not.toBe(hex2);
    });
  });

  describe('Security Properties', () => {
    it('should produce shares with high entropy', () => {
      const secret = 'a'.repeat(32);
      const shares = shamirSplit(secret);

      // Each share should look random (high character diversity)
      const share1Data = parseShare(shares[0]).data;
      const uniqueChars = new Set(share1Data.split(''));

      // Good randomness should use many hex characters
      expect(uniqueChars.size).toBeGreaterThan(8);
    });

    it('should not leak secret prefix in shares', () => {
      const secret = 'PREFIX_secret_data_here';
      const shares = shamirSplit(secret);

      // Share data should not contain readable prefix
      shares.forEach((share) => {
        const hexData = parseShare(share).data.toLowerCase();
        // "PREFIX" in hex would be "505245464958"
        expect(hexData).not.toContain('505245464958');
      });
    });

    it('should handle secrets with leading/trailing whitespace', () => {
      const secret = '  secret with spaces  ';
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });

    it('should handle secrets with null bytes', () => {
      const secret = 'before\x00after';
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });
  });

  describe('Edge Cases', () => {
    it('should handle secrets that look like shares', () => {
      // A secret that looks like a share format
      const secret = '1-abcdef123456';
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });

    it('should handle JSON secrets', () => {
      const secret = JSON.stringify({ key: 'value', nested: { array: [1, 2, 3] } });
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);
      expect(JSON.parse(reconstructed)).toEqual(JSON.parse(secret));
    });

    it('should handle base64 encoded secrets', () => {
      const secret = Buffer.from('binary data here').toString('base64');
      const shares = shamirSplit(secret);

      const reconstructed = shamirReconstruct(shares);
      expect(reconstructed).toBe(secret);
    });
  });
});
