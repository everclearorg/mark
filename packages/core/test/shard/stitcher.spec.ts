/**
 * Integration tests for stitcher.ts
 * 
 * Tests the main orchestration logic for reconstructing sharded configs.
 */

import {
  stitchConfig,
  loadManifest,
  hasShardedFields,
  createEmptyManifest,
  createSingleFieldManifest,
} from '../../src/shard/stitcher';
import { shamirSplitPair } from '../../src/shard/shamir';
import { xorSplit } from '../../src/shard/xor';
import { ShardManifest, ShardError, ShardErrorCode } from '../../src/shard/types';

// Mock GCP Secret Manager
jest.mock('../../src/shard/gcp-secret-manager', () => ({
  getGcpSecret: jest.fn(),
  isGcpAvailable: jest.fn().mockResolvedValue(true),
  configureGcpClient: jest.fn(),
}));

// Mock AWS SSM
jest.mock('../../src/ssm', () => ({
  getSsmParameter: jest.fn(),
}));

import { getGcpSecret } from '../../src/shard/gcp-secret-manager';
import { getSsmParameter } from '../../src/ssm';
const mockedGetGcpSecret = getGcpSecret as jest.MockedFunction<typeof getGcpSecret>;
const mockedGetSsmParameter = getSsmParameter as jest.MockedFunction<typeof getSsmParameter>;

describe('stitcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('stitchConfig with Shamir', () => {
    it('should reconstruct a simple sharded config', async () => {
      const originalSecret = '0xmy-private-key-12345';
      const { share1, share2 } = shamirSplitPair(originalSecret);

      const config = {
        other: { nested: 'value' },
      };

      // Mock AWS SSM to return Share 1
      mockedGetSsmParameter.mockResolvedValue(share1);
      // Mock GCP to return Share 2
      mockedGetGcpSecret.mockResolvedValue(share2);

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'web3_signer_private_key',
            awsParamName: '/test/web3_signer_private_key_share1',
            gcpSecretRef: { project: 'test-project', secretId: 'test-secret' },
            method: 'shamir',
          },
        ],
      };

      const result = await stitchConfig(config, manifest) as { web3_signer_private_key: string; other: { nested: string } };

      expect(result.web3_signer_private_key).toBe(originalSecret);
      expect(result.other.nested).toBe('value'); // Unchanged
      expect(mockedGetSsmParameter).toHaveBeenCalledWith('/test/web3_signer_private_key_share1');
      expect(mockedGetGcpSecret).toHaveBeenCalledWith('test-project', 'test-secret', undefined);
    });

    it('should handle nested paths', async () => {
      const originalSecret = 'solana-private-key';
      const { share1, share2 } = shamirSplitPair(originalSecret);

      const config = {
        solana: {
          rpcUrl: 'https://api.mainnet-beta.solana.com',
        },
      };

      mockedGetSsmParameter.mockResolvedValue(share1);
      mockedGetGcpSecret.mockResolvedValue(share2);

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'solana.privateKey',
            awsParamName: '/test/solana_privateKey_share1',
            gcpSecretRef: { project: 'test', secretId: 'solana-share2' },
            method: 'shamir',
          },
        ],
      };

      const result = await stitchConfig(config, manifest) as { solana: { privateKey: string; rpcUrl: string } };

      expect(result.solana.privateKey).toBe(originalSecret);
      expect(result.solana.rpcUrl).toBe('https://api.mainnet-beta.solana.com'); // Unchanged
    });

    it('should handle numeric object keys (chain IDs)', async () => {
      const originalSecret = 'chain-1-private-key';
      const { share1, share2 } = shamirSplitPair(originalSecret);

      const config = {
        chains: {
          '1': { address: '0x123' },
          '42161': { address: '0x456' },
        },
      };

      mockedGetSsmParameter.mockResolvedValue(share1);
      mockedGetGcpSecret.mockResolvedValue(share2);

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'chains.1.privateKey',
            awsParamName: '/test/chains_1_privateKey_share1',
            gcpSecretRef: { project: 'test', secretId: 'chain-1-share2' },
            method: 'shamir',
          },
        ],
      };

      const result = await stitchConfig(config, manifest) as { chains: Record<string, { privateKey?: string; address: string }> };

      expect(result.chains['1'].privateKey).toBe(originalSecret);
      expect(result.chains['1'].address).toBe('0x123');
      expect(result.chains['42161'].address).toBe('0x456');
    });

    it('should handle multiple sharded fields', async () => {
      const secret1 = 'secret-1';
      const secret2 = 'secret-2';
      const split1 = shamirSplitPair(secret1);
      const split2 = shamirSplitPair(secret2);

      const config = {
        nested: {},
      };

      mockedGetSsmParameter
        .mockResolvedValueOnce(split1.share1)
        .mockResolvedValueOnce(split2.share1);
      mockedGetGcpSecret
        .mockResolvedValueOnce(split1.share2)
        .mockResolvedValueOnce(split2.share2);

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'key1',
            awsParamName: '/test/key1_share1',
            gcpSecretRef: { project: 'p', secretId: 's1' },
            method: 'shamir',
          },
          {
            path: 'nested.key2',
            awsParamName: '/test/nested_key2_share1',
            gcpSecretRef: { project: 'p', secretId: 's2' },
            method: 'shamir',
          },
        ],
      };

      const result = await stitchConfig(config, manifest) as { key1: string; nested: { key2: string } };

      expect(result.key1).toBe(secret1);
      expect(result.nested.key2).toBe(secret2);
    });
  });

  describe('stitchConfig with XOR', () => {
    it('should reconstruct using XOR method', async () => {
      const originalSecret = 'xor-secret';
      const { share1, share2 } = xorSplit(originalSecret);

      const config = {};

      mockedGetSsmParameter.mockResolvedValue(share1);
      mockedGetGcpSecret.mockResolvedValue(share2);

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'secret',
            awsParamName: '/test/secret_share1',
            gcpSecretRef: { project: 'test', secretId: 'xor-share2' },
            method: 'xor',
          },
        ],
      };

      const result = await stitchConfig(config, manifest) as { secret: string };

      expect(result.secret).toBe(originalSecret);
    });
  });

  describe('stitchConfig error handling', () => {
    it('should throw when Share 1 is not found in AWS SSM', async () => {
      const config = {
        other: 'value',
      };

      // AWS SSM returns undefined (parameter not found)
      mockedGetSsmParameter.mockResolvedValue(undefined);

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'missing.field',
            awsParamName: '/test/missing_share1',
            gcpSecretRef: { project: 'test', secretId: 'test' },
            method: 'shamir',
          },
        ],
      };

      await expect(stitchConfig(config, manifest)).rejects.toThrow(ShardError);
      await expect(stitchConfig(config, manifest)).rejects.toThrow(/Share 1 not found in AWS SSM/);
    });

    it('should throw when GCP secret is unavailable', async () => {
      const { share1 } = shamirSplitPair('secret');

      mockedGetSsmParameter.mockResolvedValue(share1);
      mockedGetGcpSecret.mockRejectedValue(new Error('Not found'));

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'key',
            awsParamName: '/test/key_share1',
            gcpSecretRef: { project: 'test', secretId: 'missing' },
            method: 'shamir',
          },
        ],
      };

      await expect(stitchConfig({}, manifest)).rejects.toThrow();
    });

    it('should skip optional fields gracefully', async () => {
      const { share1 } = shamirSplitPair('secret');
      const config = { existingKey: 'value' };

      mockedGetSsmParameter.mockResolvedValue(share1);
      mockedGetGcpSecret.mockRejectedValue(new Error('Not found'));

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'key',
            awsParamName: '/test/key_share1',
            gcpSecretRef: { project: 'test', secretId: 'missing' },
            method: 'shamir',
            required: false,
          },
        ],
      };

      // Should not throw for optional field
      const result = await stitchConfig(config, manifest) as { existingKey: string; key?: string };
      expect(result.existingKey).toBe('value'); // Unchanged
      expect(result.key).toBeUndefined(); // Not reconstructed due to GCP error
    });

    it('should throw for invalid manifest version', async () => {
      const config = { key: 'value' };
      const manifest = { version: '2.0', shardedFields: [] } as unknown as ShardManifest;

      await expect(stitchConfig(config, manifest)).rejects.toThrow(ShardError);
    });

    it('should throw for invalid share format', async () => {
      mockedGetSsmParameter.mockResolvedValue('not-a-valid-share');
      mockedGetGcpSecret.mockResolvedValue('also-not-valid');

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'key',
            awsParamName: '/test/key_share1',
            gcpSecretRef: { project: 'test', secretId: 'test' },
            method: 'shamir',
          },
        ],
      };

      await expect(stitchConfig({}, manifest)).rejects.toThrow(ShardError);
    });
  });

  describe('stitchConfig does not mutate input', () => {
    it('should not modify the original config object', async () => {
      const originalSecret = 'secret';
      const { share1, share2 } = shamirSplitPair(originalSecret);

      const config = {
        nested: { value: 'original' },
      };

      const configCopy = JSON.stringify(config);

      mockedGetSsmParameter.mockResolvedValue(share1);
      mockedGetGcpSecret.mockResolvedValue(share2);

      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'key',
            awsParamName: '/test/key_share1',
            gcpSecretRef: { project: 'test', secretId: 'test' },
            method: 'shamir',
          },
        ],
      };

      await stitchConfig(config, manifest);

      // Original config should be unchanged
      expect(JSON.stringify(config)).toBe(configCopy);
    });
  });

  describe('loadManifest', () => {
    it('should load embedded manifest from config', () => {
      const config = {
        someField: 'value',
        __shardManifest: {
          version: '1.0' as const,
          shardedFields: [
            {
              path: 'someField',
              gcpSecretRef: { project: 'p', secretId: 's' },
              method: 'shamir' as const,
            },
          ],
        },
      };

      const manifest = loadManifest(config);

      expect(manifest).toBeDefined();
      expect(manifest!.version).toBe('1.0');
      expect(manifest!.shardedFields).toHaveLength(1);

      // Manifest should be removed from config
      expect('__shardManifest' in config).toBe(false);
    });

    it('should load manifest from environment string', () => {
      const config = { field: 'value' };
      const envManifest = JSON.stringify({
        version: '1.0',
        shardedFields: [],
      });

      const manifest = loadManifest(config, envManifest);

      expect(manifest).toBeDefined();
      expect(manifest!.version).toBe('1.0');
    });

    it('should return undefined when no manifest found', () => {
      const config = { field: 'value' };

      const manifest = loadManifest(config);

      expect(manifest).toBeUndefined();
    });

    it('should throw for invalid manifest JSON', () => {
      const config = { field: 'value' };

      expect(() => loadManifest(config, 'not valid json')).toThrow(ShardError);
    });

    it('should throw for invalid manifest structure', () => {
      const config = { field: 'value' };
      const invalidManifest = JSON.stringify({ version: '1.0', shardedFields: 'not array' });

      expect(() => loadManifest(config, invalidManifest)).toThrow(ShardError);
    });
  });

  describe('hasShardedFields', () => {
    it('should return true when config has manifest with fields', () => {
      const config = {
        __shardManifest: {
          version: '1.0',
          shardedFields: [{ path: 'key', gcpSecretRef: { project: 'p', secretId: 's' }, method: 'shamir' }],
        },
      };

      expect(hasShardedFields(config)).toBe(true);
    });

    it('should return false when no manifest', () => {
      const config = { field: 'value' };

      expect(hasShardedFields(config)).toBe(false);
    });

    it('should return false when manifest has no fields', () => {
      const config = {
        __shardManifest: {
          version: '1.0',
          shardedFields: [],
        },
      };

      expect(hasShardedFields(config)).toBe(false);
    });
  });

  describe('helper functions', () => {
    it('createEmptyManifest should create valid empty manifest', () => {
      const manifest = createEmptyManifest();

      expect(manifest.version).toBe('1.0');
      expect(manifest.shardedFields).toEqual([]);
    });

    it('createSingleFieldManifest should create valid manifest', () => {
      const manifest = createSingleFieldManifest('my.path', 'project', 'secret');

      expect(manifest.version).toBe('1.0');
      expect(manifest.shardedFields).toHaveLength(1);
      expect(manifest.shardedFields[0].path).toBe('my.path');
      expect(manifest.shardedFields[0].gcpSecretRef.project).toBe('project');
      expect(manifest.shardedFields[0].gcpSecretRef.secretId).toBe('secret');
      expect(manifest.shardedFields[0].method).toBe('shamir');
    });
  });
});
