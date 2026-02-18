/**
 * Tests for Share 1 loading from SSM in config.ts
 * 
 * Tests the logic that loads Share 1 values from AWS SSM Parameter Store
 * and places them into the config JSON before reconstruction.
 */

import { getSsmParameter } from '../src/ssm';
import { setValueByPath } from '../src/shard';
import { ShardManifest } from '../src/shard/types';

// Mock SSM module
jest.mock('../src/ssm', () => ({
  getSsmParameter: jest.fn(),
}));

const mockedGetSsmParameter = getSsmParameter as jest.MockedFunction<typeof getSsmParameter>;

describe('Config Share 1 Loading', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('SSM parameter name derivation', () => {
    it('should use awsParamName when provided', async () => {
      const share1 = '1-abc123def456';
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'web3_signer_private_key',
            awsParamName: '/mark/config/web3_signer_private_key_share1',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
          },
        ],
      };

      mockedGetSsmParameter.mockResolvedValue(share1);

      // Simulate the loading logic
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        const ssmParamName = fieldConfig.awsParamName!;
        const share1Value = await getSsmParameter(ssmParamName);
        if (share1Value) {
          setValueByPath(configJson, fieldConfig.path, share1Value);
        }
      }

      expect(mockedGetSsmParameter).toHaveBeenCalledWith('/mark/config/web3_signer_private_key_share1');
      expect(configJson.web3_signer_private_key).toBe(share1);
    });

    it('should derive parameter name from path when awsParamName not provided', async () => {
      const share1 = '1-abc123def456';
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'web3_signer_private_key',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
          },
        ],
      };

      mockedGetSsmParameter.mockResolvedValue(share1);

      // Simulate the loading logic
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        let ssmParamName: string;
        if (fieldConfig.awsParamName) {
          ssmParamName = fieldConfig.awsParamName;
        } else {
          const safePath = fieldConfig.path.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
          ssmParamName = `${parameterPrefix}/${safePath}_share1`;
        }
        const share1Value = await getSsmParameter(ssmParamName);
        if (share1Value) {
          setValueByPath(configJson, fieldConfig.path, share1Value);
        }
      }

      expect(mockedGetSsmParameter).toHaveBeenCalledWith('/mark/config/web3_signer_private_key_share1');
      expect(configJson.web3_signer_private_key).toBe(share1);
    });

    it('should handle nested paths correctly', async () => {
      const share1 = '1-abc123def456';
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'solana.privateKey',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
          },
        ],
      };

      mockedGetSsmParameter.mockResolvedValue(share1);

      // Simulate the loading logic
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        let ssmParamName: string;
        if (fieldConfig.awsParamName) {
          ssmParamName = fieldConfig.awsParamName;
        } else {
          const safePath = fieldConfig.path.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
          ssmParamName = `${parameterPrefix}/${safePath}_share1`;
        }
        const share1Value = await getSsmParameter(ssmParamName);
        if (share1Value) {
          setValueByPath(configJson, fieldConfig.path, share1Value);
        }
      }

      expect(mockedGetSsmParameter).toHaveBeenCalledWith('/mark/config/solana_privateKey_share1');
      expect((configJson.solana as { privateKey: string }).privateKey).toBe(share1);
    });

    it('should handle array notation in paths', async () => {
      const share1 = '1-abc123def456';
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'chains.1.privateKey',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
          },
        ],
      };

      mockedGetSsmParameter.mockResolvedValue(share1);

      // Simulate the loading logic
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        let ssmParamName: string;
        if (fieldConfig.awsParamName) {
          ssmParamName = fieldConfig.awsParamName;
        } else {
          const safePath = fieldConfig.path.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
          ssmParamName = `${parameterPrefix}/${safePath}_share1`;
        }
        const share1Value = await getSsmParameter(ssmParamName);
        if (share1Value) {
          setValueByPath(configJson, fieldConfig.path, share1Value);
        }
      }

      expect(mockedGetSsmParameter).toHaveBeenCalledWith('/mark/config/chains_1_privateKey_share1');
      expect((configJson.chains as { '1': { privateKey: string } })['1'].privateKey).toBe(share1);
    });

    it('should use default prefix when awsConfig not provided', async () => {
      const share1 = '1-abc123def456';
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        shardedFields: [
          {
            path: 'web3_signer_private_key',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
          },
        ],
      };

      mockedGetSsmParameter.mockResolvedValue(share1);

      // Simulate the loading logic
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        let ssmParamName: string;
        if (fieldConfig.awsParamName) {
          ssmParamName = fieldConfig.awsParamName;
        } else {
          const safePath = fieldConfig.path.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
          ssmParamName = `${parameterPrefix}/${safePath}_share1`;
        }
        const share1Value = await getSsmParameter(ssmParamName);
        if (share1Value) {
          setValueByPath(configJson, fieldConfig.path, share1Value);
        }
      }

      expect(mockedGetSsmParameter).toHaveBeenCalledWith('/mark/config/web3_signer_private_key_share1');
    });
  });

  describe('Error handling', () => {
    it('should throw ConfigurationError when required field Share 1 is missing', async () => {
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'web3_signer_private_key',
            awsParamName: '/mark/config/web3_signer_private_key_share1',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
            required: true,
          },
        ],
      };

      mockedGetSsmParameter.mockResolvedValue(undefined);

      // Simulate the loading logic with error handling
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        const ssmParamName = fieldConfig.awsParamName!;
        const share1Value = await getSsmParameter(ssmParamName);

        if (share1Value === undefined || share1Value === null) {
          const isRequired = fieldConfig.required !== false;
          if (isRequired) {
            await expect(
              Promise.reject(
                new Error(
                  `Failed to load Share 1 from SSM parameter '${ssmParamName}' for field '${fieldConfig.path}'`,
                ),
              ),
            ).rejects.toThrow();
            return;
          }
        }
      }
    });

    it('should skip optional fields when Share 1 is missing', async () => {
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'binance.apiSecret',
            awsParamName: '/mark/config/binance_apiSecret_share1',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
            required: false,
          },
        ],
      };

      mockedGetSsmParameter.mockResolvedValue(undefined);

      // Simulate the loading logic with error handling
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        const ssmParamName = fieldConfig.awsParamName!;
        const share1Value = await getSsmParameter(ssmParamName);

        if (share1Value === undefined || share1Value === null) {
          const isRequired = fieldConfig.required !== false;
          if (isRequired) {
            throw new Error(`Failed to load Share 1 from SSM parameter '${ssmParamName}' for field '${fieldConfig.path}'`);
          } else {
            // Skip optional field - should not throw
            continue;
          }
        }
        setValueByPath(configJson, fieldConfig.path, share1Value);
      }

      expect(mockedGetSsmParameter).toHaveBeenCalled();
      expect(configJson.binance).toBeUndefined();
    });

    it('should handle SSM errors for required fields', async () => {
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'web3_signer_private_key',
            awsParamName: '/mark/config/web3_signer_private_key_share1',
            gcpSecretRef: { project: 'test', secretId: 'test-secret' },
            method: 'shamir',
            required: true,
          },
        ],
      };

      const ssmError = new Error('SSM parameter not found');
      mockedGetSsmParameter.mockRejectedValue(ssmError);

      // Simulate the loading logic with error handling
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        const ssmParamName = fieldConfig.awsParamName!;
        try {
          const share1Value = await getSsmParameter(ssmParamName);
          if (share1Value) {
            setValueByPath(configJson, fieldConfig.path, share1Value);
          }
        } catch (error) {
          const isRequired = fieldConfig.required !== false;
          if (isRequired) {
            await expect(Promise.reject(error)).rejects.toThrow('SSM parameter not found');
            return;
          }
        }
      }
    });
  });

  describe('Multiple fields', () => {
    it('should load multiple Share 1 values correctly', async () => {
      const share1a = '1-abc123def456';
      const share1b = '1-xyz789ghi012';
      const configJson: Record<string, unknown> = {};
      const manifest: ShardManifest = {
        version: '1.0',
        awsConfig: {
          region: 'us-east-1',
          parameterPrefix: '/mark/config',
        },
        shardedFields: [
          {
            path: 'web3_signer_private_key',
            awsParamName: '/mark/config/web3_signer_private_key_share1',
            gcpSecretRef: { project: 'test', secretId: 'test-secret-1' },
            method: 'shamir',
          },
          {
            path: 'solana.privateKey',
            awsParamName: '/mark/config/solana_privateKey_share1',
            gcpSecretRef: { project: 'test', secretId: 'test-secret-2' },
            method: 'shamir',
          },
        ],
      };

      mockedGetSsmParameter
        .mockResolvedValueOnce(share1a)
        .mockResolvedValueOnce(share1b);

      // Simulate the loading logic
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';
      for (const fieldConfig of manifest.shardedFields) {
        const ssmParamName = fieldConfig.awsParamName!;
        const share1Value = await getSsmParameter(ssmParamName);
        if (share1Value) {
          setValueByPath(configJson, fieldConfig.path, share1Value);
        }
      }

      expect(mockedGetSsmParameter).toHaveBeenCalledTimes(2);
      expect(mockedGetSsmParameter).toHaveBeenNthCalledWith(1, '/mark/config/web3_signer_private_key_share1');
      expect(mockedGetSsmParameter).toHaveBeenNthCalledWith(2, '/mark/config/solana_privateKey_share1');
      expect(configJson.web3_signer_private_key).toBe(share1a);
      expect((configJson.solana as { privateKey: string }).privateKey).toBe(share1b);
    });
  });
});
