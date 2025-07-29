import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { Logger } from '@mark/logger';
import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import { findAssetByAddress, findMatchingDestinationAsset, getDestinationAssetAddress } from '../../src/shared/asset';

// Mock logger
const mockLogger: Logger = {
  debug: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
} as any;

describe('Asset Utils', () => {
  const mockAsset1: AssetConfiguration = {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tickerHash: 'USDC_HASH',
    symbol: 'USDC',
    decimals: 6,
  } as AssetConfiguration;

  const mockAsset2: AssetConfiguration = {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tickerHash: 'WETH_HASH',
    symbol: 'WETH',
    decimals: 18,
  } as AssetConfiguration;

  const mockAsset3: AssetConfiguration = {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    tickerHash: 'USDC_HASH', // Same ticker hash as mockAsset1
    symbol: 'USDC',
    decimals: 6,
  } as AssetConfiguration;

  const mockChains: Record<string, ChainConfiguration> = {
    '1': {
      chainId: 1,
      name: 'Ethereum',
      assets: [mockAsset1, mockAsset2],
      providers: [],
      invoiceAge: 0,
      gasThreshold: '0',
      deployments: {
        everclear: '0x0000000000000000000000000000000000000000',
        permit2: '0x0000000000000000000000000000000000000000',
        multicall3: '0x0000000000000000000000000000000000000000',
      },
    } as ChainConfiguration,
    '8453': {
      chainId: 8453,
      name: 'Base',
      assets: [mockAsset3],
      providers: [],
      invoiceAge: 0,
      gasThreshold: '0',
      deployments: {
        everclear: '0x0000000000000000000000000000000000000000',
        permit2: '0x0000000000000000000000000000000000000000',
        multicall3: '0x0000000000000000000000000000000000000000',
      },
    } as ChainConfiguration,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findAssetByAddress', () => {
    it('should find asset by address (case-insensitive)', () => {
      const result = findAssetByAddress(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // lowercase
        1,
        mockChains,
        mockLogger,
      );

      expect(result).toEqual(mockAsset1);
      expect(mockLogger.debug).toHaveBeenCalledWith('Finding matching asset', {
        asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        chain: 1,
      });
    });

    it('should return undefined when chain configuration not found', () => {
      const result = findAssetByAddress(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        999, // non-existent chain
        mockChains,
        mockLogger,
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Chain configuration not found', {
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        chain: 999,
      });
    });

    it('should return undefined when asset not found in chain', () => {
      const result = findAssetByAddress('0x0000000000000000000000000000000000000000', 1, mockChains, mockLogger);

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Finding matching asset', {
        asset: '0x0000000000000000000000000000000000000000',
        chain: 1,
      });
    });

    it('should handle uppercase addresses', () => {
      const result = findAssetByAddress(
        '0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', // all uppercase
        1,
        mockChains,
        mockLogger,
      );

      expect(result).toEqual(mockAsset1);
    });
  });

  describe('findMatchingDestinationAsset', () => {
    it('should find matching asset in destination chain by ticker hash', () => {
      const result = findMatchingDestinationAsset(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
        1,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toEqual(mockAsset3); // USDC on Base
      expect(mockLogger.debug).toHaveBeenCalledWith('Finding matching destination asset', {
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        origin: 1,
        destination: 8453,
      });
      expect(mockLogger.debug).toHaveBeenCalledWith('Found asset in origin chain', {
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        origin: 1,
        originAsset: mockAsset1,
      });
      expect(mockLogger.debug).toHaveBeenCalledWith('Found matching asset in destination chain', {
        originAsset: mockAsset1,
        destinationAsset: mockAsset3,
      });
    });

    it('should return undefined when destination chain not found', () => {
      const result = findMatchingDestinationAsset(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        1,
        999, // non-existent chain
        mockChains,
        mockLogger,
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Destination chain configuration not found', {
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        origin: 1,
        destination: 999,
      });
    });

    it('should return undefined when origin asset not found', () => {
      const result = findMatchingDestinationAsset(
        '0x0000000000000000000000000000000000000000',
        1,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Asset not found on origin chain', {
        asset: '0x0000000000000000000000000000000000000000',
        origin: 1,
      });
    });

    it('should return undefined when no matching ticker hash in destination', () => {
      const result = findMatchingDestinationAsset(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH - no matching asset on Base
        1,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Matching asset not found in destination chain', {
        asset: mockAsset2,
        destination: 8453,
      });
    });

    it('should handle empty chains object', () => {
      const result = findMatchingDestinationAsset(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        1,
        8453,
        {},
        mockLogger,
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Destination chain configuration not found', {
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        origin: 1,
        destination: 8453,
      });
    });

    it('should handle chain with no assets', () => {
      const chainsWithEmptyAssets = {
        '1': {
          chainId: 1,
          name: 'Ethereum',
          assets: [mockAsset1],
          providers: [],
          invoiceAge: 0,
          gasThreshold: '0',
          deployments: {
            everclear: '0x0000000000000000000000000000000000000000',
            permit2: '0x0000000000000000000000000000000000000000',
            multicall3: '0x0000000000000000000000000000000000000000',
          },
        } as ChainConfiguration,
        '8453': {
          chainId: 8453,
          name: 'Base',
          assets: [],
          providers: [],
          invoiceAge: 0,
          gasThreshold: '0',
          deployments: {
            everclear: '0x0000000000000000000000000000000000000000',
            permit2: '0x0000000000000000000000000000000000000000',
            multicall3: '0x0000000000000000000000000000000000000000',
          },
        } as ChainConfiguration,
      };

      const result = findMatchingDestinationAsset(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        1,
        8453,
        chainsWithEmptyAssets,
        mockLogger,
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Matching asset not found in destination chain', {
        asset: mockAsset1,
        destination: 8453,
      });
    });
  });

  describe('getDestinationAssetAddress', () => {
    it('should return destination asset address when found', () => {
      const result = getDestinationAssetAddress(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        1,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    });

    it('should return undefined when destination asset not found', () => {
      const result = getDestinationAssetAddress(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH - no match on Base
        1,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toBeUndefined();
    });

    it('should return undefined when origin asset not found', () => {
      const result = getDestinationAssetAddress(
        '0x0000000000000000000000000000000000000000',
        1,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toBeUndefined();
    });

    it('should handle case-insensitive addresses', () => {
      const result = getDestinationAssetAddress(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // lowercase
        1,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    });

    it('should return undefined for invalid chain IDs', () => {
      const result = getDestinationAssetAddress(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        999,
        8453,
        mockChains,
        mockLogger,
      );

      expect(result).toBeUndefined();
    });
  });
});
