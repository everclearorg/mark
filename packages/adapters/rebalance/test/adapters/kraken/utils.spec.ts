/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  generateWithdrawOrderId,
  getDestinationAssetMapping,
  validateAssetMapping,
  findAssetByAddress,
  calculateNetAmount,
  meetsMinimumWithdrawal,
  checkWithdrawQuota,
} from '../../../src/adapters/kraken/utils';
import { KrakenAssetMapping } from '../../../src/adapters/kraken/types';
import { RebalanceRoute, ChainConfiguration } from '@mark/core';
import { DynamicAssetConfig } from '../../../src/adapters/kraken/dynamic-config';
import { KrakenClient } from '../../../src/adapters/kraken/client';
import { Logger } from '@mark/logger';

// Mock dependencies
jest.mock('../../../src/adapters/kraken/dynamic-config');
jest.mock('../../../src/adapters/kraken/client');

const mockRoute: RebalanceRoute = {
  origin: 1,
  destination: 137,
  asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
};

const mockAssetMapping: KrakenAssetMapping = {
  network: 'Ethereum',
  chainId: 1,
  krakenAsset: 'WETH',
  krakenSymbol: 'ETH',
  method: 'Ethereum',
  withdrawalFee: '5000000000000000', // 0.005 ETH in wei
  minWithdrawalAmount: '10000000000000000', // 0.01 ETH in wei
};

const mockDestinationMapping: KrakenAssetMapping = {
  network: 'Polygon',
  chainId: 137,
  krakenAsset: 'WETH',
  krakenSymbol: 'WETH',
  method: 'Polygon',
  withdrawalFee: '5000000000000000',
  minWithdrawalAmount: '10000000000000000',
};

describe('Kraken Utils', () => {
  let mockDynamicConfig: jest.Mocked<DynamicAssetConfig>;
  let mockClient: jest.Mocked<KrakenClient>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamicConfig = {
      getAssetMapping: jest.fn(),
    } as any;
    mockClient = {} as any;
    mockLogger = {
      debug: jest.fn(),
      warn: jest.fn(),
    } as any;
  });

  describe('generateWithdrawOrderId', () => {
    it('should generate a properly formatted order ID', () => {
      const transactionHash = '0x1234567890abcdef1234567890abcdef12345678';
      const orderId = generateWithdrawOrderId(mockRoute, transactionHash);

      expect(orderId).toBe('mark-1-137-12345678');
    });

    it('should handle different route values', () => {
      const route: RebalanceRoute = { origin: 56, destination: 10, asset: '0x123' };
      const transactionHash = '0xabcdef1234567890abcdef1234567890abcdef12';
      const orderId = generateWithdrawOrderId(route, transactionHash);

      expect(orderId).toBe('mark-56-10-abcdef12');
    });
  });

  describe('getDestinationAssetMapping', () => {
    it('should get destination mapping for ETH/WETH conversion', async () => {
      mockDynamicConfig.getAssetMapping
        .mockResolvedValueOnce(mockAssetMapping) // origin mapping
        .mockResolvedValueOnce(mockDestinationMapping); // destination mapping

      const result = await getDestinationAssetMapping(mockDynamicConfig, mockRoute);

      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledTimes(2);
      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledWith(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledWith(137, 'WETH');
      expect(result).toBe(mockDestinationMapping);
    });

    it('should handle non-ETH assets', async () => {
      const usdcMapping: KrakenAssetMapping = {
        ...mockAssetMapping,
        krakenSymbol: 'USDC',
        krakenAsset: 'USDC',
      };

      mockDynamicConfig.getAssetMapping
        .mockResolvedValueOnce(usdcMapping)
        .mockResolvedValueOnce(usdcMapping);

      const usdcRoute: RebalanceRoute = { ...mockRoute, asset: '0xA0b86a33E6' };
      await getDestinationAssetMapping(mockDynamicConfig, usdcRoute);

      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledWith(137, 'USDC');
    });
  });

  describe('validateAssetMapping', () => {
    it('should return valid asset mapping', async () => {
      mockDynamicConfig.getAssetMapping.mockResolvedValue(mockAssetMapping);

      const result = await validateAssetMapping(mockDynamicConfig, mockRoute, 'test context');

      expect(result).toBe(mockAssetMapping);
      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalledWith(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
    });

    it('should throw error for missing symbol', async () => {
      const invalidMapping = { ...mockAssetMapping, krakenSymbol: '' };
      mockDynamicConfig.getAssetMapping.mockResolvedValue(invalidMapping);

      await expect(validateAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('Invalid Kraken asset mapping for test context: missing symbol or method');
    });

    it('should throw error for missing method', async () => {
      const invalidMapping = { ...mockAssetMapping, method: '' };
      mockDynamicConfig.getAssetMapping.mockResolvedValue(invalidMapping);

      await expect(validateAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('Invalid Kraken asset mapping for test context: missing symbol or method');
    });

    it('should throw error for missing fee configuration', async () => {
      const invalidMapping = { ...mockAssetMapping, withdrawalFee: '' };
      mockDynamicConfig.getAssetMapping.mockResolvedValue(invalidMapping);

      await expect(validateAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('Invalid Kraken asset mapping for test context: missing fee configuration');
    });

    it('should throw error when getAssetMapping fails', async () => {
      mockDynamicConfig.getAssetMapping.mockRejectedValue(new Error('Mapping not found'));

      await expect(validateAssetMapping(mockDynamicConfig, mockRoute, 'test context'))
        .rejects.toThrow('No Kraken asset mapping found for test context: Mapping not found');
    });
  });

  describe('findAssetByAddress', () => {
    const mockChains: Record<string, ChainConfiguration> = {
      '1': {
        providers: ['http://test'],
        assets: [
          {
            symbol: 'WETH',
            address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            decimals: 18,
            tickerHash: '0xwethhash'
          },
          {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
            decimals: 18,
            tickerHash: '0xethhash'
          },
        ],
      } as unknown as ChainConfiguration,
    };

    it('should find asset by address', () => {
      const result = findAssetByAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 1, mockChains);

      expect(result).toEqual({
        tickerHash: '0xwethhash',
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      });
    });

    it('should find native asset by zero address', () => {
      const result = findAssetByAddress('0x0000000000000000000000000000000000000000', 1, mockChains);

      expect(result).toEqual({
        tickerHash: '0xethhash',
        address: '0x0000000000000000000000000000000000000000',
      });
    });

    it('should handle case-insensitive addresses', () => {
      const result = findAssetByAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 1, mockChains);

      expect(result).toEqual({
        tickerHash: '0xwethhash',
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      });
    });

    it('should return undefined for non-existent chain', () => {
      const result = findAssetByAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 999, mockChains);
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-existent asset', () => {
      const result = findAssetByAddress('0x1234567890123456789012345678901234567890', 1, mockChains);
      expect(result).toBeUndefined();
    });
  });

  describe('calculateNetAmount', () => {
    it('should calculate net amount after fee deduction', () => {
      const amount = '1000000000000000000'; // 1 ETH
      const withdrawalFee = '5000000000000000'; // 0.005 ETH

      const result = calculateNetAmount(amount, withdrawalFee);

      expect(result).toBe('995000000000000000'); // 0.995 ETH
    });

    it('should throw error when amount is less than fee', () => {
      const amount = '1000000000000000'; // 0.001 ETH
      const withdrawalFee = '5000000000000000'; // 0.005 ETH

      expect(() => calculateNetAmount(amount, withdrawalFee))
        .toThrow('Amount is less than or equal to withdrawal fee');
    });

    it('should throw error when amount equals fee', () => {
      const amount = '5000000000000000'; // 0.005 ETH
      const withdrawalFee = '5000000000000000'; // 0.005 ETH

      expect(() => calculateNetAmount(amount, withdrawalFee))
        .toThrow('Amount is less than or equal to withdrawal fee');
    });
  });

  describe('meetsMinimumWithdrawal', () => {
    it('should return true when amount meets minimum', () => {
      const amount = '20000000000000000'; // 0.02 ETH
      const result = meetsMinimumWithdrawal(amount, mockAssetMapping);

      expect(result).toBe(true);
    });

    it('should return false when amount is below minimum', () => {
      const amount = '5000000000000000'; // 0.005 ETH
      const result = meetsMinimumWithdrawal(amount, mockAssetMapping);

      expect(result).toBe(false);
    });

    it('should return true when amount exactly equals minimum', () => {
      const amount = '10000000000000000'; // 0.01 ETH
      const result = meetsMinimumWithdrawal(amount, mockAssetMapping);

      expect(result).toBe(true);
    });
  });

  describe('checkWithdrawQuota', () => {
    it('should allow withdrawal within limits', async () => {
      const amount = '100000000000000000'; // 0.1 ETH (~$300)
      const result = await checkWithdrawQuota(amount, 'ETH', 18, mockClient, mockLogger);

      expect(result.allowed).toBe(true);
      expect(result.amountUSD).toBe(300); // 0.1 * 3000
      expect(result.message).toBeUndefined();
    });

    it('should reject withdrawal exceeding limits', async () => {
      const amount = '20000000000000000000'; // 20 ETH (~$60,000)
      const result = await checkWithdrawQuota(amount, 'ETH', 18, mockClient, mockLogger);

      expect(result.allowed).toBe(false);
      expect(result.amountUSD).toBe(60000);
      expect(result.message).toContain('exceeds daily limit');
    });

    it('should handle unknown assets with default price', async () => {
      const amount = '1000000000000000000'; // 1 unit of unknown asset
      const result = await checkWithdrawQuota(amount, 'UNKNOWN', 18, mockClient, mockLogger);

      expect(result.allowed).toBe(true);
      expect(result.amountUSD).toBe(1); // Default price of $1
    });

    it('should allow by default on error', async () => {
      // This will throw an error due to invalid decimals
      const result = await checkWithdrawQuota('invalid', 'ETH', -1, mockClient, mockLogger);

      expect(result.allowed).toBe(true);
      expect(result.amountUSD).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});