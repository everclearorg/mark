import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { Logger } from '@mark/logger';
import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import {
  findMatchingDestinationAsset,
  isSwapRoute,
  getRouteAssetSymbols,
  validateSwapRoute,
} from '../../src/shared/asset';

// Mock logger
const mockLogger: Logger = {
  debug: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
} as any;

describe('Swap Route Helpers', () => {
  // USDT on Arbitrum
  const usdtArbitrum: AssetConfiguration = {
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    tickerHash: 'USDT_HASH',
    symbol: 'USDT',
    decimals: 6,
    isNative: false,
    balanceThreshold: '0',
  } as AssetConfiguration;

  // USDC on Optimism
  const usdcOptimism: AssetConfiguration = {
    address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    tickerHash: 'USDC_HASH',
    symbol: 'USDC',
    decimals: 6,
    isNative: false,
    balanceThreshold: '0',
  } as AssetConfiguration;

  // USDC on Arbitrum (for same-asset test)
  const usdcArbitrum: AssetConfiguration = {
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    tickerHash: 'USDC_HASH',
    symbol: 'USDC',
    decimals: 6,
    isNative: false,
    balanceThreshold: '0',
  } as AssetConfiguration;

  const mockChains: Record<string, ChainConfiguration> = {
    '42161': {
      chainId: 42161,
      name: 'Arbitrum',
      assets: [usdtArbitrum, usdcArbitrum],
      providers: ['https://arb1.arbitrum.io/rpc'],
      invoiceAge: 0,
      gasThreshold: '0',
      deployments: {
        everclear: '0x0000000000000000000000000000000000000000',
        permit2: '0x0000000000000000000000000000000000000000',
        multicall3: '0x0000000000000000000000000000000000000000',
      },
    } as ChainConfiguration,
    '10': {
      chainId: 10,
      name: 'Optimism',
      assets: [usdcOptimism],
      providers: ['https://mainnet.optimism.io'],
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

  describe('isSwapRoute', () => {
    it('should return false for same-asset routes (undefined destinationAsset)', () => {
      const route = {
        asset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        origin: 42161,
        destination: 10,
      };
      expect(isSwapRoute(route)).toBe(false);
    });

    it('should return false for same-asset routes (same address)', () => {
      const route = {
        asset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        origin: 42161,
        destination: 10,
        destinationAsset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      };
      expect(isSwapRoute(route)).toBe(false);
    });

    it('should return false for same address with different case', () => {
      const route = {
        asset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        origin: 42161,
        destination: 10,
        destinationAsset: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // lowercase
      };
      expect(isSwapRoute(route)).toBe(false);
    });

    it('should return true for cross-asset swap routes', () => {
      const route = {
        asset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        origin: 42161,
        destination: 10,
        destinationAsset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      };
      expect(isSwapRoute(route)).toBe(true);
    });
  });

  describe('findMatchingDestinationAsset with destinationAsset parameter', () => {
    it('should use explicit destinationAsset when provided', () => {
      const route = {
        asset: usdtArbitrum.address,
        origin: 42161,
        destination: 10,
        destinationAsset: usdcOptimism.address,
      };

      const result = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        mockChains,
        mockLogger,
        route.destinationAsset,
      );

      expect(result).toEqual(usdcOptimism);
      // Note: Implementation logs multiple debug messages during lookup
      // Just verify the result is correct
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should find matching asset by tickerHash when destinationAsset not provided', () => {
      const route: { asset: string; origin: number; destination: number; destinationAsset?: string } = {
        asset: usdcArbitrum.address,
        origin: 42161,
        destination: 10,
      };

      const result = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        mockChains,
        mockLogger,
        route.destinationAsset,
      );

      expect(result).toEqual(usdcOptimism);
      // Note: Implementation logs multiple debug messages during lookup
      // Just verify the result is correct
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should return undefined when explicit destinationAsset not found', () => {
      const route = {
        asset: usdtArbitrum.address,
        origin: 42161,
        destination: 10,
        destinationAsset: '0x0000000000000000000000000000000000000000',
      };

      const result = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        mockChains,
        mockLogger,
        route.destinationAsset,
      );

      expect(result).toBeUndefined();
    });

    it('should return undefined when tickerHash match not found', () => {
      const route: { asset: string; origin: number; destination: number; destinationAsset?: string } = {
        asset: usdtArbitrum.address,
        origin: 42161,
        destination: 10,
      };

      const result = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        mockChains,
        mockLogger,
        route.destinationAsset,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('getRouteAssetSymbols', () => {
    it('should return symbols and decimals for same-asset route', () => {
      const route = {
        asset: usdcArbitrum.address,
        origin: 42161,
        destination: 10,
      };

      const result = getRouteAssetSymbols(route, mockChains, mockLogger);

      expect(result).toEqual({
        fromSymbol: 'USDC',
        toSymbol: 'USDC',
        fromDecimals: 6,
        toDecimals: 6,
      });
    });

    it('should return symbols and decimals for cross-asset swap route', () => {
      const route = {
        asset: usdtArbitrum.address,
        origin: 42161,
        destination: 10,
        destinationAsset: usdcOptimism.address,
      };

      const result = getRouteAssetSymbols(route, mockChains, mockLogger);

      expect(result).toEqual({
        fromSymbol: 'USDT',
        toSymbol: 'USDC',
        fromDecimals: 6,
        toDecimals: 6,
      });
    });

    it('should throw error when origin asset not found', () => {
      const route = {
        asset: '0x0000000000000000000000000000000000000000',
        origin: 42161,
        destination: 10,
      };

      expect(() => getRouteAssetSymbols(route, mockChains, mockLogger)).toThrow(
        'Origin asset not found: 0x0000000000000000000000000000000000000000 on chain 42161',
      );
    });

    it('should throw error when destination asset not found', () => {
      const route = {
        asset: usdtArbitrum.address,
        origin: 42161,
        destination: 10,
        destinationAsset: '0x0000000000000000000000000000000000000000',
      };

      expect(() => getRouteAssetSymbols(route, mockChains, mockLogger)).toThrow(
        'Destination asset not found for route',
      );
    });
  });

  describe('validateSwapRoute', () => {
    it('should not throw for same-asset routes', () => {
      const route = {
        asset: usdcArbitrum.address,
        origin: 42161,
        destination: 10,
      };

      expect(() => validateSwapRoute(route, mockChains, mockLogger)).not.toThrow();
    });

    it('should not throw for valid cross-asset swap routes', () => {
      const route = {
        asset: usdtArbitrum.address,
        origin: 42161,
        destination: 10,
        destinationAsset: usdcOptimism.address,
      };

      expect(() => validateSwapRoute(route, mockChains, mockLogger)).not.toThrow();
    });

    it('should throw when origin asset not found', () => {
      const route = {
        asset: '0x0000000000000000000000000000000000000000',
        origin: 42161,
        destination: 10,
        destinationAsset: usdcOptimism.address,
      };

      expect(() => validateSwapRoute(route, mockChains, mockLogger)).toThrow(
        'Invalid swap route: origin asset 0x0000000000000000000000000000000000000000 not found on chain 42161',
      );
    });

    it('should throw when destination asset not found', () => {
      const route = {
        asset: usdtArbitrum.address,
        origin: 42161,
        destination: 10,
        destinationAsset: '0x0000000000000000000000000000000000000000',
      };

      expect(() => validateSwapRoute(route, mockChains, mockLogger)).toThrow(
        'Invalid swap route: destination asset 0x0000000000000000000000000000000000000000 not found on chain 10',
      );
    });

    it('should warn when assets have same tickerHash', () => {
      const route = {
        asset: usdcArbitrum.address,
        origin: 42161,
        destination: 10,
        destinationAsset: usdcOptimism.address,
      };

      validateSwapRoute(route, mockChains, mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Swap route has same tickerHash for origin and destination assets',
        expect.objectContaining({
          route,
          note: 'This may be intentional for same-asset swaps on CEX, but verify config',
        }),
      );
    });
  });
});
