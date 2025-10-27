/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@mark/logger';
import { BinanceBridgeAdapter } from '../../../src/adapters/binance/binance';
import { BinanceClient } from '../../../src/adapters/binance/client';
import { MarkConfiguration } from '@mark/core';

// Mock dependencies
jest.mock('../../../src/adapters/binance/client');
jest.mock('../../../src/adapters/binance/dynamic-config');
jest.mock('@mark/database');

describe('BinanceBridgeAdapter - Swap Methods', () => {
  let adapter: BinanceBridgeAdapter;
  let mockClient: jest.Mocked<BinanceClient>;
  let mockLogger: jest.Mocked<Logger>;
  let mockConfig: MarkConfiguration;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockConfig = {
      chains: {},
      rebalancing: { routes: [], onDemandRoutes: [] },
    } as any;

    mockClient = {
      getConvertQuote: jest.fn(),
      acceptConvertQuote: jest.fn(),
      getConvertOrderStatus: jest.fn(),
      getConvertExchangeInfo: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
    } as any;

    (BinanceClient as jest.MockedClass<typeof BinanceClient>).mockImplementation(() => mockClient);

    // Mock database is not needed for these tests
    adapter = new BinanceBridgeAdapter('test-key', 'test-secret', 'https://api.binance.com', mockConfig, mockLogger, {} as any);
  });

  describe('supportsSwap', () => {
    it('should return true for supported USDT/USDC pair', async () => {
      const result = await adapter.supportsSwap('USDT', 'USDC');
      expect(result).toBe(true);
    });

    it('should return true for supported USDC/USDT pair', async () => {
      const result = await adapter.supportsSwap('USDC', 'USDT');
      expect(result).toBe(true);
    });

    it('should return true for supported USDT/BUSD pair', async () => {
      const result = await adapter.supportsSwap('USDT', 'BUSD');
      expect(result).toBe(true);
    });

    it('should return false for unsupported pair', async () => {
      const result = await adapter.supportsSwap('BTC', 'ETH');
      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      const mockAdapter = adapter as any;
      mockAdapter.logger.debug = jest.fn().mockImplementation(() => {
        throw new Error('Test error');
      });

      const result = await adapter.supportsSwap('USDT', 'USDC');
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('getSwapQuote', () => {
    it('should get swap quote successfully', async () => {
      const mockQuoteResponse = {
        quoteId: 'test-quote-123',
        ratio: '0.9995',
        inverseRatio: '1.0005',
        validTimestamp: Date.now() + 10000,
        toAmount: '99.95',
        fromAmount: '100',
      };

      mockClient.getConvertQuote.mockResolvedValue(mockQuoteResponse);

      const result = await adapter.getSwapQuote('USDT', 'USDC', '100');

      expect(result).toEqual({
        quoteId: 'test-quote-123',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '100',
        toAmount: '99.95',
        rate: '0.9995',
        validUntil: mockQuoteResponse.validTimestamp,
      });

      expect(mockClient.getConvertQuote).toHaveBeenCalledWith({
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '100',
      });
    });

    it('should throw error when quote fails', async () => {
      mockClient.getConvertQuote.mockRejectedValue(new Error('API error'));

      await expect(adapter.getSwapQuote('USDT', 'USDC', '100')).rejects.toThrow(
        'Failed to get swap quote',
      );
    });
  });

  describe('executeSwap', () => {
    it('should execute swap successfully', async () => {
      const mockQuote = {
        quoteId: 'test-quote-123',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '100',
        toAmount: '99.95',
        rate: '0.9995',
        validUntil: Date.now() + 10000,
      };

      const mockAcceptResponse = {
        orderId: 'order-456',
        createTime: Date.now(),
        orderStatus: 'SUCCESS' as const,
      };

      mockClient.acceptConvertQuote.mockResolvedValue(mockAcceptResponse);

      const result = await adapter.executeSwap(mockQuote);

      expect(result).toEqual({
        orderId: 'order-456',
        quoteId: 'test-quote-123',
        status: 'success',
        executedRate: '0.9995',
      });

      expect(mockClient.acceptConvertQuote).toHaveBeenCalledWith({
        quoteId: 'test-quote-123',
      });
    });

    it('should handle processing status', async () => {
      const mockQuote = {
        quoteId: 'test-quote-123',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '100',
        toAmount: '99.95',
        rate: '0.9995',
        validUntil: Date.now() + 10000,
      };

      const mockAcceptResponse = {
        orderId: 'order-456',
        createTime: Date.now(),
        orderStatus: 'PROCESS' as const,
      };

      mockClient.acceptConvertQuote.mockResolvedValue(mockAcceptResponse);

      const result = await adapter.executeSwap(mockQuote);

      expect(result.status).toBe('processing');
    });

    it('should handle failed status', async () => {
      const mockQuote = {
        quoteId: 'test-quote-123',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '100',
        toAmount: '99.95',
        rate: '0.9995',
        validUntil: Date.now() + 10000,
      };

      const mockAcceptResponse = {
        orderId: 'order-456',
        createTime: Date.now(),
        orderStatus: 'FAIL' as const,
      };

      mockClient.acceptConvertQuote.mockResolvedValue(mockAcceptResponse);

      const result = await adapter.executeSwap(mockQuote);

      expect(result.status).toBe('failed');
    });

    it('should throw error when execution fails', async () => {
      const mockQuote = {
        quoteId: 'test-quote-123',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '100',
        toAmount: '99.95',
        rate: '0.9995',
        validUntil: Date.now() + 10000,
      };

      mockClient.acceptConvertQuote.mockRejectedValue(new Error('API error'));

      await expect(adapter.executeSwap(mockQuote)).rejects.toThrow('Failed to execute swap');
    });
  });

  describe('getSwapStatus', () => {
    it('should get swap status successfully', async () => {
      const mockStatusResponse = {
        orderId: 'order-456',
        orderStatus: 'SUCCESS' as const,
        fromAsset: 'USDT',
        fromAmount: '100',
        toAsset: 'USDC',
        toAmount: '99.95',
        ratio: '0.9995',
        inverseRatio: '1.0005',
        createTime: 1234567890,
      };

      mockClient.getConvertOrderStatus.mockResolvedValue(mockStatusResponse);

      const result = await adapter.getSwapStatus('order-456');

      expect(result).toEqual({
        orderId: 'order-456',
        status: 'success',
        fromAsset: 'USDT',
        toAsset: 'USDC',
        fromAmount: '100',
        toAmount: '99.95',
        executedAt: 1234567890,
      });

      expect(mockClient.getConvertOrderStatus).toHaveBeenCalledWith({
        orderId: 'order-456',
      });
    });

    it('should handle processing status', async () => {
      const mockStatusResponse = {
        orderId: 'order-456',
        orderStatus: 'PROCESS' as const,
        fromAsset: 'USDT',
        fromAmount: '100',
        toAsset: 'USDC',
        toAmount: '99.95',
        ratio: '0.9995',
        inverseRatio: '1.0005',
        createTime: 1234567890,
      };

      mockClient.getConvertOrderStatus.mockResolvedValue(mockStatusResponse);

      const result = await adapter.getSwapStatus('order-456');

      expect(result.status).toBe('processing');
    });

    it('should handle failed status', async () => {
      const mockStatusResponse = {
        orderId: 'order-456',
        orderStatus: 'FAIL' as const,
        fromAsset: 'USDT',
        fromAmount: '100',
        toAsset: 'USDC',
        toAmount: '99.95',
        ratio: '0.9995',
        inverseRatio: '1.0005',
        createTime: 1234567890,
      };

      mockClient.getConvertOrderStatus.mockResolvedValue(mockStatusResponse);

      const result = await adapter.getSwapStatus('order-456');

      expect(result.status).toBe('failed');
    });

    it('should throw error when status check fails', async () => {
      mockClient.getConvertOrderStatus.mockRejectedValue(new Error('API error'));

      await expect(adapter.getSwapStatus('order-456')).rejects.toThrow('Failed to get swap status');
    });
  });

  describe('getSwapExchangeInfo', () => {
    it('should fetch and return swap exchange info', async () => {
      const mockExchangeInfo = [
        {
          fromAsset: 'USDT',
          toAsset: 'USDC',
          fromAssetMinAmount: '1',
          fromAssetMaxAmount: '1000000',
        },
        {
          fromAsset: 'USDC',
          toAsset: 'USDT',
          fromAssetMinAmount: '1',
          fromAssetMaxAmount: '1000000',
        },
      ];

      (mockClient.getConvertExchangeInfo as any).mockResolvedValue(mockExchangeInfo);

      const result = await adapter.getSwapExchangeInfo('USDT', 'USDC');

      expect(result).toEqual({
        minAmount: '1',
        maxAmount: '1000000',
      });

      expect(mockClient.getConvertExchangeInfo as any).toHaveBeenCalledTimes(1);
    });

    it('should use cached data on subsequent calls', async () => {
      const mockExchangeInfo = [
        {
          fromAsset: 'USDT',
          toAsset: 'USDC',
          fromAssetMinAmount: '1',
          fromAssetMaxAmount: '1000000',
        },
      ];

      (mockClient.getConvertExchangeInfo as any).mockResolvedValue(mockExchangeInfo);

      // First call - should fetch
      const result1 = await adapter.getSwapExchangeInfo('USDT', 'USDC');
      expect(result1.minAmount).toBe('1');
      expect(mockClient.getConvertExchangeInfo as any).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result2 = await adapter.getSwapExchangeInfo('USDT', 'USDC');
      expect(result2.minAmount).toBe('1');
      expect(mockClient.getConvertExchangeInfo as any).toHaveBeenCalledTimes(1); // Still 1, used cache
    });

    it('should throw error when pair not found', async () => {
      (mockClient.getConvertExchangeInfo as any).mockResolvedValue([
        {
          fromAsset: 'BTC',
          toAsset: 'ETH',
          fromAssetMinAmount: '0.001',
          fromAssetMaxAmount: '10',
        },
      ]);

      await expect(adapter.getSwapExchangeInfo('USDT', 'USDC')).rejects.toThrow(
        'No swap pair found for USDT/USDC',
      );
    });

    it('should throw error when API call fails', async () => {
      (mockClient.getConvertExchangeInfo as any).mockRejectedValue(new Error('API error'));

      await expect(adapter.getSwapExchangeInfo('USDT', 'USDC')).rejects.toThrow('Failed to get swap exchange info');
    });
  });
});
