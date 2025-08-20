import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DynamicAssetConfig } from '../../../src/adapters/kraken/dynamic-config';
import { KrakenClient } from '../../../src/adapters/kraken/client';
import { Logger } from '@mark/logger';
import { KrakenAssetInfo, KrakenDepositMethod, KrakenWithdrawMethod } from '../../../src/adapters/kraken/types';
import { ChainConfiguration } from '@mark/core';

// Mock the KrakenClient
jest.mock('../../../src/adapters/kraken/client');
const MockKrakenClient = KrakenClient as jest.MockedClass<typeof KrakenClient>;

describe('DynamicAssetConfig Unit Tests', () => {
  let dynamicConfig: DynamicAssetConfig;
  let mockClient: jest.Mocked<KrakenClient>;
  let mockLogger: jest.Mocked<Logger>;

  const mockChains: Record<string, ChainConfiguration> = {
    '1': {
      providers: ['https://eth-mainnet.g.alchemy.com'],
      assets: [
        {
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
          decimals: 18,
          tickerHash: 'ETH_HASH',
          isNative: true,
          balanceThreshold: '0'
        },
        {
          symbol: 'WETH',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          decimals: 18,
          tickerHash: 'WETH_HASH',
          isNative: false,
          balanceThreshold: '0'
        },
        {
          symbol: 'USDC',
          address: '0xA0b86a33E6441b8834D3cF9bD0e3F0A6b0a4F3c9',
          decimals: 6,
          tickerHash: 'USDC_HASH',
          isNative: false,
          balanceThreshold: '0'
        },
        {
          symbol: 'USDT',
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          decimals: 6,
          tickerHash: 'USDT_HASH',
          isNative: false,
          balanceThreshold: '0'
        },
      ],
      invoiceAge: 1000,
      gasThreshold: '0',
      deployments: {
        everclear: '0x',
        permit2: '0x',
        multicall3: '0x',
      },
    },
    '137': {
      providers: ['https://polygon-mainnet.g.alchemy.com'],
      assets: [
        {
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
          decimals: 18,
          tickerHash: 'ETH_HASH',
          isNative: true,
          balanceThreshold: '0'
        },
        {
          symbol: 'WETH',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          decimals: 18,
          tickerHash: 'WETH_HASH',
          isNative: false,
          balanceThreshold: '0'
        },
        {
          symbol: 'USDC',
          address: '0xA0b86a33E6441b8834D3cF9bD0e3F0A6b0a4F3c9',
          decimals: 6,
          tickerHash: 'USDC_HASH',
          isNative: false,
          balanceThreshold: '0'
        },
        {
          symbol: 'USDT',
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          decimals: 6,
          tickerHash: 'USDT_HASH',
          isNative: false,
          balanceThreshold: '0'
        },
      ],
      invoiceAge: 1000,
      gasThreshold: '0',
      deployments: {
        everclear: '0x',
        permit2: '0x',
        multicall3: '0x',
      },
    },
    '10': {
      providers: ['https://optimism-mainnet.g.alchemy.com'],
      assets: [
        {
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
          decimals: 18,
          tickerHash: 'ETH_HASH',
          isNative: true,
          balanceThreshold: '0'
        },
        {
          symbol: 'WETH',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          decimals: 18,
          tickerHash: 'WETH_HASH',
          isNative: false,
          balanceThreshold: '0'
        }
      ],
      invoiceAge: 1000,
      gasThreshold: '0',
      deployments: {
        everclear: '0x',
        permit2: '0x',
        multicall3: '0x',
      },
    },
    '8453': {
      providers: ['https://base-mainnet.g.alchemy.com'],
      assets: [
        {
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
          decimals: 18,
          tickerHash: 'ETH_HASH',
          isNative: true,
          balanceThreshold: '0'
        },
        {
          symbol: 'WETH',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          decimals: 18,
          tickerHash: 'WETH_HASH',
          isNative: false,
          balanceThreshold: '0'
        }
      ],
      invoiceAge: 1000,
      gasThreshold: '0',
      deployments: {
        everclear: '0x',
        permit2: '0x',
        multicall3: '0x',
      },
    },
    '42161': {
      providers: ['https://arbitrum-one.g.alchemy.com'],
      assets: [
        {
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
          decimals: 18,
          tickerHash: 'ETH_HASH',
          isNative: true,
          balanceThreshold: '0'
        },
        {
          symbol: 'WETH',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          decimals: 18,
          tickerHash: 'WETH_HASH',
          isNative: false,
          balanceThreshold: '0'
        }
      ],
      invoiceAge: 1000,
      gasThreshold: '0',
      deployments: {
        everclear: '0x',
        permit2: '0x',
        multicall3: '0x',
      },
    },
  };

  beforeEach(() => {
    // Create mock client with required parameters
    mockClient = new MockKrakenClient('mock-key', 'mock-secret', {} as Logger) as jest.Mocked<KrakenClient>;

    // Create mock logger
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    dynamicConfig = new DynamicAssetConfig(mockClient, mockChains, mockLogger);
  });

  describe('Asset Symbol Resolution', () => {
    it('should resolve known symbols directly', async () => {
      const mockAssetInfo: Record<string, KrakenAssetInfo> = {
        XETH: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 18,
          display_decimals: 5,
        },
      };

      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Ethereum', limit: true, minimum: '1', 'gen-address': true },
      ];

      mockClient.getAssetInfo.mockResolvedValue(mockAssetInfo);
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Ethereum', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ];
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);
      const mapping = await dynamicConfig.getAssetMapping(1, 'ETH');

      expect(mapping.krakenAsset).toBe('XETH');
      expect(mapping.krakenSymbol).toBe('ETH');
      expect(mapping.chainId).toBe(1);
    });

    it('should resolve contract addresses to symbols', async () => {
      const mockAssetInfo: Record<string, KrakenAssetInfo> = {
        XETH: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 18,
          display_decimals: 5,
        },
      };

      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Ethereum (ERC20)', limit: true, minimum: '1', 'gen-address': true },
      ];
      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Ethereum', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ];

      mockClient.getAssetInfo.mockResolvedValue(mockAssetInfo);
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods)

      // Test WETH address resolution
      const mapping = await dynamicConfig.getAssetMapping(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');

      expect(mapping.krakenAsset).toBe('XETH');
      expect(mapping.krakenSymbol).toBe('ETH');
      expect(mapping.chainId).toBe(1);
    });

    it('should throw error for unknown asset identifiers', async () => {
      await expect(
        dynamicConfig.getAssetMapping(1, 'UNKNOWN_ASSET')
      ).rejects.toThrow('Unknown asset identifier: UNKNOWN_ASSET');
    });

    it('should throw error for unknown contract addresses', async () => {
      await expect(
        dynamicConfig.getAssetMapping(1, '0x1234567890123456789012345678901234567890')
      ).rejects.toThrow('Unknown asset identifier: 0x1234567890123456789012345678901234567890');
    });

    it('should throw error for unmapped Kraken symbols', async () => {
      await expect(
        dynamicConfig.getAssetMapping(1, 'UNKNOWN_SYMBOL')
      ).rejects.toThrow('Unknown asset identifier: UNKNOWN_SYMBOL');
    });
  });

  describe('Chain Method Resolution', () => {
    beforeEach(() => {
      const mockAssetInfo: Record<string, KrakenAssetInfo> = {
        XETH: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 18,
          display_decimals: 5,
        },
      };
      mockClient.getAssetInfo.mockResolvedValue(mockAssetInfo);
      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Ethereum', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ];
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);
    });

    it('should find Ethereum method for chain ID 1', async () => {
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Ethereum', limit: true, minimum: '1', 'gen-address': true },
        { method: 'Bitcoin Network', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      const mapping = await dynamicConfig.getAssetMapping(1, 'ETH');

      expect(mapping.network).toBe('Ethereum');
      expect(mapping.chainId).toBe(1);
    });

    it('should find Polygon method for chain ID 137', async () => {
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Ethereum', limit: true, minimum: '1', 'gen-address': true },
        { method: 'Polygon', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Polygon', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ]
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);

      const mapping = await dynamicConfig.getAssetMapping(137, 'ETH');

      expect(mapping.network).toBe('Polygon');
      expect(mapping.chainId).toBe(137);
    });

    it('should use partial matching for ERC20 methods', async () => {
      const mockUSDCAssetInfo: Record<string, KrakenAssetInfo> = {
        USDC: {
          aclass: 'currency',
          altname: 'USDC',
          decimals: 6,
          display_decimals: 2,
        },
      };
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Ethereum (ERC20)', limit: true, minimum: '1', 'gen-address': true },
        { method: 'Bitcoin Network', limit: true, minimum: '1', 'gen-address': true },
      ];
      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Ethereum', asset: 'USDC', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'USDC', fee: '0.00234' } }
      ];
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);

      mockClient.getAssetInfo.mockResolvedValue(mockUSDCAssetInfo);
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      const mapping = await dynamicConfig.getAssetMapping(1, 'USDC');

      expect(mapping.network).toBe('Ethereum (ERC20)');
      expect(mapping.chainId).toBe(1);
    });

    it('should throw error for unsupported chains', async () => {
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Bitcoin Network', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      await expect(
        dynamicConfig.getAssetMapping(999, 'ETH')
      ).rejects.toThrow('No configured asset information for ETH on 999');
    });

    it('should use partial matching for Polygon methods', async () => {
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Polygon Network', limit: true, minimum: '1', 'gen-address': true },
        { method: 'Bitcoin Network', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);
      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Polygon', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ]
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);

      const mapping = await dynamicConfig.getAssetMapping(137, 'ETH');

      expect(mapping.network).toBe('Polygon Network');
      expect(mapping.chainId).toBe(137);
    });

    it('should use partial matching for Arbitrum methods', async () => {
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Arbitrum One', limit: true, minimum: '1', 'gen-address': true },
        { method: 'Bitcoin Network', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Arbitrum One', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ]
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);

      const mapping = await dynamicConfig.getAssetMapping(42161, 'ETH');

      expect(mapping.network).toBe('Arbitrum One');
      expect(mapping.chainId).toBe(42161);
    });

    it('should use partial matching for Optimism methods', async () => {
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Optimism', limit: true, minimum: '1', 'gen-address': true },
        { method: 'Bitcoin Network', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Optimism', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ]
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);

      const mapping = await dynamicConfig.getAssetMapping(10, 'ETH');

      expect(mapping.network).toBe('Optimism');
      expect(mapping.chainId).toBe(10);
    });

    it('should use partial matching for Base methods', async () => {
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Base Network', limit: true, minimum: '1', 'gen-address': true },
        { method: 'Bitcoin Network', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);

      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Base', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ]
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);

      const mapping = await dynamicConfig.getAssetMapping(8453, 'ETH');

      expect(mapping.network).toBe('Base Network');
      expect(mapping.chainId).toBe(8453);
    });
  });

  describe('Fee Resolution', () => {
    beforeEach(() => {
      const mockAssetInfo: Record<string, KrakenAssetInfo> = {
        XETH: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 18,
          display_decimals: 5,
        },
      };
      const mockDepositMethods: KrakenDepositMethod[] = [
        { method: 'Ethereum', limit: true, minimum: '1', 'gen-address': true },
      ];
      mockClient.getAssetInfo.mockResolvedValue(mockAssetInfo);
      mockClient.getDepositMethods.mockResolvedValue(mockDepositMethods);
      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Ethereum', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '1232', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.00234' } }
      ];
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);
    });

    it('should use API withdrawal info when available', async () => {
      const mockWithdrawMethods: KrakenWithdrawMethod[] = [
        { network: 'Ethereum', asset: 'ETH', method: 'asadf', method_id: 'asdfas', network_id: '123', minimum: '0.005', limits: {} as any, fee: { aclass: 'currency', asset: 'ETH', fee: '0.0035' } }
      ];
      mockClient.getWithdrawMethods.mockResolvedValue(mockWithdrawMethods);

      const mapping = await dynamicConfig.getAssetMapping(1, 'ETH');

      // Values are returned as decimal strings, not converted to wei
      expect(mapping.withdrawMethod.minimum).toBe('0.005'); // 0.005 ETH as decimal
      expect(mapping.withdrawMethod.fee.fee).toBe('0.0035'); // 0.0035 ETH as decimal
    });
  });

  describe('Error Handling', () => {
    it('should throw error when asset info is not found', async () => {
      mockClient.getDepositMethods.mockResolvedValue([]);
      mockClient.getWithdrawMethods.mockResolvedValue([]);

      await expect(
        dynamicConfig.getAssetMapping(1, 'XYZ')
      ).rejects.toThrow('Unknown asset identifier: XYZ');
    });

    it('should throw error when no deposit methods are available', async () => {
      const mockAssetInfo: Record<string, KrakenAssetInfo> = {
        XETH: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 18,
          display_decimals: 5,
        },
      };
      mockClient.getAssetInfo.mockResolvedValue(mockAssetInfo);
      mockClient.getDepositMethods.mockResolvedValue([]);

      await expect(
        dynamicConfig.getAssetMapping(1, 'ETH')
      ).rejects.toThrow('Kraken does not support deposits of ETH on chain 1. Available methods:');
    });

    it('should handle API errors gracefully', async () => {
      mockClient.getDepositMethods.mockRejectedValue(new Error('Kraken API Error'));

      await expect(
        dynamicConfig.getAssetMapping(1, 'ETH')
      ).rejects.toThrow('Kraken API Error');
    });
  });
});