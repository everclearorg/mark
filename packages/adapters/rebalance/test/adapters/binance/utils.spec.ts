/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  getAssetMapping,
  getDestinationAssetMapping,
  getAsset,
  findMatchingDestinationAsset,
  calculateNetAmount,
  formatAmount,
  validateAssetMapping,
  meetsMinimumWithdrawal,
  generateWithdrawOrderId,
  convertAmountToUSD,
  checkWithdrawQuota,
  parseBinanceTimestamp,
  isWithdrawalStale,
} from '../../../src/adapters/binance/utils';
import { BinanceAssetMapping } from '../../../src/adapters/binance/types';
import { RebalanceRoute, ChainConfiguration } from '@mark/core';
import { BinanceClient } from '../../../src/adapters/binance/client';

// Mock the BinanceClient
jest.mock('../../../src/adapters/binance/client');

// Mock data for testing
const mockRoute: RebalanceRoute = {
  origin: 999,
  destination: 1,
  asset: '0xUnknownAsset',
};

const mockChainConfig: ChainConfiguration = {
  providers: [],
  assets: [],
  invoiceAge: 0,
  gasThreshold: '0',
  deployments: {
    everclear: '0x',
    permit2: '0x',
    multicall3: '0x',
  },
};

const mockAssetMapping: BinanceAssetMapping = {
  chainId: 1,
  onChainAddress: '0xAsset',
  binanceSymbol: 'TEST',
  network: 'ETH',
  withdrawalFee: '100',
  minWithdrawalAmount: '1000',
  depositConfirmations: 12,
};

describe('Binance Utils', () => {
  let mockClient: jest.Mocked<BinanceClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      getPrice: jest.fn(),
      getWithdrawQuota: jest.fn(),
    } as any;
  });

  describe('getAssetMapping', () => {
    it('should return undefined when no mapping found', () => {
      const result = getAssetMapping(mockRoute);
      expect(result).toBeUndefined();
    });
  });

  describe('getDestinationAssetMapping', () => {
    it('should return undefined when origin mapping not found', () => {
      const result = getDestinationAssetMapping(mockRoute);
      expect(result).toBeUndefined();
    });
  });

  describe('getAsset', () => {
    it('should return undefined when chain not found', () => {
      const chains: Record<string, ChainConfiguration> = {};
      const result = getAsset('0xAsset', 999, chains);
      expect(result).toBeUndefined();
    });

    it('should return undefined when asset not found in chain', () => {
      const chains: Record<string, ChainConfiguration> = {
        '1': mockChainConfig,
      };
      const result = getAsset('0xAsset', 1, chains);
      expect(result).toBeUndefined();
    });
  });

  describe('findMatchingDestinationAsset', () => {
    it('should return undefined when origin asset not found', () => {
      const chains: Record<string, ChainConfiguration> = {};
      const result = findMatchingDestinationAsset('0xAsset', 1, 137, chains);
      expect(result).toBeUndefined();
    });

    it('should return undefined when destination chain not found', () => {
      const chains: Record<string, ChainConfiguration> = {
        '1': {
          ...mockChainConfig,
          assets: [{
            address: '0xAsset',
            symbol: 'TEST',
            decimals: 18,
            tickerHash: '0x',
            isNative: false,
            balanceThreshold: '0',
          }],
        },
      };
      const result = findMatchingDestinationAsset('0xAsset', 1, 999, chains);
      expect(result).toBeUndefined();
    });

    it('should return undefined when no matching asset on destination', () => {
      const chains: Record<string, ChainConfiguration> = {
        '1': {
          ...mockChainConfig,
          assets: [{
            address: '0xAsset',
            symbol: 'TEST',
            decimals: 18,
            tickerHash: '0x',
            isNative: false,
            balanceThreshold: '0',
          }],
        },
        '137': {
          ...mockChainConfig,
          assets: [{
            address: '0xOtherAsset',
            symbol: 'OTHER',
            decimals: 18,
            tickerHash: '0x',
            isNative: false,
            balanceThreshold: '0',
          }],
        },
      };
      const result = findMatchingDestinationAsset('0xAsset', 1, 137, chains);
      expect(result).toBeUndefined();
    });
  });

  describe('calculateNetAmount', () => {
    it('should throw error when amount is too small', () => {
      expect(() => calculateNetAmount('100', '200')).toThrow('Amount is too small to cover withdrawal fees');
    });

    it('should throw error when amount equals fee', () => {
      expect(() => calculateNetAmount('100', '100')).toThrow('Amount is too small to cover withdrawal fees');
    });
  });

  describe('formatAmount', () => {
    it('should format amount without decimals when no fractional part', () => {
      const result = formatAmount('1000000000000000000', 18);
      expect(result).toBe('1');
    });

    it('should format amount with fractional part', () => {
      const result = formatAmount('1500000000000000000', 18);
      expect(result).toBe('1.5');
    });

    it('should remove trailing zeros from fractional part', () => {
      const result = formatAmount('1100000000000000000', 18);
      expect(result).toBe('1.1');
    });
  });

  describe('validateAssetMapping', () => {
    it('should throw error when mapping is undefined', () => {
      expect(() => validateAssetMapping(undefined, 'test context'))
        .toThrow('No Binance asset mapping found for test context');
    });

    it('should throw error when missing symbol or network', () => {
      const invalidMapping: BinanceAssetMapping = {
        ...mockAssetMapping,
        binanceSymbol: '',
      };
      expect(() => validateAssetMapping(invalidMapping, 'test context'))
        .toThrow('Invalid Binance asset mapping for test context: missing symbol or network');
    });

    it('should throw error when missing fee configuration', () => {
      const invalidMapping: BinanceAssetMapping = {
        ...mockAssetMapping,
        withdrawalFee: '',
      };
      expect(() => validateAssetMapping(invalidMapping, 'test context'))
        .toThrow('Invalid Binance asset mapping for test context: missing fee configuration');
    });
  });

  describe('meetsMinimumWithdrawal', () => {
    it('should return true when amount meets minimum', () => {
      const result = meetsMinimumWithdrawal('2000', mockAssetMapping);
      expect(result).toBe(true);
    });

    it('should return false when amount is below minimum', () => {
      const result = meetsMinimumWithdrawal('500', mockAssetMapping);
      expect(result).toBe(false);
    });
  });

  describe('generateWithdrawOrderId', () => {
    it('should generate deterministic order ID', () => {
      const txHash = '0x1234567890abcdef';
      const result = generateWithdrawOrderId(mockRoute, txHash);
      expect(result).toBe('mark-12345678-999-1-Unknow');
    });
  });

  describe('convertAmountToUSD', () => {
    it('should return amount directly for USDT', async () => {
      const result = await convertAmountToUSD('1000000', 'USDT', 6, mockClient);
      expect(result).toBe(1);
      expect(mockClient.getPrice).not.toHaveBeenCalled();
    });

    it('should return amount directly for USDC', async () => {
      const result = await convertAmountToUSD('1000000', 'USDC', 6, mockClient);
      expect(result).toBe(1);
      expect(mockClient.getPrice).not.toHaveBeenCalled();
    });

    it('should fetch price and calculate USD value for other assets', async () => {
      mockClient.getPrice.mockResolvedValue({ symbol: 'ETHUSDT', price: '2000' });
      const result = await convertAmountToUSD('1000000000000000000', 'ETH', 18, mockClient);
      expect(result).toBe(2000);
      expect(mockClient.getPrice).toHaveBeenCalledWith('ETHUSDT');
    });
  });

  describe('checkWithdrawQuota', () => {
    it('should check withdrawal quota and return allowed status', async () => {
      mockClient.getWithdrawQuota.mockResolvedValue({
        wdQuota: '10000',
        usedWdQuota: '1000',
      });
      mockClient.getPrice.mockResolvedValue({ symbol: 'ETHUSDT', price: '2000' });
      
      const result = await checkWithdrawQuota('1000000000000000000', 'ETH', 18, mockClient);
      
      expect(result).toEqual({
        allowed: true,
        remainingQuotaUSD: 9000,
        amountUSD: 2000,
      });
    });

    it('should return not allowed when amount exceeds quota', async () => {
      mockClient.getWithdrawQuota.mockResolvedValue({
        wdQuota: '10000',
        usedWdQuota: '9000',
      });
      mockClient.getPrice.mockResolvedValue({ symbol: 'ETHUSDT', price: '2000' });
      
      const result = await checkWithdrawQuota('1000000000000000000', 'ETH', 18, mockClient);
      
      expect(result).toEqual({
        allowed: false,
        remainingQuotaUSD: 1000,
        amountUSD: 2000,
      });
    });
  });

  describe('parseBinanceTimestamp', () => {
    it('should parse numeric timestamp', () => {
      const timestamp = 1624564800000;
      const result = parseBinanceTimestamp(timestamp);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(timestamp);
    });

    it('should parse string timestamp', () => {
      const timestamp = '1624564800000';
      const result = parseBinanceTimestamp(timestamp);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(1624564800000);
    });
  });

  describe('isWithdrawalStale', () => {
    it('should return false for recent withdrawal', () => {
      const recentDate = new Date();
      const result = isWithdrawalStale(recentDate.toISOString());
      expect(result).toBe(false);
    });

    it('should return true for stale withdrawal', () => {
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 25);
      const result = isWithdrawalStale(oldDate.toISOString());
      expect(result).toBe(true);
    });

    it('should respect custom max hours', () => {
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 13);
      const result = isWithdrawalStale(oldDate.toISOString(), 12);
      expect(result).toBe(true);
    });
  });
});