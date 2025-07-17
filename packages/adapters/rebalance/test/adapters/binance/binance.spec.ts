/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { SupportedBridge, RebalanceRoute, AssetConfiguration, MarkConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';
import { TransactionReceipt } from 'viem';
import { BinanceBridgeAdapter } from '../../../src/adapters/binance/binance';
import { BinanceClient } from '../../../src/adapters/binance/client';
import { DynamicAssetConfig } from '../../../src/adapters/binance/dynamic-config';
import { DepositAddress, WithdrawResponse, BinanceAssetMapping } from '../../../src/adapters/binance/types';
import { RebalanceTransactionMemo } from '../../../src/types';
import { RebalanceAdapter } from '../../../src/adapters';

// Mock the external dependencies
jest.mock('../../../src/adapters/binance/client');
jest.mock('../../../src/adapters/binance/dynamic-config');

// Test adapter that exposes private methods
class TestBinanceBridgeAdapter extends BinanceBridgeAdapter {
  public handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    return super.handleError(error, context, metadata);
  }

  public getOrInitWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    recipient: string,
  ): Promise<any> {
    return super.getOrInitWithdrawal(route, originTransaction, amount, recipient);
  }
}

// Mock the Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

// Mock the cache
const mockRebalanceCache = {
  getRebalances: jest.fn(),
  addRebalances: jest.fn(),
  removeRebalances: jest.fn(),
  hasRebalance: jest.fn(),
  setPause: jest.fn(),
  isPaused: jest.fn(),
  getRebalanceByTransaction: jest.fn(),
} as unknown as jest.Mocked<RebalanceCache>;

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
  USDT: {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    symbol: 'USDT',
    decimals: 6,
    tickerHash: '0xUSDTHash',
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
    assets: [
      ...Object.values(mockAssets),
      {
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        symbol: 'WETH',
        decimals: 18,
        tickerHash: '0xWETHHash',
        isNative: false,
        balanceThreshold: '0',
      },
    ],
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
  '56': {
    assets: [
      {
        address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        symbol: 'ETH',
        decimals: 18,
        tickerHash: '0xWETHHash',
        isNative: false,
        balanceThreshold: '0',
      },
    ],
    providers: ['https://bsc-mainnet.example.com'],
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

// Mock configuration object
const mockConfig: MarkConfiguration = {
  pushGatewayUrl: 'http://localhost:9091',
  web3SignerUrl: 'http://localhost:8545',
  everclearApiUrl: 'http://localhost:3000',
  relayer: {
    url: 'http://localhost:8080',
  },
  binance: {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
  },
  redis: {
    host: 'localhost',
    port: 6379,
  },
  ownAddress: '0x1234567890123456789012345678901234567890',
  stage: 'development',
  environment: 'mainnet',
  logLevel: 'debug',
  supportedSettlementDomains: [1, 42161],
  forceOldestInvoice: false,
  supportedAssets: ['ETH', 'WETH', 'USDC', 'USDT'],
  chains: mockChains,
  hub: {
    domain: '25327',
    providers: ['http://localhost:8545'],
  },
  routes: [],
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

// Mock asset mappings for testing
const mockETHMapping: BinanceAssetMapping = {
  chainId: 1,
  binanceSymbol: 'ETH',
  network: 'ETH',
  binanceAsset: '0x0000000000000000000000000000000000000000',
  minWithdrawalAmount: '10000000000000000', // 0.01 ETH in wei
  withdrawalFee: '40000000000000000', // 0.04 ETH in wei
  depositConfirmations: 12,
};

const mockETHArbitrumMapping: BinanceAssetMapping = {
  chainId: 42161,
  binanceSymbol: 'ETH',
  network: 'ARBITRUM',
  binanceAsset: '0x0000000000000000000000000000000000000000',
  minWithdrawalAmount: '10000000000000000', // 0.01 ETH in wei
  withdrawalFee: '40000000000000000', // 0.00004 ETH in wei
  depositConfirmations: 12,
};

const mockUSDCMapping: BinanceAssetMapping = {
  chainId: 1,
  binanceSymbol: 'USDC',
  network: 'ETH',
  binanceAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  minWithdrawalAmount: '1000000', // 1 USDC in smallest units (6 decimals)
  withdrawalFee: '1000000', // 1 USDC fee
  depositConfirmations: 12,
};

// Mock BinanceClient implementation
const mockBinanceClient = {
  isConfigured: jest.fn<() => boolean>().mockReturnValue(true),
  isSystemOperational: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  getDepositAddress: jest.fn<() => Promise<DepositAddress>>().mockResolvedValue(mockDepositAddress),
  withdraw: jest.fn<() => Promise<WithdrawResponse>>().mockResolvedValue(mockWithdrawResponse),
  getDepositHistory: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  getWithdrawHistory: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  getWithdrawQuota: jest.fn<() => Promise<{ wdQuota: string; usedWdQuota: string }>>().mockResolvedValue({
    wdQuota: '8000000',
    usedWdQuota: '1000000',
  }),
  getPrice: jest.fn<() => Promise<{ symbol: string; price: string }>>().mockResolvedValue({
    symbol: 'ETHUSDT',
    price: '2000',
  }),
  getAssetConfig: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
};

// Mock DynamicAssetConfig implementation
const mockDynamicAssetConfig = {
  getAssetMapping: jest.fn<(chainId: number, assetIdentifier: string) => Promise<BinanceAssetMapping>>(),
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

    // Reset DynamicAssetConfig mock implementation
    (DynamicAssetConfig as jest.MockedClass<typeof DynamicAssetConfig>).mockImplementation(
      () => mockDynamicAssetConfig as any,
    );

    // Set up default asset mapping responses
    mockDynamicAssetConfig.getAssetMapping.mockImplementation(async (chainId: number, assetIdentifier: string) => {
      const lowerIdentifier = assetIdentifier.toLowerCase();

      // Handle by address
      if (lowerIdentifier.startsWith('0x')) {
        // Native ETH (zero address)
        if (lowerIdentifier === '0x0000000000000000000000000000000000000000') {
          if (chainId === 1) {
            return { ...mockETHMapping, userAsset: assetIdentifier };
          }
          if (chainId === 42161) {
            return { ...mockETHArbitrumMapping, userAsset: assetIdentifier };
          }
        }
        // ETH/WETH mappings
        if (lowerIdentifier === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') {
          if (chainId === 1) {
            return mockETHMapping;
          }
          if (chainId === 42161) {
            return { ...mockETHArbitrumMapping, userAsset: assetIdentifier };
          }
        }
        // Arbitrum WETH
        if (chainId === 42161 && lowerIdentifier === '0x82af49447d8a07e3bd95bd0d56f35241523fbab1') {
          return mockETHArbitrumMapping;
        }
        // USDC mappings
        if (lowerIdentifier === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
          if (chainId === 1) {
            return mockUSDCMapping;
          }
          if (chainId === 42161) {
            return { ...mockUSDCMapping, chainId: 42161, network: 'ARBITRUM', userAsset: assetIdentifier };
          }
        }
      }
      // Handle by symbol
      else {
        if (assetIdentifier === 'WETH') {
          if (chainId === 1) {
            return mockETHMapping;
          }
          if (chainId === 42161) {
            return mockETHArbitrumMapping;
          }
        }
        if (assetIdentifier === 'USDC') {
          if (chainId === 1) {
            return mockUSDCMapping;
          }
          if (chainId === 42161) {
            return {
              ...mockUSDCMapping,
              chainId: 42161,
              network: 'ARBITRUM',
              userAsset: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
            };
          }
        }
      }

      throw new Error(`No mapping found for chain ${chainId}, identifier ${assetIdentifier}`);
    });

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
      mockConfig,
      mockLogger,
      mockRebalanceCache,
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
      (BinanceClient as jest.MockedClass<typeof BinanceClient>).mockImplementationOnce(
        () =>
          ({
            ...mockBinanceClient,
            isConfigured: jest.fn().mockReturnValue(false),
          }) as any,
      );

      // Mock DynamicAssetConfig for this test
      (DynamicAssetConfig as jest.MockedClass<typeof DynamicAssetConfig>).mockImplementationOnce(
        () => mockDynamicAssetConfig as any,
      );

      expect(() => {
        new TestBinanceBridgeAdapter(
          '',
          'test-api-secret',
          'https://api.binance.com',
          mockConfig,
          mockLogger,
          mockRebalanceCache,
        );
      }).toThrow('Binance adapter requires API key and secret');
    });

    it('should throw error if API secret is missing', () => {
      // Mock client.isConfigured to return false for empty credentials
      (BinanceClient as jest.MockedClass<typeof BinanceClient>).mockImplementationOnce(
        () =>
          ({
            ...mockBinanceClient,
            isConfigured: jest.fn().mockReturnValue(false),
          }) as any,
      );

      // Mock DynamicAssetConfig for this test
      (DynamicAssetConfig as jest.MockedClass<typeof DynamicAssetConfig>).mockImplementationOnce(
        () => mockDynamicAssetConfig as any,
      );

      expect(() => {
        new TestBinanceBridgeAdapter(
          'test-api-key',
          '',
          'https://api.binance.com',
          mockConfig,
          mockLogger,
          mockRebalanceCache,
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

      // Expected: 1 ETH - 0.04 ETH (Arbitrum withdrawal fee) = 0.96 ETH
      expect(result).toBe('960000000000000000');
    });

    it('should reject amounts that are too low', async () => {
      const amount = '1000'; // Very small amount below minimum

      await expect(adapter.getReceivedAmount(amount, sampleRoute)).rejects.toThrow(
        'Amount is too low for Binance withdrawal',
      );
    });

    it('should throw error for unsupported asset', async () => {
      const unsupportedRoute: RebalanceRoute = {
        ...sampleRoute,
        asset: '0xUnsupportedAsset',
      };

      // Mock dynamic config to throw error for unsupported asset
      mockDynamicAssetConfig.getAssetMapping.mockRejectedValueOnce(new Error('No mapping found'));

      await expect(adapter.getReceivedAmount('1000000000000000000', unsupportedRoute)).rejects.toThrow(
        'Failed to calculate received amount',
      );
    });
  });

  describe('send', () => {
    it('should prepare unwrap + deposit transactions for WETH on Ethereum mainnet', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000'; // 1 ETH

      const result = await adapter.send(sender, recipient, amount, sampleRoute);

      expect(result.length).toBe(2);

      // First transaction: Unwrap WETH
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(result[0].transaction.to).toBe(sampleRoute.asset);
      expect(result[0].transaction.value).toBe(BigInt(0));
      expect(result[0].transaction.data).toEqual(expect.any(String)); // withdraw() encoded

      // Second transaction: Send ETH to Binance
      expect(result[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[1].transaction.to).toBe(mockDepositAddress.address);
      expect(result[1].transaction.value).toBe(BigInt(amount)); // Native ETH
      expect(result[1].transaction.data).toBe('0x');

      // Verify deposit address was requested
      expect(mockBinanceClient.getDepositAddress).toHaveBeenCalledWith('ETH', 'ETH');
      // Verify dynamic asset mapping was called
      expect(mockDynamicAssetConfig.getAssetMapping).toHaveBeenCalledWith(1, sampleRoute.asset);
    });

    it('should NOT unwrap ETH on BNB chain since it is the Binance WETH contract for that chain', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000'; // 1 ETH

      const bnbRoute: RebalanceRoute = {
        origin: 56, // BNB chain
        destination: 1, // Ethereum
        asset: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH on BNB chain
      };

      // Mock asset mapping for BNB chain ETH - the key is that binanceDepositAsset matches the route.asset
      const mockBNBETHMapping: BinanceAssetMapping = {
        chainId: 56,
        binanceSymbol: 'ETH',
        network: 'BSC',
        binanceAsset: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // Binance withdraws WETH on BSC
        minWithdrawalAmount: '10000000000000000',
        withdrawalFee: '40000000000000000',
        depositConfirmations: 12,
      };

      mockDynamicAssetConfig.getAssetMapping.mockResolvedValueOnce(mockBNBETHMapping);

      const result = await adapter.send(sender, recipient, amount, bnbRoute);

      // Should only have 1 transaction (direct ERC20 transfer, no unwrap)
      expect(result.length).toBe(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe(bnbRoute.asset); // Direct ERC20 transfer
      expect(result[0].transaction.value).toBe(BigInt(0)); // No native ETH
      expect(result[0].transaction.data).toEqual(expect.any(String)); // ERC20 transfer encoded

      // Verify deposit address was requested
      expect(mockBinanceClient.getDepositAddress).toHaveBeenCalledWith('ETH', 'BSC');
      // Verify dynamic asset mapping was called
      expect(mockDynamicAssetConfig.getAssetMapping).toHaveBeenCalledWith(56, bnbRoute.asset);
    });

    it('should unwrap WETH on any chain when the asset is NOT the Binance WETH contract', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000'; // 1 ETH

      const arbitrumRoute: RebalanceRoute = {
        origin: 42161, // Arbitrum
        destination: 1, // Ethereum
        asset: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH on Arbitrum
      };

      // Mock asset mapping where the user asset is different from what Binance expects
      const mockArbitrumETHMapping: BinanceAssetMapping = {
        chainId: 42161,
        binanceSymbol: 'ETH',
        network: 'ARBITRUM',
        binanceAsset: '0x0000000000000000000000000000000000000000',
        minWithdrawalAmount: '10000000000000000',
        withdrawalFee: '40000000000000000',
        depositConfirmations: 12,
      };

      mockDynamicAssetConfig.getAssetMapping.mockResolvedValueOnce(mockArbitrumETHMapping);

      const result = await adapter.send(sender, recipient, amount, arbitrumRoute);

      // Should have 2 transactions (unwrap + send)
      expect(result.length).toBe(2);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(result[0].transaction.to).toBe(arbitrumRoute.asset); // Unwrap call
      expect(result[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[1].transaction.value).toBe(BigInt(amount)); // Native ETH send
    });

    it('should prepare single deposit transaction for USDC', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000'; // 1000 USDC (6 decimals)

      const usdcRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      };

      mockBinanceClient.getDepositAddress.mockResolvedValueOnce({
        ...mockDepositAddress,
        coin: 'USDC',
      });

      const result = await adapter.send(sender, recipient, amount, usdcRoute);

      expect(result.length).toBe(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe(usdcRoute.asset); // Should call USDC contract
      expect(result[0].transaction.value).toBe(BigInt(0)); // ERC20 transfer
      expect(result[0].transaction.data).toEqual(expect.any(String)); // transfer() encoded

      // Verify deposit address was requested for USDC
      expect(mockBinanceClient.getDepositAddress).toHaveBeenCalledWith('USDC', 'ETH');
    });

    it('should prepare native ETH transaction correctly', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000'; // 1 ETH

      const nativeETHRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: '0x0000000000000000000000000000000000000000', // Native ETH
      };

      const result = await adapter.send(sender, recipient, amount, nativeETHRoute);

      expect(result.length).toBe(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe(mockDepositAddress.address); // Should send to deposit address
      expect(result[0].transaction.value).toBe(BigInt(amount)); // Native ETH value
      expect(result[0].transaction.data).toBe('0x'); // No data for native transfer

      // Verify deposit address was requested for ETH
      expect(mockBinanceClient.getDepositAddress).toHaveBeenCalledWith('ETH', 'ETH');
    });

    it('should throw error if amount is too low', async () => {
      const amount = '1000'; // Very small amount

      await expect(adapter.send('0xsender', '0xrecipient', amount, sampleRoute)).rejects.toThrow(
        'does not meet minimum withdrawal requirement',
      );
    });

    it('should throw error if getDepositAddress fails', async () => {
      mockBinanceClient.getDepositAddress.mockRejectedValueOnce(new Error('API error'));

      await expect(adapter.send('0xsender', '0xrecipient', '1000000000000000000', sampleRoute)).rejects.toThrow(
        'Failed to prepare Binance deposit transaction',
      );
    });

    it('should check withdrawal quota before sending', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000'; // 1 ETH

      await adapter.send(sender, recipient, amount, sampleRoute);

      // Verify quota was checked
      expect(mockBinanceClient.getWithdrawQuota).toHaveBeenCalled();
      expect(mockBinanceClient.getPrice).toHaveBeenCalledWith('ETHUSDT');
    });

    it('should throw error if withdrawal amount exceeds quota', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '5000000000000000000'; // 5 ETH = $10,000 at $2000/ETH

      // Mock quota response with low remaining quota
      mockBinanceClient.getWithdrawQuota.mockResolvedValueOnce({
        wdQuota: '8000000',
        usedWdQuota: '7995000', // Only $5,000 remaining
      });

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Withdrawal amount $10000.00 USD exceeds remaining daily quota of $5000.00 USD',
      );
    });

    it('should handle USDT assets without price conversion', async () => {
      const sender = '0x' + 'sender'.padEnd(40, '0');
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000'; // 1000 USDT (6 decimals)

      const usdtRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      };

      // Mock USDT mapping
      const mockUSDTMapping: BinanceAssetMapping = {
        chainId: 1,
        binanceSymbol: 'USDT',
        network: 'ETH',
        binanceAsset: '0x0000000000000000000000000000000000000000',
        minWithdrawalAmount: '1000000',
        withdrawalFee: '1000000',
        depositConfirmations: 12,
      };

      const mockUSDTArbitrumMapping: BinanceAssetMapping = {
        chainId: 42161,
        binanceSymbol: 'USDT',
        network: 'ARBITRUM',
        binanceAsset: '0x0000000000000000000000000000000000000000',
        minWithdrawalAmount: '1000000',
        withdrawalFee: '1000000',
        depositConfirmations: 12,
      };

      mockDynamicAssetConfig.getAssetMapping.mockImplementation(async (chainId: number, address: string) => {
        if (chainId === 1 && address.toLowerCase() === usdtRoute.asset.toLowerCase()) {
          return mockUSDTMapping;
        }
        if (chainId === 42161) {
          return mockUSDTArbitrumMapping; // For destination mapping
        }
        return mockETHMapping; // Fallback
      });

      mockBinanceClient.getDepositAddress.mockResolvedValueOnce({
        ...mockDepositAddress,
        coin: 'USDT',
      });

      await adapter.send(sender, recipient, amount, usdtRoute);

      // Should check quota but not price (stablecoin 1:1 with USD)
      expect(mockBinanceClient.getWithdrawQuota).toHaveBeenCalled();
      expect(mockBinanceClient.getPrice).not.toHaveBeenCalled();
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

    it('should return false when no recipient found in cache', async () => {
      const amount = '1000000000000000000';

      // Mock cache to return no recipient (simulating cache miss)
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValueOnce(undefined);

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);
      expect(result).toBe(false);

      // Should log error about missing recipient
      expect(mockLogger.error).toHaveBeenCalledWith('No recipient found in cache for withdrawal', {
        transactionHash: mockTransaction.transactionHash,
        route: sampleRoute,
      });
    });

    it('should return false when withdrawal status is not ready', async () => {
      const amount = '1000000000000000000';
      const recipient = '0x' + 'recipient'.padEnd(40, '0');

      // Mock cache to return recipient
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValueOnce({
        id: 'test-id',
        bridge: SupportedBridge.Binance,
        amount,
        origin: sampleRoute.origin,
        destination: sampleRoute.destination,
        asset: sampleRoute.asset,
        transaction: mockTransaction.transactionHash,
        recipient,
      });

      // Mock getOrInitWithdrawal to return a status that's not completed
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValueOnce({
        status: 'pending',
        onChainConfirmed: false,
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);

      expect(result).toBe(false);
    });

    it('should return true when withdrawal is completed and confirmed', async () => {
      const amount = '1000000000000000000';
      const recipient = '0x' + 'recipient'.padEnd(40, '0');

      // Mock cache to return recipient
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValueOnce({
        id: 'test-id',
        bridge: SupportedBridge.Binance,
        amount,
        origin: sampleRoute.origin,
        destination: sampleRoute.destination,
        asset: sampleRoute.asset,
        transaction: mockTransaction.transactionHash,
        recipient,
      });

      // Mock getOrInitWithdrawal to return completed status
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValueOnce({
        status: 'completed',
        onChainConfirmed: true,
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);

      expect(result).toBe(true);
    });
  });

  describe('destinationCallback', () => {
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

    it('should return undefined when no recipient found in cache', async () => {
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValueOnce(undefined);

      const result = await adapter.destinationCallback(sampleRoute, mockTransaction);
      expect(result).toBeUndefined();

      // Should log error about missing recipient
      expect(mockLogger.error).toHaveBeenCalledWith('No recipient found in cache for callback', {
        transactionHash: mockTransaction.transactionHash,
      });
    });

    it('should return undefined for non-ETH assets', async () => {
      const usdcRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      };

      const result = await adapter.destinationCallback(usdcRoute, mockTransaction);
      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Asset is not ETH/WETH, no wrapping needed', {
        binanceSymbol: 'USDC',
      });
    });

    it('should return undefined when destination binance asset matches destination chain asset', async () => {
      const bnbRoute: RebalanceRoute = {
        origin: 1, // Ethereum origin (where deposit is made)
        destination: 56, // BSC destination (where withdrawal is made)
        asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH on Ethereum (origin asset)
      };

      const recipient = '0x000000000000000000000000ffffffffffffffff';

      // Mock cache to return recipient
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValueOnce({
        id: 'test-id',
        bridge: SupportedBridge.Binance,
        amount: '1000000000000000000',
        origin: bnbRoute.origin,
        destination: bnbRoute.destination,
        asset: bnbRoute.asset,
        transaction: mockTransaction.transactionHash,
        recipient,
      });

      // Mock withdrawal status as completed
      const getOrInitWithdrawalSpy = jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValueOnce({
        status: 'completed',
        onChainConfirmed: true,
        txId: '0xwithdrawaltx',
      });
      
      // Debug: check if getOrInitWithdrawal is called
      console.log('Setting up getOrInitWithdrawal spy');

      // Mock provider
      const mockProvider = {
        getTransaction: jest.fn<() => Promise<any>>().mockResolvedValueOnce({
          hash: '0xwithdrawaltx',
          value: BigInt('1000000000000000000'),
        }),
      };
      jest.spyOn(adapter as any, 'getProvider').mockReturnValueOnce(mockProvider as any);

      // Mock origin mapping (Ethereum)
      const mockOriginMapping: BinanceAssetMapping = {
        chainId: 1,
        binanceSymbol: 'ETH',
        network: 'ETH',
        binanceAsset: '0x0000000000000000000000000000000000000000', // Binance takes native ETH on Ethereum
        minWithdrawalAmount: '10000000000000000',
        withdrawalFee: '40000000000000000',
        depositConfirmations: 12,
      };

      // Mock destination mapping (BSC) - hypothetical case where destination asset matches route asset
      const mockDestinationMapping: BinanceAssetMapping = {
        chainId: 56,
        binanceSymbol: 'ETH',
        network: 'BSC',
        binanceAsset: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // Same as route asset (hypothetical)
        minWithdrawalAmount: '10000000000000000',
        withdrawalFee: '40000000000000000',
        depositConfirmations: 12,
      };

      mockDynamicAssetConfig.getAssetMapping
        .mockResolvedValueOnce(mockOriginMapping) // First call for origin mapping
        .mockResolvedValueOnce(mockDestinationMapping); // Second call for destination mapping

      const result = await adapter.destinationCallback(bnbRoute, mockTransaction);
      
      // Debug: Check all logger calls
      console.log('All logger.debug calls:', mockLogger.debug.mock.calls);
      console.log('All logger.error calls:', mockLogger.error.mock.calls);
      if (mockLogger.error.mock.calls.length > 0) {
        console.log('Error details:', mockLogger.error.mock.calls[0][1]);
        const errorObj = mockLogger.error.mock.calls[0][1];
        if (errorObj && errorObj.error) {
          console.log('Error message:', (errorObj.error as any).message);
        }
      }
      console.log('getOrInitWithdrawal was called:', getOrInitWithdrawalSpy.mock.calls.length, 'times');
      
      expect(result).toBeUndefined();
      // The function should return undefined (no wrapping needed) when destination asset matches binance asset
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Finding matching destination asset',
        expect.objectContaining({
          asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          origin: 1,
          destination: 56,
        }),
      );
    });

    it('should return wrap transaction when ETH needs to be wrapped to WETH', async () => {
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const ethAmount = BigInt('1000000000000000000'); // 1 ETH

      // Mock cache to return recipient
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValueOnce({
        id: 'test-id',
        bridge: SupportedBridge.Binance,
        amount: ethAmount.toString(),
        origin: sampleRoute.origin,
        destination: sampleRoute.destination,
        asset: sampleRoute.asset,
        transaction: mockTransaction.transactionHash,
        recipient,
      });

      // Mock withdrawal status as completed
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValueOnce({
        status: 'completed',
        onChainConfirmed: true,
        txId: '0xwithdrawaltx',
      });

      // Mock provider and withdrawal receipt
      const mockProvider = {
        getTransactionReceipt: jest.fn<() => Promise<any>>().mockResolvedValueOnce({
          transactionHash: '0xwithdrawaltx',
          status: 'success',
        }),
        getTransaction: jest.fn<() => Promise<any>>().mockResolvedValueOnce({
          hash: '0xwithdrawaltx',
          value: ethAmount,
        }),
      };
      jest.spyOn(adapter as any, 'getProvider').mockReturnValueOnce(mockProvider as any);

      const result = await adapter.destinationCallback(sampleRoute, mockTransaction);

      expect(result).toBeDefined();
      expect(result?.memo).toBe(RebalanceTransactionMemo.Wrap);
      expect(result?.transaction.to).toBe('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'); // Should wrap to destination chain WETH address from config
      expect(result?.transaction.value).toBe(ethAmount);
      expect(result?.transaction.data).toEqual(expect.any(String)); // Encoded deposit() call
    });

    it('should return undefined when withdrawal is not completed', async () => {
      const recipient = '0x' + 'recipient'.padEnd(40, '0');

      // Mock cache to return recipient
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValueOnce({
        id: 'test-id',
        bridge: SupportedBridge.Binance,
        amount: '1000000000000000000',
        origin: sampleRoute.origin,
        destination: sampleRoute.destination,
        asset: sampleRoute.asset,
        transaction: mockTransaction.transactionHash,
        recipient,
      });

      // Mock withdrawal status as pending
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValueOnce({
        status: 'pending',
        onChainConfirmed: false,
      });

      const result = await adapter.destinationCallback(sampleRoute, mockTransaction);
      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Withdrawal not completed yet, skipping callback', {
        withdrawalStatus: {
          status: 'pending',
          onChainConfirmed: false,
        },
      });
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

    describe('getOrInitWithdrawal', () => {
      let mockTransaction: TransactionReceipt;
      const recipient = '0x' + 'recipient'.padEnd(40, '0');
      const amount = '1000000000000000000';

      beforeEach(() => {
        mockTransaction = {
          transactionHash: '0x1234567890abcdef' as `0x${string}`,
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

      it('should return undefined when deposit is not confirmed', async () => {
        // Mock deposit history to show no matching deposit
        mockBinanceClient.getDepositHistory.mockResolvedValueOnce([]);

        const result = await adapter.getOrInitWithdrawal(sampleRoute, mockTransaction, amount, recipient);
        expect(result).toBeUndefined();
        expect(mockLogger.debug).toHaveBeenCalledWith('Deposit not yet confirmed', {
          transactionHash: mockTransaction.transactionHash,
        });
      });

      it('should initiate withdrawal when deposit is confirmed and no existing withdrawal', async () => {
        // Mock deposit confirmed
        mockBinanceClient.getDepositHistory.mockResolvedValueOnce([
          {
            txId: mockTransaction.transactionHash,
            status: 1,
          },
        ]);

        // Mock no existing withdrawal
        mockBinanceClient.getWithdrawHistory.mockResolvedValueOnce([]);

        // Mock withdraw call
        mockBinanceClient.withdraw.mockResolvedValueOnce({ id: 'new-withdrawal-123' });

        // Mock withdrawal status check
        mockBinanceClient.getWithdrawHistory.mockResolvedValueOnce([
          {
            id: 'new-withdrawal-123',
            status: 4, // Processing
            applyTime: new Date().toISOString(),
          },
        ]);

        const result = await adapter.getOrInitWithdrawal(sampleRoute, mockTransaction, amount, recipient);

        expect(result).toEqual({
          status: 'pending',
          onChainConfirmed: false,
        });

        expect(mockBinanceClient.withdraw).toHaveBeenCalledWith({
          coin: 'ETH',
          network: 'ARBITRUM',
          address: recipient,
          amount: '1.00000000',
          withdrawOrderId: expect.stringMatching(/^mark-[0-9a-f]{8}-1-42161-[0-9a-zA-Z]{6}$/),
        });
      });

      it('should check withdrawal quota when initiating withdrawal', async () => {
        // Mock deposit confirmed
        mockBinanceClient.getDepositHistory.mockResolvedValueOnce([
          {
            txId: mockTransaction.transactionHash,
            status: 1,
          },
        ]);

        // Mock no existing withdrawal
        mockBinanceClient.getWithdrawHistory.mockResolvedValueOnce([]);

        // Mock withdraw call
        mockBinanceClient.withdraw.mockResolvedValueOnce({ id: 'new-withdrawal-123' });

        // Mock withdrawal status check
        mockBinanceClient.getWithdrawHistory.mockResolvedValueOnce([
          {
            id: 'new-withdrawal-123',
            status: 4, // Processing
            applyTime: new Date().toISOString(),
          },
        ]);

        await adapter.getOrInitWithdrawal(sampleRoute, mockTransaction, amount, recipient);

        // Verify quota was checked before withdrawal
        expect(mockBinanceClient.getWithdrawQuota).toHaveBeenCalled();
        expect(mockBinanceClient.getPrice).toHaveBeenCalledWith('ETHUSDT');
      });

      it('should throw error if withdrawal exceeds quota during initiation', async () => {
        // Mock deposit confirmed
        mockBinanceClient.getDepositHistory.mockResolvedValueOnce([
          {
            txId: mockTransaction.transactionHash,
            status: 1,
          },
        ]);

        // Mock no existing withdrawal
        mockBinanceClient.getWithdrawHistory.mockResolvedValueOnce([]);

        // Mock quota response with low remaining quota
        mockBinanceClient.getWithdrawQuota.mockResolvedValueOnce({
          wdQuota: '8000000',
          usedWdQuota: '7999000', // Only $1,000 remaining
        });

        const largeAmount = '5000000000000000000'; // 5 ETH = $10,000 at $2000/ETH

        // Should throw error due to quota exceeded
        await expect(adapter.getOrInitWithdrawal(sampleRoute, mockTransaction, largeAmount, recipient)).rejects.toThrow(
          'Withdrawal amount $10000.00 USD exceeds remaining daily quota of $1000.00 USD',
        );
      });

      it('should return existing withdrawal status when withdrawal already exists', async () => {
        // Mock deposit confirmed
        mockBinanceClient.getDepositHistory.mockResolvedValueOnce([
          {
            txId: mockTransaction.transactionHash,
            status: 1,
          },
        ]);

        // Mock existing withdrawal with custom order ID
        const withdrawOrderId = `mark-${mockTransaction.transactionHash.slice(2, 10)}-1-42161-C02aaA`;
        mockBinanceClient.getWithdrawHistory
          .mockResolvedValueOnce([
            {
              id: 'existing-withdrawal-123',
              withdrawOrderId,
              status: 6, // Completed
              applyTime: new Date().toISOString(),
              txId: '0xwithdrawaltx',
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'existing-withdrawal-123',
              withdrawOrderId,
              status: 6, // Completed
              applyTime: new Date().toISOString(),
              txId: '0xwithdrawaltx',
            },
          ]);

        // Mock provider for on-chain verification
        const mockProvider = {
          getTransactionReceipt: jest.fn<() => Promise<any>>().mockResolvedValueOnce({
            status: 'success',
          }),
        };
        jest.spyOn(adapter as any, 'getProvider').mockReturnValueOnce(mockProvider as any);

        const result = await adapter.getOrInitWithdrawal(sampleRoute, mockTransaction, amount, recipient);

        expect(result).toEqual({
          status: 'completed',
          onChainConfirmed: true,
          txId: '0xwithdrawaltx',
        });

        // Should not initiate new withdrawal
        expect(mockBinanceClient.withdraw).not.toHaveBeenCalled();
      });
    });
  });

  describe('signature handling', () => {
    it('should handle multiple parameters correctly in deposit history', async () => {
      const mockDepositRecords = [
        {
          txId: '0x123',
          status: 1,
          amount: '1.0',
          coin: 'ETH',
          network: 'ETH',
          address: '0xdepositaddress',
          addressTag: '',
          insertTime: Date.now(),
        },
      ];

      mockBinanceClient.getDepositHistory.mockResolvedValueOnce(mockDepositRecords);

      // This should work without signature errors
      const depositConfirmed = await (adapter as any).checkDepositConfirmed(
        sampleRoute,
        {
          transactionHash: '0x123',
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
        },
        {
          binanceSymbol: 'ETH',
          network: 'ETH',
          binanceAsset: '0x0000000000000000000000000000000000000000',
          minWithdrawalAmount: '0.01',
          withdrawalFee: '0.00004',
        },
      );

      expect(depositConfirmed.confirmed).toBe(true);
      expect(mockBinanceClient.getDepositHistory).toHaveBeenCalledWith('ETH', 1);
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
      expect(sendResult.length).toBe(2); // Unwrap + Send
      expect(sendResult[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(sendResult[1].transaction.to).toBe(mockDepositAddress.address);
      expect(sendResult[1].memo).toBe(RebalanceTransactionMemo.Rebalance);

      // 2. Check readyOnDestination (should not be ready initially)
      // Mock cache to return recipient for both calls
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValue({
        id: 'test-id',
        bridge: SupportedBridge.Binance,
        amount,
        origin: sampleRoute.origin,
        destination: sampleRoute.destination,
        asset: sampleRoute.asset,
        transaction: mockTransaction.transactionHash,
        recipient,
      });

      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValueOnce({
        status: 'pending',
        onChainConfirmed: false,
      });

      const ready1 = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);
      expect(ready1).toBe(false);

      // 3. Check again when withdrawal is complete
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValueOnce({
        status: 'completed',
        onChainConfirmed: true,
      });

      const ready2 = await adapter.readyOnDestination(amount, sampleRoute, mockTransaction);
      expect(ready2).toBe(true);
    });

    it('should throw when getting Binance adapter without rebalanceCache', () => {
      const mockLogger = { debug: jest.fn() } as unknown as Logger;

      const configWithoutBinance = { ...mockConfig, binance: { apiKey: undefined, apiSecret: undefined } };
      const rebalanceAdapter = new RebalanceAdapter(configWithoutBinance, mockLogger);

      // Should throw specific error about missing rebalanceCache
      expect(() => {
        rebalanceAdapter.getAdapter(SupportedBridge.Binance);
      }).toThrow('RebalanceCache is required for Binance adapter');
    });

    it('should be properly exported from main adapter with rebalanceCache', () => {
      const mockLogger = { debug: jest.fn() } as unknown as Logger;
      const mockRebalanceCache = {} as RebalanceCache;

      const configWithoutBinance = { ...mockConfig, binance: { apiKey: undefined, apiSecret: undefined } };
      const rebalanceAdapter = new RebalanceAdapter(configWithoutBinance, mockLogger, mockRebalanceCache);

      // With rebalanceCache provided, should fail due to missing API credentials, not missing cache
      expect(() => {
        rebalanceAdapter.getAdapter(SupportedBridge.Binance);
      }).toThrow('Binance adapter requires API key and secret');
    });
  });
});
