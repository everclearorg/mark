/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  getAssetMapping,
  getDestinationAssetMapping,
  calculateNetAmount,
  validateAssetMapping,
  meetsMinimumWithdrawal,
  generateWithdrawOrderId,
  convertAmountToUSD,
  checkWithdrawQuota,
  parseBinanceTimestamp,
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
  let mockGetAssetConfig: jest.MockedFunction<() => Promise<unknown[]>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAssetConfig = jest.fn();
    mockClient = {
      getPrice: jest.fn(),
      getWithdrawQuota: jest.fn(),
      getAssetConfig: mockGetAssetConfig,
      isConfigured: jest.fn().mockReturnValue(true),
    } as any;
  });

  describe('getAssetMapping', () => {
    it('should handle async call when no mapping found', async () => {
      // Mock DynamicAssetConfig to throw error for unknown asset
      mockGetAssetConfig.mockRejectedValue(new Error('Asset not found'));

      await expect(getAssetMapping(mockClient, mockRoute, {})).rejects.toThrow();
    });
  });

  describe('getDestinationAssetMapping', () => {
    it('should handle async call when origin mapping not found', async () => {
      // Mock DynamicAssetConfig to throw error for unknown asset
      mockGetAssetConfig.mockRejectedValue(new Error('Asset not found'));

      await expect(getDestinationAssetMapping(mockClient, mockRoute, {})).rejects.toThrow();
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

  describe('validateAssetMapping', () => {
    it('should throw error when mapping is not found', async () => {
      // Mock DynamicAssetConfig to throw error for unknown asset
      mockGetAssetConfig.mockRejectedValue(new Error('Asset not found'));

      await expect(validateAssetMapping(mockClient, mockRoute, 'test context', {})).rejects.toThrow();
    });

    it('should throw error when missing symbol or network', async () => {
      // Mock DynamicAssetConfig to return invalid mapping
      const invalidConfigResponse = [
        {
          coin: 'TEST',
          name: 'Test Token',
          networkList: [
            {
              network: 'ETH',
              coin: 'TEST',
              withdrawIntegerMultiple: '0.00000001',
              isDefault: true,
              depositEnable: true,
              withdrawEnable: true,
              depositDesc: '',
              withdrawDesc: '',
              specialTips: '',
              specialWithdrawTips: '',
              name: 'Ethereum',
              resetAddressStatus: false,
              addressRegex: '^(0x)[0-9A-Fa-f]{40}$',
              addressRule: '',
              memoRegex: '',
              withdrawFee: '1000000',
              withdrawMin: '10000000',
              withdrawMax: '100000000000',
              minConfirm: 12,
              unLockConfirm: 12,
              sameAddress: false,
              estimatedArrivalTime: 25,
              busy: false,
              country: '',
              contractAddressUrl: '',
              contractAddress: '',
            },
          ],
        },
      ];

      mockGetAssetConfig.mockResolvedValue(invalidConfigResponse);

      // This will fail when trying to find the asset mapping
      await expect(validateAssetMapping(mockClient, mockRoute, 'test context', {})).rejects.toThrow();
    });

    it('should handle valid asset mapping', async () => {
      // Mock valid response from Binance API
      const validConfigResponse = [
        {
          coin: 'ETH',
          name: 'Ethereum',
          networkList: [
            {
              network: 'ETH',
              coin: 'ETH',
              withdrawIntegerMultiple: '0.00000001',
              isDefault: true,
              depositEnable: true,
              withdrawEnable: true,
              depositDesc: '',
              withdrawDesc: '',
              specialTips: '',
              specialWithdrawTips: '',
              name: 'Ethereum',
              resetAddressStatus: false,
              addressRegex: '^(0x)[0-9A-Fa-f]{40}$',
              addressRule: '',
              memoRegex: '',
              withdrawFee: '5000000000000000',
              withdrawMin: '10000000000000000',
              withdrawMax: '100000000000000000000',
              minConfirm: 12,
              unLockConfirm: 12,
              sameAddress: false,
              estimatedArrivalTime: 25,
              busy: false,
              country: '',
              contractAddressUrl: '',
              contractAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            },
          ],
        },
      ];

      mockGetAssetConfig.mockResolvedValue(validConfigResponse);

      // Use a route that matches the ETH config
      const ethRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      };

      const result = await validateAssetMapping(mockClient, ethRoute, 'test context', {});
      expect(result).toBeDefined();
      expect(result.binanceSymbol).toBe('ETH');
      expect(result.network).toBe('ETH');
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
});
