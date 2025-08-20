/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  getDestinationAssetMapping,
  getValidAssetMapping,
} from '../../../src/adapters/kraken/utils';
import { KrakenAssetMapping } from '../../../src/adapters/kraken/types';
import { RebalanceRoute } from '@mark/core';
import { DynamicAssetConfig } from '../../../src/adapters/kraken/dynamic-config';

// Mock dependencies
jest.mock('../../../src/adapters/kraken/dynamic-config');

const mockRoute: RebalanceRoute = {
  origin: 1,
  destination: 137,
  asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
};

const mockAssetMapping: KrakenAssetMapping = {
  network: 'Ethereum',
  chainId: 1,
  krakenAsset: 'XETH',
  krakenSymbol: 'ETH',
  depositMethod: {
    method: 'Ethereum',
    limit: true,
    minimum: '1',
    'gen-address': true,
  },
  withdrawMethod: {
    asset: 'XETH',
    method_id: 'ETH-ERC20',
    method: 'Ethereum',
    network_id: 'ETH',
    network: 'Ethereum',
    minimum: '0.005',
    limits: [{
      limit_type: 'amount' as const,
      description: 'Test limits',
      limits: {},
    }],
    fee: {
      aclass: 'currency',
      asset: 'XETH',
      fee: '0.0035',
    },
  },
};

describe('Kraken Utils', () => {
  let mockDynamicConfig: jest.Mocked<DynamicAssetConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamicConfig = {
      getAssetMapping: jest.fn(),
    } as any;
  });

  describe('getDestinationAssetMapping', () => {
    it('should get destination mapping for ETH/WETH conversion', async () => {
      mockDynamicConfig.getAssetMapping
        .mockResolvedValueOnce(mockAssetMapping) // Origin mapping
        .mockResolvedValueOnce(mockAssetMapping); // Destination mapping

      const result = await getDestinationAssetMapping(mockDynamicConfig, mockRoute);

      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledWith(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledWith(137, 'WETH');
      expect(result).toEqual(mockAssetMapping);
    });

    it('should handle non-ETH assets', async () => {
      const usdcMapping = {
        ...mockAssetMapping,
        krakenSymbol: 'USDC',
        krakenAsset: 'USDC',
      };

      mockDynamicConfig.getAssetMapping
        .mockResolvedValueOnce(usdcMapping) // Origin mapping
        .mockResolvedValueOnce(usdcMapping); // Destination mapping

      const result = await getDestinationAssetMapping(mockDynamicConfig, {
        ...mockRoute,
        asset: 'USDC',
      });

      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledWith(137, 'USDC');
      expect(result).toEqual(usdcMapping);
    });
  });

  describe('getValidAssetMapping', () => {
    it('should return valid asset mapping', async () => {
      mockDynamicConfig.getAssetMapping.mockResolvedValue(mockAssetMapping);

      const result = await getValidAssetMapping(mockDynamicConfig, mockRoute, 'test context');

      expect(result).toEqual(mockAssetMapping);
    });

    it('should throw error for missing symbol', async () => {
      const invalidMapping = { ...mockAssetMapping, krakenSymbol: '' };
      mockDynamicConfig.getAssetMapping.mockResolvedValue(invalidMapping);

      await expect(getValidAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('Invalid Kraken asset mapping for test context: missing symbol or asset');
    });

    it('should throw error for missing deposit method', async () => {
      const invalidMapping = { ...mockAssetMapping, depositMethod: undefined as any };
      mockDynamicConfig.getAssetMapping.mockResolvedValue(invalidMapping);

      await expect(getValidAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('Invalid Kraken asset mapping for test context: missing deposit method');
    });

    it('should throw error for missing withdraw method', async () => {
      const invalidMapping = { ...mockAssetMapping, withdrawMethod: undefined as any };
      mockDynamicConfig.getAssetMapping.mockResolvedValue(invalidMapping);

      await expect(getValidAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('Invalid Kraken asset mapping for test context: missing withdraw method');
    });

    it('should throw error when getAssetMapping fails', async () => {
      mockDynamicConfig.getAssetMapping.mockRejectedValue(new Error('Network error'));

      await expect(getValidAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('No Kraken asset mapping found for test context: Network error');
    });
  });
});