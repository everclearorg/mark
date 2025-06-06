/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { SupportedBridge, RebalanceRoute, ChainConfiguration, AssetConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { TransactionReceipt } from 'viem';
import { BinanceBridgeAdapter } from '../../../src/adapters/binance/binance';
import { BinanceClient } from '../../../src/adapters/binance/client';
import { DepositAddress, WithdrawResponse } from '../../../src/adapters/binance/types';

// Mock the external dependencies
jest.mock('../../../src/adapters/binance/client');

// Test adapter that exposes private methods
class TestBinanceBridgeAdapter extends BinanceBridgeAdapter {
  public handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    return super.handleError(error, context, metadata);
  }

  public getWithdrawalAddress(route: RebalanceRoute): string {
    return super.getWithdrawalAddress(route);
  }

  public getWithdrawalStatus(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string
  ): Promise<any> {
    return super.getWithdrawalStatus(route, originTransaction, amount);
  }
}

// Mock the Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

// Mock data for testing
const mockAssets: Record<string, AssetConfiguration> = {
    ETH: {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH',
        decimals: 18,
        tickerHash: '0xETHHash',
        isNative: true,
        balanceThreshold: '0',
    },
    WETH: {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        symbol: 'WETH',
        decimals: 18,
        tickerHash: '0xWETHHash',
        isNative: false,
        balanceThreshold: '0',
    },
    USDC: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: 18,
        tickerHash: '0xUSDCHash',
        isNative: false,
        balanceThreshold: '0',
    },
};

const mockChains: Record<string, any> = {
    '1': {
        assets: Object.values(mockAssets),
        providers: ['https://base-mainnet.example.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        gnosisSafeAddress: '0xe569ea3158bB89aD5CFD8C06f0ccB3aD69e0916B',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
    '10': {
        assets: Object.values(mockAssets),
        providers: ['https://opt-mainnet.example.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        gnosisSafeAddress: '0xe569ea3158bB89aD5CFD8C06f0ccB3aD69e0916B',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
    '42161': {
        assets: Object.values(mockAssets),
        providers: ['https://arb-mainnet.example.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        gnosisSafeAddress: '0xe569ea3158bB89aD5CFD8C06f0ccB3aD69e0916B',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
};

// Mock API responses
const mockDepositAddress: DepositAddress = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  coin: 'ETH',
  tag: '',
  url: 'https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};

const mockWithdrawResponse: WithdrawResponse = {
  id: 'withdraw-123456',
};

// Mock BinanceClient implementation
const mockBinanceClient = {
  isConfigured: jest.fn<() => boolean>().mockReturnValue(true),
  getDepositAddress: jest.fn<() => Promise<DepositAddress>>().mockResolvedValue(mockDepositAddress),
  withdraw: jest.fn<() => Promise<WithdrawResponse>>().mockResolvedValue(mockWithdrawResponse),
  getDepositHistory: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  getWithdrawHistory: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
};

describe('BinanceBridgeAdapter', () => {
  let adapter: TestBinanceBridgeAdapter;

  const sampleRoute: RebalanceRoute = {
    origin: 1,
    destination: 42161,
    asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  };

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Reset BinanceClient mock implementation
    (BinanceClient as jest.MockedClass<typeof BinanceClient>).mockImplementation(() => mockBinanceClient as any);

    // Reset logger mocks
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    // Create fresh adapter instance
    adapter = new TestBinanceBridgeAdapter(
      'test-api-key',
      'test-api-secret',
      'https://api.binance.com',
      mockChains,
      mockLogger
    );
  });

  afterEach(() => {
    // Clean up after tests
  });

  describe('constructor', () => {
    it('should initialize correctly with valid credentials', () => {
      expect(adapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Initializing BinanceBridgeAdapter', {
        baseUrl: 'https://api.binance.com',
        hasApiKey: true,
        hasApiSecret: true,
      });
    });

    it('should throw error if API key is missing', () => {
      // Mock client.isConfigured to return false for empty credentials
      (BinanceClient as jest.MockedClass<typeof BinanceClient>).mockImplementationOnce(() => ({
        ...mockBinanceClient,
        isConfigured: jest.fn().mockReturnValue(false),
      }) as any);

      expect(() => {
        new TestBinanceBridgeAdapter(
          '',
          'test-api-secret',
          'https://api.binance.com',
          mockChains,
          mockLogger
        );
      }).toThrow('Binance adapter requires API key and secret');
    });

    it('should throw error if API secret is missing', () => {
      // Mock client.isConfigured to return false for empty credentials
      (BinanceClient as jest.MockedClass<typeof BinanceClient>).mockImplementationOnce(() => ({
        ...mockBinanceClient,
        isConfigured: jest.fn().mockReturnValue(false),
      }) as any);

      expect(() => {
        new TestBinanceBridgeAdapter(
          'test-api-key',
          '',
          'https://api.binance.com',
          mockChains,
          mockLogger
        );
      }).toThrow('Binance adapter requires API key and secret');
    });
  });

  describe('type', () => {
    it('should return the correct type', () => {
      expect(adapter.type()).toBe(SupportedBridge.Binance);
    });
  });

  describe('getReceivedAmount', () => {
    it('should calculate received amount correctly for WETH after subtracting withdrawal fees', async () => {
      const amount = '1000000000000000000'; // 1 ETH in wei
      
      const result = await adapter.getReceivedAmount(amount, sampleRoute);
      
      // Expected: 1 ETH - 0.001 ETH (Arbitrum withdrawal fee) = 0.999 ETH
      expect(result).toBe('999000000000000000');
    });

    it('should reject amounts that are too low', async () => {
      const amount = '1000'; // Very small amount below minimum
      
      await expect(adapter.getReceivedAmount(amount, sampleRoute))
        .rejects.toThrow('Amount is too low for Binance withdrawal');
    });

    it('should throw error for unsupported asset', async () => {
      const unsupportedRoute: RebalanceRoute = {
        ...sampleRoute,
        asset: '0xUnsupportedAsset',
      };
      
      await expect(adapter.getReceivedAmount('1000000000000000000', unsupportedRoute))
        .rejects.toThrow('Failed to calculate received amount');
    });
  });

  describe('send', () => {
    it('should prepare deposit transaction correctly for WETH', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000'; // 1 ETH

      const result = await adapter.send(sender, recipient, amount, sampleRoute);

      expect(result).toEqual({
        to: mockDepositAddress.address,
        value: BigInt(0), // ERC20 transfer, not native ETH
        data: expect.any(String), // ERC20 transfer encoded data
      });

      // Verify deposit address was requested
      expect(mockBinanceClient.getDepositAddress).toHaveBeenCalledWith('ETH', 'ETH');
    });

    it('should throw error if amount is too low', async () => {
      const amount = '1000'; // Very small amount
      
      await expect(adapter.send('0xsender', '0xrecipient', amount, sampleRoute))
        .rejects.toThrow('does not meet minimum withdrawal requirement');
    });

    it('should throw error if getDepositAddress fails', async () => {
      mockBinanceClient.getDepositAddress.mockRejectedValueOnce(new Error('API error'));
      
      await expect(adapter.send('0xsender', '0xrecipient', '1000000000000000000', sampleRoute))
        .rejects.toThrow('Failed to prepare Binance deposit transaction');
    });
  });

  describe('readyOnDestination', () => {
    let mockTransaction: TransactionReceipt;

    beforeEach(() => {
      mockTransaction = {
        transactionHash: '0x123' as `0x${string}`,
        blockNumber: BigInt(123),
        blockHash: '0xabc' as `0x${string}`,
        transactionIndex: 0,
        contractAddress: null,
        cumulativeGasUsed: BigInt(21000),
        effectiveGasPrice: BigInt(20000000000),
        from: '0xfrom' as `0x${string}`,
        gasUsed: BigInt(21000),
        logs: [],
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        to: '0xto' as `0x${string}`,
        type: 'legacy' as const,
      };
    });

    it('should work without caching recipients', async () => {
      const amount = '1000000000000000000';

      // Mock getWithdrawalStatus to return undefined (not ready)
      jest.spyOn(adapter, 'getWithdrawalStatus').mockResolvedValueOnce(undefined);

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);
      expect(result).toBe(false);
    });

    it('should return false when withdrawal status is not ready', async () => {
      const amount = '1000000000000000000';

      // Mock getWithdrawalStatus to return a status that's not completed
      jest.spyOn(adapter, 'getWithdrawalStatus').mockResolvedValueOnce({
        status: 'pending',
        onChainConfirmed: false,
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);

      expect(result).toBe(false);
    });

    it('should return true when withdrawal is completed and confirmed', async () => {
      const amount = '1000000000000000000';

      // Mock getWithdrawalStatus to return completed status
      jest.spyOn(adapter, 'getWithdrawalStatus').mockResolvedValueOnce({
        status: 'completed',
        onChainConfirmed: true,
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);

      expect(result).toBe(true);
    });
  });

  describe('destinationCallback', () => {
    it('should return undefined as Binance handles withdrawals automatically', async () => {
      const mockTransaction: TransactionReceipt = {
        transactionHash: '0x123' as `0x${string}`,
        blockNumber: BigInt(123),
        blockHash: '0xabc' as `0x${string}`,
        transactionIndex: 0,
        contractAddress: null,
        cumulativeGasUsed: BigInt(21000),
        effectiveGasPrice: BigInt(20000000000),
        from: '0xfrom' as `0x${string}`,
        gasUsed: BigInt(21000),
        logs: [],
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        to: '0xto' as `0x${string}`,
        type: 'legacy' as const,
      };

      const result = await adapter.destinationCallback(sampleRoute, mockTransaction);
      expect(result).toBeUndefined();
    });
  });

  describe('private methods', () => {
    describe('handleError', () => {
      it('should log and throw error with context', () => {
        const error = new Error('Test error');
        const context = 'test operation';
        const metadata = { test: 'data' };

        expect(() => adapter.handleError(error, context, metadata)).toThrow('Failed to test operation: Test error');

        expect(mockLogger.error).toHaveBeenCalledWith('Failed to test operation', {
          error: jsonifyError(error),
          test: 'data',
        });
      });
    });

    describe('withdrawal address functionality', () => {
      it('should get withdrawal address from chain configuration', () => {
        const address = adapter.getWithdrawalAddress(sampleRoute);
        expect(address).toBe('0xe569ea3158bB89aD5CFD8C06f0ccB3aD69e0916B');
      });

      it('should throw error if destination chain not configured', () => {
        const invalidRoute = { ...sampleRoute, destination: 999999 };
        expect(() => adapter.getWithdrawalAddress(invalidRoute))
          .toThrow('No chain configuration found for destination chain 999999');
      });

      it('should throw error if no gnosis safe address configured', () => {
        // Create adapter with chain that has no gnosis safe address
        const chainsWithoutGnosis = {
          ...mockChains,
          '42161': {
            ...mockChains['42161'],
            gnosisSafeAddress: undefined,
          },
        };
        
        const adapterWithoutGnosis = new TestBinanceBridgeAdapter(
          'test-api-key',
          'test-api-secret',
          'https://api.binance.com',
          chainsWithoutGnosis,
          mockLogger
        );
        
        expect(() => adapterWithoutGnosis.getWithdrawalAddress(sampleRoute))
          .toThrow('No gnosis safe address configured for destination chain 42161');
      });
    });
  });

  describe('integration tests', () => {
    it('should handle complete send-to-ready flow', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000';
      const mockTransaction: TransactionReceipt = {
        transactionHash: '0x123' as `0x${string}`,
        blockNumber: BigInt(123),
        blockHash: '0xabc' as `0x${string}`,
        transactionIndex: 0,
        contractAddress: null,
        cumulativeGasUsed: BigInt(21000),
        effectiveGasPrice: BigInt(20000000000),
        from: sender as `0x${string}`,
        gasUsed: BigInt(21000),
        logs: [],
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        to: '0xto' as `0x${string}`,
        type: 'legacy' as const,
      };

      // 1. Send transaction
      const sendResult = await adapter.send(sender, recipient, amount, sampleRoute);
      expect(sendResult.to).toBe(mockDepositAddress.address);

      // 2. Check readyOnDestination (should not be ready initially)
      jest.spyOn(adapter, 'getWithdrawalStatus').mockResolvedValueOnce({
        status: 'pending',
        onChainConfirmed: false,
      });

      const ready1 = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);
      expect(ready1).toBe(false);

      // 3. Check again when withdrawal is complete
      jest.spyOn(adapter, 'getWithdrawalStatus').mockResolvedValueOnce({
        status: 'completed',
        onChainConfirmed: true,
      });

      const ready2 = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);
      expect(ready2).toBe(true);
    });

    it('should be properly exported from main adapter', () => {
      const { RebalanceAdapter } = require('../../../src/adapters');
      const mockLogger = { debug: jest.fn() } as unknown as Logger;
      
      const rebalanceAdapter = new RebalanceAdapter('mainnet', {}, mockLogger);
      
      // This should not throw an error for Binance
      expect(() => {
        // We expect this to throw due to missing env vars, but not due to unknown adapter type
        try {
          rebalanceAdapter.getAdapter(SupportedBridge.Binance);
        } catch (error) {
          // Should fail due to missing API credentials, not unknown adapter
          expect((error as Error).message).not.toContain('Unsupported adapter type');
        }
      }).not.toThrow();
    });
  });
}); 