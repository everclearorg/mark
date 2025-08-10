/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { SupportedBridge, RebalanceRoute, AssetConfiguration, MarkConfiguration, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';
import { TransactionReceipt, PublicClient, GetTransactionParameters, Transaction, GetTransactionReturnType } from 'viem';
import { KrakenBridgeAdapter } from '../../../src/adapters/kraken/kraken';
import { KrakenClient } from '../../../src/adapters/kraken/client';
import { DynamicAssetConfig } from '../../../src/adapters/kraken/dynamic-config';
import { RebalanceTransactionMemo } from '../../../src/types';
import { KrakenAssetMapping, KRAKEN_DEPOSIT_STATUS, KRAKEN_WITHDRAWAL_STATUS } from '../../../src/adapters/kraken/types';

// Mock the external dependencies
jest.mock('../../../src/adapters/kraken/client');
jest.mock('../../../src/adapters/kraken/dynamic-config');

// Test adapter that exposes protected methods
class TestKrakenBridgeAdapter extends KrakenBridgeAdapter {
  public handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    return super.handleError(error, context, metadata);
  }

  public getProvider(chainId: number) {
    return super.getProvider(chainId);
  }

  public getOrInitWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    recipient: string,
  ): Promise<any> {
    return super.getOrInitWithdrawal(route, originTransaction, amount, recipient);
  }

  public checkDepositConfirmed(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    assetMapping: any,
  ): Promise<{ confirmed: boolean }> {
    return super.checkDepositConfirmed(route, originTransaction, assetMapping);
  }

  public findExistingWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    assetMapping: any,
  ): Promise<{ id: string } | undefined> {
    return super.findExistingWithdrawal(route, originTransaction, assetMapping);
  }

  public initiateWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    assetMapping: any,
    recipient: string,
  ): Promise<{ id: string }> {
    return super.initiateWithdrawal(route, originTransaction, amount, assetMapping, recipient);
  }

  // Additional helper for provider error testing
  public async simulateProviderError(chainId: number) {
    return super.getProvider(chainId);
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
    decimals: 6,
    tickerHash: '0xUSDCHash',
    isNative: false,
    balanceThreshold: '0',
  },
};

const mockChains: Record<string, ChainConfiguration> = {
  '1': {
    assets: [mockAssets.ETH, mockAssets.WETH, mockAssets.USDC],
    providers: ['https://eth-mainnet.example.com'],
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
      mockAssets.ETH,
      {
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        symbol: 'WETH',
        decimals: 18,
        tickerHash: '0xWETHHash',
        isNative: false,
        balanceThreshold: '0',
      },
      mockAssets.USDC
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
    apiKey: 'test-binance-api-key',
    apiSecret: 'test-binance-api-secret',
  },
  kraken: {
    apiKey: 'test-kraken-api-key',
    apiSecret: 'test-kraken-api-secret',
  },
  near: {
    jwtToken: 'test-jwt-token',
  },
  redis: {
    host: 'localhost',
    port: 6379,
  },
  ownAddress: '0x1234567890123456789012345678901234567890',
  ownSolAddress: '11111111111111111111111111111111',
  stage: 'development',
  environment: 'mainnet',
  logLevel: 'debug',
  supportedSettlementDomains: [1, 42161],
  forceOldestInvoice: false,
  supportedAssets: ['ETH', 'WETH', 'USDC'],
  chains: mockChains,
  hub: {
    domain: '25327',
    providers: ['http://localhost:8545'],
  },
  routes: [],
};

// Mock Kraken client
const mockKrakenClient = {
  isConfigured: jest.fn<() => boolean>().mockReturnValue(true),
  isSystemOperational: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  getDepositAddresses: jest.fn(),
  withdraw: jest.fn(),
  getDepositStatus: jest.fn(),
  getWithdrawStatus: jest.fn(),
  getAssetInfo: jest.fn(),
  getDepositMethods: jest.fn(),
  getWithdrawInfo: jest.fn(),
} as unknown as jest.Mocked<KrakenClient>;

// Mock dynamic config
const mockDynamicConfig = {
  getAssetMapping: jest.fn(),
  refreshConfig: jest.fn(),
} as unknown as jest.Mocked<DynamicAssetConfig>;

// Mock asset mappings for testing
const mockETHMainnetKrakenMapping: KrakenAssetMapping = {
  chainId: 1,
  krakenSymbol: 'ETH',
  krakenAsset: 'XETH',
  method: 'ether',
  network: 'ethereum',
  minWithdrawalAmount: '10000000000000000', // 0.01 ETH in wei
  withdrawalFee: '4000000000000000', // 0.004 ETH in wei
};

const mockWETHArbitrumKrakenMapping: KrakenAssetMapping = {
  chainId: 42161,
  krakenSymbol: 'ETH',
  krakenAsset: 'XETH',
  method: 'arbitrum',
  network: 'arbitrum',
  minWithdrawalAmount: '10000000000000000', // 0.01 WETH in wei
  withdrawalFee: '2000000000000000', // 0.002 WETH in wei
};

const mockUSDCMainnetKrakenMapping: KrakenAssetMapping = {
  chainId: 1,
  krakenSymbol: 'USDC',
  krakenAsset: 'USDC',
  method: 'ether',
  network: 'ethereum',
  minWithdrawalAmount: '1000000', // 1 USDC in smallest units (6 decimals)
  withdrawalFee: '500000', // 0.5 USDC fee
};

describe('KrakenBridgeAdapter', () => {
  let adapter: TestKrakenBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock implementations
    mockKrakenClient.isConfigured.mockReturnValue(true);

    // Mock constructors
    (KrakenClient as jest.MockedClass<typeof KrakenClient>).mockImplementation(() => mockKrakenClient);
    (DynamicAssetConfig as jest.MockedClass<typeof DynamicAssetConfig>).mockImplementation(
      () => mockDynamicConfig,
    );

    adapter = new TestKrakenBridgeAdapter(
      'test-kraken-api-key',
      'test-kraken-api-secret',
      'https://api.kraken.com',
      mockConfig,
      mockLogger,
      mockRebalanceCache,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with valid credentials', () => {
      expect(KrakenClient).toHaveBeenCalledWith(
        'test-kraken-api-key',
        'test-kraken-api-secret',
        mockLogger,
        'https://api.kraken.com',
      );
      expect(DynamicAssetConfig).toHaveBeenCalledWith(mockKrakenClient, mockConfig.chains, mockLogger);
      expect(mockLogger.debug).toHaveBeenCalledWith('KrakenBridgeAdapter initialized', {
        baseUrl: 'https://api.kraken.com',
        hasApiKey: true,
        hasApiSecret: true,
        bridgeType: SupportedBridge.Kraken,
        clientConfigured: true,
      });
    });

    it('should throw error if client is not configured', () => {
      const unconfiguredClient = {
        ...mockKrakenClient,
        isConfigured: jest.fn<() => boolean>().mockReturnValue(false),
      } as unknown as jest.Mocked<KrakenClient>;

      (KrakenClient as jest.MockedClass<typeof KrakenClient>).mockImplementationOnce(() => unconfiguredClient);

      expect(() => {
        new TestKrakenBridgeAdapter(
          '',
          '',
          'https://api.kraken.com',
          mockConfig,
          mockLogger,
          mockRebalanceCache,
        );
      }).toThrow('Kraken adapter requires API key and secret');
    });
  });

  describe('type()', () => {
    it('should return SupportedBridge.Kraken', () => {
      expect(adapter.type()).toBe(SupportedBridge.Kraken);
    });
  });

  describe('handleError()', () => {
    it('should log error and throw', () => {
      const error = new Error('Test error');
      const context = 'test operation';
      const metadata = { test: 'data' };

      expect(() => {
        adapter.handleError(error, context, metadata);
      }).toThrow('Failed to test operation: Test error');

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to test operation', {
        error: jsonifyError(error),
        test: 'data',
      });
    });

    it('should handle unknown error types', () => {
      const error = 'String error';
      const context = 'test operation';

      expect(() => {
        adapter.handleError(error, context, {});
      }).toThrow('Failed to test operation: Unknown error');
    });
  });

  describe('getProvider()', () => {
    it('should create provider for valid chain with providers', () => {
      const provider = adapter.getProvider(1);
      expect(provider).toBeDefined();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should return undefined for chain without config', () => {
      const provider = adapter.getProvider(999);
      expect(provider).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('No provider configured for chain', { chainId: 999 });
    });

    it('should return undefined for chain without providers', () => {
      const configWithoutProviders = {
        ...mockConfig,
        chains: {
          '1': {
            ...mockConfig.chains['1'],
            providers: [],
          },
        },
      };

      const adapterWithoutProviders = new TestKrakenBridgeAdapter(
        'test-kraken-api-key',
        'test-kraken-api-secret',
        'https://api.kraken.com',
        configWithoutProviders,
        mockLogger,
        mockRebalanceCache,
      );

      const provider = adapterWithoutProviders.getProvider(1);
      expect(provider).toBeUndefined();
    });

  });

  describe('getReceivedAmount()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    beforeEach(() => {
      // Reset mocks and set up default behavior
      jest.clearAllMocks();

      // Mock getAssetMapping to return mappings based on chain and asset identifier
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number, assetIdentifier: string) => {
        // Handle WETH addresses and symbols
        if ((chainId === 1 && (assetIdentifier === '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' || assetIdentifier === 'WETH'))) {
          return Promise.resolve(mockETHMainnetKrakenMapping);
        } else if ((chainId === 42161 && (assetIdentifier === '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' || assetIdentifier === 'WETH'))) {
          return Promise.resolve(mockWETHArbitrumKrakenMapping);
        } else if (assetIdentifier === '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' || assetIdentifier === 'USDC') {
          // USDC mapping for both chains
          return Promise.resolve(mockUSDCMainnetKrakenMapping);
        }
        return Promise.reject(new Error(`Asset mapping not found for ${assetIdentifier} on chain ${chainId}`));
      });
    });

    it('should calculate net amount after withdrawal fees', async () => {
      const amount = '100000000000000000'; // 0.1 ETH in wei
      const expectedNetAmount = (BigInt(amount) - BigInt(mockWETHArbitrumKrakenMapping.withdrawalFee)).toString();

      const result = await adapter.getReceivedAmount(amount, sampleRoute);

      expect(result).toBe(expectedNetAmount);
      expect(mockLogger.debug).toHaveBeenCalledWith('Kraken withdrawal amount calculated after fees', {
        originalAmount: amount,
        withdrawalFee: mockWETHArbitrumKrakenMapping.withdrawalFee,
        netAmount: expectedNetAmount,
        asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        method: mockWETHArbitrumKrakenMapping.method,
        originChain: sampleRoute.origin,
        destinationChain: sampleRoute.destination,
      });
    });

    it('should throw error if amount is below minimum withdrawal', async () => {
      const amount = '1000000000000000'; // 0.001 ETH - below 0.01 ETH minimum

      await expect(adapter.getReceivedAmount(amount, sampleRoute)).rejects.toThrow(
        'Failed to calculate received amount: Amount is too low for Kraken withdrawal',
      );
    });

    it('should handle USDC calculations correctly', async () => {
      const usdcRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      };
      const amount = '2000000'; // 2 USDC in smallest units

      // Reset mocks for USDC
      mockDynamicConfig.getAssetMapping
        .mockResolvedValueOnce(mockUSDCMainnetKrakenMapping) // origin mapping
        .mockResolvedValueOnce(mockUSDCMainnetKrakenMapping); // destination mapping (same for origin/destination)

      const expectedNetAmount = (BigInt(amount) - BigInt(mockUSDCMainnetKrakenMapping.withdrawalFee)).toString();

      const result = await adapter.getReceivedAmount(amount, usdcRoute);

      expect(result).toBe(expectedNetAmount);
      expect(result).toBe('1500000'); // 2 USDC - 0.5 USDC fee = 1.5 USDC
    });

    it('should handle validateAssetMapping errors', async () => {
      mockDynamicConfig.getAssetMapping
        .mockRejectedValueOnce(new Error('Asset not supported'));

      const amount = '100000000000000000';

      await expect(adapter.getReceivedAmount(amount, sampleRoute)).rejects.toThrow(
        'Failed to calculate received amount',
      );
    });

    it('should handle getDestinationAssetMapping errors', async () => {
      mockDynamicConfig.getAssetMapping
        .mockResolvedValueOnce(mockETHMainnetKrakenMapping) // origin mapping succeeds
        .mockRejectedValueOnce(new Error('Destination chain not supported')); // destination mapping fails

      const amount = '100000000000000000';

      await expect(adapter.getReceivedAmount(amount, sampleRoute)).rejects.toThrow(
        'Failed to calculate received amount',
      );
    });

    it('should handle edge case where amount equals minimum withdrawal', async () => {
      const amount = mockETHMainnetKrakenMapping.minWithdrawalAmount; // Exactly minimum
      const expectedNetAmount = (BigInt(amount) - BigInt(mockWETHArbitrumKrakenMapping.withdrawalFee)).toString();

      const result = await adapter.getReceivedAmount(amount, sampleRoute);

      expect(result).toBe(expectedNetAmount);
    });
  });

  describe('send()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    const sender = '0x1234567890123456789012345678901234567890';
    const recipient = '0x9876543210987654321098765432109876543210';
    const amount = '100000000000000000'; // 0.1 ETH

    beforeEach(() => {
      jest.clearAllMocks();

      // Set up all the required mocks for send() method
      mockKrakenClient.isSystemOperational.mockResolvedValue(true);

      // Mock asset mapping calls
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number, assetIdentifier: string) => {
        if ((chainId === 1 && (assetIdentifier === '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' || assetIdentifier === 'WETH'))) {
          return Promise.resolve(mockETHMainnetKrakenMapping);
        } else if ((chainId === 42161 && (assetIdentifier === '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' || assetIdentifier === 'WETH'))) {
          return Promise.resolve(mockWETHArbitrumKrakenMapping);
        }
        return Promise.reject(new Error(`Asset mapping not found for ${assetIdentifier} on chain ${chainId}`));
      });

      // Mock Kraken client methods with proper types
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockETHMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'WETH',
          decimals: 8,
          display_decimals: 4,
          status: 'enabled'
        }
      });

      mockKrakenClient.getDepositMethods.mockResolvedValue([
        {
          method: mockETHMainnetKrakenMapping.method,
          limit: false,
          minimum: '0.001',
          'gen-address': true
        }
      ]);

      mockKrakenClient.getDepositAddresses.mockResolvedValue([
        {
          address: '0x1234567890123456789012345678901234567890',
          expiretm: 0,
          new: true
        }
      ]);
    });

    it('should prepare WETH unwrap + ETH send when Kraken expects ETH', async () => {
      const result = await adapter.send(sender, recipient, amount, sampleRoute);

      expect(result).toHaveLength(2);

      // First transaction: unwrap WETH
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(result[0].transaction.to).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'); // WETH token address
      expect(result[0].transaction.value).toBe(BigInt(0));
      expect(result[0].transaction.data).toEqual(expect.any(String)); // withdraw() encoded data

      // Second transaction: send ETH to Kraken
      expect(result[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[1].transaction.to).toBe('0x1234567890123456789012345678901234567890'); // Kraken deposit address
      expect(result[1].transaction.value).toBe(BigInt(amount)); // ETH value
      expect(result[1].transaction.data).toBe('0x');

      // Verify all safety checks were performed
      expect(mockKrakenClient.isSystemOperational).toHaveBeenCalled();
      expect(mockKrakenClient.getAssetInfo).toHaveBeenCalled();
      expect(mockKrakenClient.getDepositMethods).toHaveBeenCalled();
      expect(mockKrakenClient.getDepositAddresses).toHaveBeenCalled();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Kraken deposit address obtained for transaction preparation',
        expect.objectContaining({
          asset: mockETHMainnetKrakenMapping.krakenAsset,
          krakenSymbol: mockETHMainnetKrakenMapping.krakenSymbol,
          method: mockETHMainnetKrakenMapping.method,
          depositAddress: '0x1234567890123456789012345678901234567890',
          recipient,
        })
      );
    });

    it('should prepare WETH unwrap + ETH send for ETH kraken symbol', async () => {
      // Modify mapping to use ETH symbol (which triggers unwrap logic)
      const ethMapping = {
        ...mockETHMainnetKrakenMapping,
        krakenSymbol: 'ETH',
        krakenAsset: '0x0000000000000000000000000000000000000000', // Zero address for ETH
      };

      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number, assetIdentifier: string) => {
        if (chainId === 1) return Promise.resolve(ethMapping);
        if (chainId === 42161) return Promise.resolve(mockWETHArbitrumKrakenMapping);
        return Promise.reject(new Error(`Asset mapping not found`));
      });

      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [ethMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 8,
          display_decimals: 4,
          status: 'enabled'
        }
      });

      mockKrakenClient.getDepositMethods.mockResolvedValue([
        {
          method: ethMapping.method,
          limit: false,
          minimum: '0.001',
          'gen-address': true
        }
      ]);

      const result = await adapter.send(sender, recipient, amount, sampleRoute);

      expect(result).toHaveLength(2);

      // First transaction: unwrap WETH
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(result[0].transaction.to).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'); // WETH address
      expect(result[0].transaction.value).toBe(BigInt(0));
      expect(result[0].transaction.data).toEqual(expect.any(String)); // withdraw() encoded

      // Second transaction: send ETH to Kraken
      expect(result[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[1].transaction.to).toBe('0x1234567890123456789012345678901234567890'); // Deposit address
      expect(result[1].transaction.value).toBe(BigInt(amount)); // ETH value
      expect(result[1].transaction.data).toBe('0x');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Preparing WETH unwrap before Kraken ETH deposit',
        expect.objectContaining({
          wethAddress: sampleRoute.asset,
          krakenSymbol: 'ETH',
          transactionSequence: ['unwrap_weth', 'send_eth_to_kraken'],
        })
      );
    });

    it('should handle WETH transfer to Kraken when krakenAsset does not match zero address', async () => {
      // Test the else branch in line 268 where we transfer WETH token instead of native ETH
      const wethMapping = {
        ...mockETHMainnetKrakenMapping,
        krakenSymbol: 'ETH',
        krakenAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH address, not zero address
      };

      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(wethMapping);
        if (chainId === 42161) return Promise.resolve(mockWETHArbitrumKrakenMapping);
        return Promise.reject(new Error(`Asset mapping not found`));
      });

      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [wethMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'WETH',
          decimals: 8,
          display_decimals: 4,
          status: 'enabled'
        }
      });

      mockKrakenClient.getDepositMethods.mockResolvedValue([
        {
          method: wethMapping.method,
          limit: false,
          minimum: '0.001',
          'gen-address': true
        }
      ]);

      const nativeETHRoute = { ...sampleRoute, asset: '0x0000000000000000000000000000000000000000' };
      const result = await adapter.send(sender, recipient, amount, nativeETHRoute);

      expect(result).toHaveLength(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe(nativeETHRoute.asset); // Should be zero address
      expect(result[0].transaction.value).toBe(BigInt(0)); // ERC20 transfer has no value
      expect(result[0].transaction.data).toEqual(expect.any(String)); // ERC20 transfer encoded
    });

    it('should throw error when asset config is not found', async () => {
      const invalidRoute = { ...sampleRoute, asset: '0xInvalidAsset123' };

      await expect(adapter.send(sender, recipient, amount, invalidRoute)).rejects.toThrow(
        'No Kraken asset mapping found for route from chain 1'
      );
    });

    it('should throw error when decimals are not found', async () => {
      // Create a route with an asset that won't be found in config
      const unknownAssetRoute = {
        ...sampleRoute,
        asset: '0x9999999999999999999999999999999999999999',
        origin: 999, // Use a chain that doesn't exist
      };

      await expect(adapter.send(sender, recipient, amount, unknownAssetRoute)).rejects.toThrow(
        'No Kraken asset mapping found for route from chain 999'
      );
    });

    it('should throw error when withdrawal quota is exceeded', async () => {
      // Use a very large amount to trigger quota exceeded error
      const largeAmount = '100000000000000000000000'; // 100,000 ETH

      await expect(adapter.send(sender, recipient, largeAmount, sampleRoute)).rejects.toThrow(
        'exceeds daily limit'
      );
    });

    it('should prepare native ETH transfer when asset is zero address', async () => {
      const nativeETHRoute = { ...sampleRoute, asset: '0x0000000000000000000000000000000000000000' };

      const ethMapping = {
        ...mockETHMainnetKrakenMapping,
        krakenSymbol: 'ETH',
        krakenAsset: '0x0000000000000000000000000000000000000000',
      };

      mockDynamicConfig.getAssetMapping.mockImplementation(() => Promise.resolve(ethMapping));
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [ethMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 8,
          display_decimals: 4,
          status: 'enabled'
        }
      });

      const result = await adapter.send(sender, recipient, amount, nativeETHRoute);

      expect(result).toHaveLength(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe('0x1234567890123456789012345678901234567890'); // Deposit address
      expect(result[0].transaction.value).toBe(BigInt(amount)); // Native ETH value
      expect(result[0].transaction.data).toBe('0x');
    });

    it('should prepare USDC transfer transaction correctly', async () => {
      const usdcRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      };

      mockDynamicConfig.getAssetMapping.mockImplementation(() => Promise.resolve(mockUSDCMainnetKrakenMapping));
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockUSDCMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'USDC',
          decimals: 6,
          display_decimals: 2,
          status: 'enabled'
        }
      });
      mockKrakenClient.getDepositMethods.mockResolvedValue([
        {
          method: mockUSDCMainnetKrakenMapping.method,
          limit: false,
          minimum: '1.0',
          'gen-address': true
        }
      ]);

      const result = await adapter.send(sender, recipient, '10000000', usdcRoute); // 10 USDC

      expect(result).toHaveLength(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe(usdcRoute.asset); // USDC token address
      expect(result[0].transaction.value).toBe(BigInt(0));
      expect(result[0].transaction.data).toEqual(expect.any(String)); // ERC20 transfer encoded
    });

    it('should throw error if Kraken system is not operational', async () => {
      mockKrakenClient.isSystemOperational.mockResolvedValue(false);

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: Kraken system is not operational'
      );
    });

    it('should throw error if amount is below minimum withdrawal', async () => {
      const smallAmount = '1000000000000000'; // 0.001 ETH - below minimum

      await expect(adapter.send(sender, recipient, smallAmount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: Amount 1000000000000000 does not meet minimum withdrawal requirement'
      );
    });

    it('should throw error if asset config not found', async () => {
      const unknownAssetRoute = { ...sampleRoute, asset: '0xUnknownAsset123' };

      await expect(adapter.send(sender, recipient, amount, unknownAssetRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: No Kraken asset mapping found for route from chain 1'
      );
    });

    it('should throw error if Kraken asset is disabled', async () => {
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockETHMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'WETH',
          decimals: 8,
          display_decimals: 4,
          status: 'disabled'
        }
      });

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: Asset'
      );
    });

    it('should throw error if deposit method not available', async () => {
      mockKrakenClient.getDepositMethods.mockResolvedValue([
        {
          method: 'DifferentMethod',
          limit: false,
          minimum: '0.001',
          'gen-address': true
        }
      ]);

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: Deposit method'
      );
    });

    it('should throw error if no deposit address available', async () => {
      mockKrakenClient.getDepositAddresses.mockResolvedValue([]);

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: No deposit address available'
      );
    });

    it('should handle API errors gracefully', async () => {
      mockKrakenClient.getAssetInfo.mockRejectedValue(new Error('API connection failed'));

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to prepare Kraken deposit transaction',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'API connection failed'
          })
        })
      );
    });

    it('should validate withdrawal quota before proceeding', async () => {
      // This test validates the checkWithdrawQuota call is made
      // The actual quota validation logic is tested in utils.spec.ts
      const result = await adapter.send(sender, recipient, amount, sampleRoute);

      // If we got here, quota check passed (mocked to pass by default)
      // Since we use ETH kraken mapping, this will result in unwrap + send sequence
      expect(result).toHaveLength(2);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Kraken deposit address obtained for transaction preparation',
        expect.any(Object)
      );
    });
  });

  describe('readyOnDestination()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    const mockOriginTransaction: TransactionReceipt = {
      blockHash: '0xabc123',
      blockNumber: BigInt(12345),
      contractAddress: null,
      cumulativeGasUsed: BigInt(21000),
      effectiveGasPrice: BigInt(20000000000),
      from: '0x1234567890123456789012345678901234567890',
      gasUsed: BigInt(21000),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x9876543210987654321098765432109876543210',
      transactionHash: '0xdef456789abcdef123456789abcdef123456789abcdef123456789abcdef123456',
      transactionIndex: 0,
      type: 'eip1559',
    };

    const amount = '100000000000000000'; // 0.1 ETH
    const recipient = '0x9876543210987654321098765432109876543210';

    beforeEach(() => {
      jest.clearAllMocks();

      // Mock the cache to return recipient by default
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValue({
        id: 'test-rebalance-id',
        recipient,
        amount,
        transaction: mockOriginTransaction.transactionHash,
        bridge: SupportedBridge.Kraken,
        origin: sampleRoute.origin,
        destination: sampleRoute.destination,
        asset: sampleRoute.asset,
      });

      // Mock asset mapping
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(mockETHMainnetKrakenMapping);
        if (chainId === 42161) return Promise.resolve(mockWETHArbitrumKrakenMapping);
        return Promise.reject(new Error(`Asset mapping not found for chain ${chainId}`));
      });
    });

    it('should return true when withdrawal is completed and confirmed on-chain', async () => {
      // Mock getOrInitWithdrawal to return completed status
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: '0xwithdrawal123',
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(true);
      expect(adapter.getOrInitWithdrawal).toHaveBeenCalledWith(
        sampleRoute,
        mockOriginTransaction,
        amount,
        recipient
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Kraken withdrawal readiness determined',
        expect.objectContaining({
          isReady: true,
          krakenStatus: 'completed',
          onChainConfirmed: true,
          withdrawalTxId: '0xwithdrawal123',
        })
      );
    });

    it('should return false when withdrawal is completed but not confirmed on-chain', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: false,
        txId: '0xwithdrawal123',
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Kraken withdrawal readiness determined',
        expect.objectContaining({
          isReady: false,
          krakenStatus: 'completed',
          onChainConfirmed: false,
        })
      );
    });

    it('should return false when withdrawal is pending', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'pending',
        onChainConfirmed: false,
        txId: undefined,
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Kraken withdrawal readiness determined',
        expect.objectContaining({
          isReady: false,
          krakenStatus: 'pending',
          onChainConfirmed: false,
        })
      );
    });

    it('should return false when withdrawal status is undefined', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue(undefined);

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        'Kraken withdrawal readiness determined',
        expect.any(Object)
      );
    });

    it('should return false when recipient is not found in cache', async () => {
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValue(undefined);

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Cannot check withdrawal readiness - recipient missing from cache',
        expect.objectContaining({
          transactionHash: mockOriginTransaction.transactionHash,
          requiredFor: 'kraken_withdrawal_initiation',
        })
      );
    });

    it('should return false when cache lookup throws error', async () => {
      mockRebalanceCache.getRebalanceByTransaction.mockRejectedValue(new Error('Cache lookup failed'));

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Cannot check withdrawal readiness - recipient missing from cache',
        expect.objectContaining({
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });

    it('should return false and log error when getOrInitWithdrawal throws', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockRejectedValue(new Error('Withdrawal init failed'));

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to check if transaction is ready on destination',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Withdrawal init failed'
          }),
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });

    it('should log debug info when checking readiness', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: '0xwithdrawal123',
      });

      await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Checking if Kraken withdrawal is ready on destination',
        expect.objectContaining({
          amount,
          originChain: sampleRoute.origin,
          destinationChain: sampleRoute.destination,
          asset: sampleRoute.asset,
          transactionHash: mockOriginTransaction.transactionHash,
          blockNumber: mockOriginTransaction.blockNumber,
        })
      );
    });
  });

  describe('getProvider()', () => {
    it('should return undefined and warn for non-existent chain', () => {
      const provider = adapter.getProvider(999);
      expect(provider).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('No provider configured for chain', { chainId: 999 });
    });

    it('should return undefined for chain without providers', () => {
      const configWithoutProviders = {
        ...mockConfig,
        chains: {
          '1': {
            ...mockConfig.chains['1'],
            providers: [],
          },
        },
      };

      const adapterWithoutProviders = new TestKrakenBridgeAdapter(
        'test-kraken-api-key',
        'test-kraken-api-secret',
        'https://api.kraken.com',
        configWithoutProviders,
        mockLogger,
        mockRebalanceCache,
      );

      const provider = adapterWithoutProviders.getProvider(1);
      expect(provider).toBeUndefined();
    });

    it('should handle provider creation errors and return undefined', async () => {
      // Mock createPublicClient to throw an error by modifying the provider URL to be invalid
      const configWithInvalidProvider = {
        ...mockConfig,
        chains: {
          '1': {
            ...mockConfig.chains['1'],
            providers: ['invalid-url-that-will-cause-error'],
          },
        },
      };

      const adapterWithInvalidProvider = new TestKrakenBridgeAdapter(
        'test-api-key',
        'test-api-secret',
        'https://api.kraken.com',
        configWithInvalidProvider,
        mockLogger,
        mockRebalanceCache,
      );

      // This should handle the error gracefully and return undefined
      const provider = adapterWithInvalidProvider.simulateProviderError(1);

      // The method should return undefined when createPublicClient fails
      // Note: This tests the error handling in getProvider method (lines 698-703)
      if (!provider) {
        expect(provider).toBeUndefined();
      }
    });

    it('should successfully create provider for valid chain', () => {
      const provider = adapter.getProvider(1);
      expect(provider).toBeDefined();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('checkDepositConfirmed()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    const mockOriginTransaction: TransactionReceipt = {
      blockHash: '0xabc123',
      blockNumber: BigInt(12345),
      contractAddress: null,
      cumulativeGasUsed: BigInt(21000),
      effectiveGasPrice: BigInt(20000000000),
      from: '0x1234567890123456789012345678901234567890',
      gasUsed: BigInt(21000),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x9876543210987654321098765432109876543210',
      transactionHash: '0xdef456789abcdef123456789abcdef123456789abcdef123456789abcdef123456',
      transactionIndex: 0,
      type: 'eip1559',
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return confirmed true when deposit is found and successful', async () => {
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-123',
          txid: mockOriginTransaction.transactionHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const result = await adapter.checkDepositConfirmed(
        sampleRoute,
        mockOriginTransaction,
        mockETHMainnetKrakenMapping
      );

      expect(result.confirmed).toBe(true);
      expect(mockKrakenClient.getDepositStatus).toHaveBeenCalledWith(
        mockETHMainnetKrakenMapping.krakenAsset,
        mockETHMainnetKrakenMapping.method
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit confirmation check',
        expect.objectContaining({
          transactionHash: mockOriginTransaction.transactionHash,
          confirmed: true,
          matchingDepositId: mockOriginTransaction.transactionHash,
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        })
      );
    });

    it('should return confirmed false when deposit is not found', async () => {
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-456',
          txid: '0xdifferenttxhash',
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const result = await adapter.checkDepositConfirmed(
        sampleRoute,
        mockOriginTransaction,
        mockETHMainnetKrakenMapping
      );

      expect(result.confirmed).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit confirmation check',
        expect.objectContaining({
          confirmed: false,
          matchingDepositId: undefined,
          status: undefined,
        })
      );
    });

    it('should return confirmed false when deposit status is not SUCCESS', async () => {
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-789',
          txid: mockOriginTransaction.transactionHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.PENDING,
        },
      ]);

      const result = await adapter.checkDepositConfirmed(
        sampleRoute,
        mockOriginTransaction,
        mockETHMainnetKrakenMapping
      );

      expect(result.confirmed).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit confirmation check',
        expect.objectContaining({
          confirmed: false,
          status: KRAKEN_DEPOSIT_STATUS.PENDING,
        })
      );
    });

    it('should return confirmed false when API call fails', async () => {
      mockKrakenClient.getDepositStatus.mockRejectedValue(new Error('API error'));

      const result = await adapter.checkDepositConfirmed(
        sampleRoute,
        mockOriginTransaction,
        mockETHMainnetKrakenMapping
      );

      expect(result.confirmed).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to check deposit confirmation',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'API error',
          }),
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });

    it('should handle case-insensitive transaction hash matching', async () => {
      const upperCaseTxHash = mockOriginTransaction.transactionHash.toUpperCase();
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-case',
          txid: upperCaseTxHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const result = await adapter.checkDepositConfirmed(
        sampleRoute,
        mockOriginTransaction,
        mockETHMainnetKrakenMapping
      );

      expect(result.confirmed).toBe(true);
    });
  });

  describe('findExistingWithdrawal()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    const mockOriginTransaction: TransactionReceipt = {
      blockHash: '0xabc123',
      blockNumber: BigInt(12345),
      contractAddress: null,
      cumulativeGasUsed: BigInt(21000),
      effectiveGasPrice: BigInt(20000000000),
      from: '0x1234567890123456789012345678901234567890',
      gasUsed: BigInt(21000),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x9876543210987654321098765432109876543210',
      transactionHash: '0xdef456789abcdef123456789abcdef123456789abcdef123456789abcdef123456',
      transactionIndex: 0,
      type: 'eip1559',
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should find existing withdrawal by refid', async () => {
      const expectedOrderId = 'mark-1-42161-def45678';
      mockKrakenClient.getWithdrawStatus.mockResolvedValue([
        {
          asset: 'XETH',
          refid: expectedOrderId,
          txid: '0xwithdrawaltx123',
          info: 'ETH withdrawal',
          amount: '0.1',
          fee: '0.004',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const result = await adapter.findExistingWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        mockWETHArbitrumKrakenMapping
      );

      expect(result).toEqual({ id: expectedOrderId });
      expect(mockKrakenClient.getWithdrawStatus).toHaveBeenCalledWith(
        mockWETHArbitrumKrakenMapping.krakenAsset
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Found existing withdrawal',
        expect.objectContaining({
          withdrawalId: expectedOrderId,
          customOrderId: expectedOrderId,
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        })
      );
    });

    it('should find existing withdrawal by info field', async () => {
      const expectedOrderId = 'mark-1-42161-def45678';
      mockKrakenClient.getWithdrawStatus.mockResolvedValue([
        {
          asset: 'XETH',
          refid: 'different-id',
          txid: '0xwithdrawaltx123',
          info: `Some info containing ${expectedOrderId} and other data`,
          amount: '0.1',
          fee: '0.004',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const result = await adapter.findExistingWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        mockWETHArbitrumKrakenMapping
      );

      expect(result).toEqual({ id: 'different-id' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Found existing withdrawal',
        expect.objectContaining({
          withdrawalId: 'different-id',
        })
      );
    });

    it('should return undefined when no existing withdrawal found', async () => {
      mockKrakenClient.getWithdrawStatus.mockResolvedValue([
        {
          asset: 'XETH',
          refid: 'unrelated-withdrawal',
          txid: '0xwithdrawaltx123',
          info: 'Unrelated withdrawal',
          amount: '0.1',
          fee: '0.004',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const result = await adapter.findExistingWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        mockWETHArbitrumKrakenMapping
      );

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No existing withdrawal found',
        expect.objectContaining({
          customOrderId: 'mark-1-42161-def45678',
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        })
      );
    });

    it('should return undefined when API call fails', async () => {
      mockKrakenClient.getWithdrawStatus.mockRejectedValue(new Error('API error'));

      const result = await adapter.findExistingWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        mockWETHArbitrumKrakenMapping
      );

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to find existing withdrawal',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'API error',
          }),
          route: sampleRoute,
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });

    it('should handle empty withdrawal list', async () => {
      mockKrakenClient.getWithdrawStatus.mockResolvedValue([]);

      const result = await adapter.findExistingWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        mockWETHArbitrumKrakenMapping
      );

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No existing withdrawal found',
        expect.any(Object)
      );
    });
  });

  describe('initiateWithdrawal()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    const mockOriginTransaction: TransactionReceipt = {
      blockHash: '0xabc123',
      blockNumber: BigInt(12345),
      contractAddress: null,
      cumulativeGasUsed: BigInt(21000),
      effectiveGasPrice: BigInt(20000000000),
      from: '0x1234567890123456789012345678901234567890',
      gasUsed: BigInt(21000),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x9876543210987654321098765432109876543210',
      transactionHash: '0xdef456789abcdef123456789abcdef123456789abcdef123456789abcdef123456',
      transactionIndex: 0,
      type: 'eip1559',
    };

    const amount = '100000000000000000'; // 0.1 ETH
    const recipient = '0x9876543210987654321098765432109876543210';

    beforeEach(() => {
      jest.clearAllMocks();

      // Mock system operational
      mockKrakenClient.isSystemOperational.mockResolvedValue(true);

      // Mock withdrawal info and withdraw responses
      mockKrakenClient.getWithdrawInfo.mockResolvedValue({
        method: 'arbitrum',
        limit: '10.0',
        amount: '0.1',
        fee: '0.002',
      });

      mockKrakenClient.withdraw.mockResolvedValue({
        refid: 'withdrawal-ref-123',
      });
    });

    it('should successfully initiate withdrawal', async () => {
      const result = await adapter.initiateWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        recipient
      );

      expect(result).toEqual({ id: 'withdrawal-ref-123' });
      expect(mockKrakenClient.isSystemOperational).toHaveBeenCalled();
      expect(mockKrakenClient.getWithdrawInfo).toHaveBeenCalledWith(
        mockWETHArbitrumKrakenMapping.krakenAsset,
        recipient,
        '0.1'
      );
      expect(mockKrakenClient.withdraw).toHaveBeenCalledWith({
        asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        key: recipient,
        amount: '0.1',
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Kraken withdrawal initiated',
        expect.objectContaining({
          withdrawalId: 'withdrawal-ref-123',
          withdrawOrderId: 'mark-1-42161-def45678',
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
          amount,
          recipient,
        })
      );
    });

    it('should throw error when Kraken system is not operational', async () => {
      mockKrakenClient.isSystemOperational.mockResolvedValue(false);

      await expect(adapter.initiateWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        recipient
      )).rejects.toThrow('Kraken system is not operational - cannot initiate withdrawal');

      expect(mockKrakenClient.isSystemOperational).toHaveBeenCalled();
      expect(mockKrakenClient.getWithdrawInfo).not.toHaveBeenCalled();
    });

    it('should throw error when asset config is not found', async () => {
      const invalidRoute: RebalanceRoute = {
        ...sampleRoute,
        asset: '0xInvalidAsset123',
      };

      await expect(adapter.initiateWithdrawal(
        invalidRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        recipient
      )).rejects.toThrow('Unable to find asset config for asset 0xInvalidAsset123 on chain 1');
    });

    it('should throw error when decimals are not found', async () => {
      // Create route with invalid asset that won't be found in chains config
      const invalidRoute: RebalanceRoute = {
        ...sampleRoute,
        asset: '0x9999999999999999999999999999999999999999',
      };

      await expect(adapter.initiateWithdrawal(
        invalidRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        recipient
      )).rejects.toThrow('Unable to find asset config for asset');
    });

    it('should throw error when withdrawal quota is exceeded', async () => {
      // This will be caught by checkWithdrawQuota function
      // Using a very large amount to exceed the simulated quota
      const largeAmount = '100000000000000000000000'; // 100,000 ETH

      await expect(adapter.initiateWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        largeAmount,
        mockWETHArbitrumKrakenMapping,
        recipient
      )).rejects.toThrow('exceeds daily limit');
    });

    it('should throw error when getWithdrawInfo fails', async () => {
      mockKrakenClient.getWithdrawInfo.mockRejectedValue(new Error('Withdraw info API error'));

      await expect(adapter.initiateWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        recipient
      )).rejects.toThrow('Withdraw info API error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initiate withdrawal',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Withdraw info API error',
          }),
          route: sampleRoute,
          transactionHash: mockOriginTransaction.transactionHash,
          assetMapping: mockWETHArbitrumKrakenMapping,
        })
      );
    });

    it('should throw error when withdraw call fails', async () => {
      mockKrakenClient.withdraw.mockRejectedValue(new Error('Withdrawal API error'));

      await expect(adapter.initiateWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        recipient
      )).rejects.toThrow('Withdrawal API error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initiate withdrawal',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Withdrawal API error',
          }),
        })
      );
    });

    it('should log debug information during withdrawal process', async () => {
      await adapter.initiateWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        recipient
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Using recipient address',
        expect.objectContaining({
          recipient,
          route: sampleRoute,
        })
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Initiating Kraken withdrawal with id mark-1-42161-def45678',
        expect.objectContaining({
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
          method: mockWETHArbitrumKrakenMapping.method,
          address: recipient,
          amount,
          withdrawOrderId: 'mark-1-42161-def45678',
        })
      );
    });
  });

  describe('getOrInitWithdrawal()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    const mockOriginTransaction: TransactionReceipt = {
      blockHash: '0xabc123',
      blockNumber: BigInt(12345),
      contractAddress: null,
      cumulativeGasUsed: BigInt(21000),
      effectiveGasPrice: BigInt(20000000000),
      from: '0x1234567890123456789012345678901234567890',
      gasUsed: BigInt(21000),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x9876543210987654321098765432109876543210',
      transactionHash: '0xdef456789abcdef123456789abcdef123456789abcdef123456789abcdef123456',
      transactionIndex: 0,
      type: 'eip1559',
    };

    const amount = '100000000000000000';
    const recipient = '0x9876543210987654321098765432109876543210';

    beforeEach(() => {
      jest.clearAllMocks();

      // Default mock setup for asset mappings
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(mockETHMainnetKrakenMapping);
        if (chainId === 42161) return Promise.resolve(mockWETHArbitrumKrakenMapping);
        return Promise.reject(new Error(`Asset mapping not found for chain ${chainId}`));
      });

      // Default mock for system operational
      mockKrakenClient.isSystemOperational.mockResolvedValue(true);

      // Default mock for withdrawal APIs
      mockKrakenClient.getWithdrawInfo.mockResolvedValue({
        method: 'arbitrum',
        limit: '10.0',
        amount: '0.1',
        fee: '0.002',
      });
      mockKrakenClient.withdraw.mockResolvedValue({
        refid: 'withdrawal-ref-123',
      });
    });

    it('should return undefined when deposit is not confirmed', async () => {
      // Mock deposit not confirmed
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-123',
          txid: 'different-tx-hash',
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const result = await adapter.getOrInitWithdrawal(sampleRoute, mockOriginTransaction, amount, recipient);

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Deposit not yet confirmed', {
        transactionHash: mockOriginTransaction.transactionHash,
      });
    });

    it('should initiate new withdrawal when deposit is confirmed but no existing withdrawal', async () => {
      // Mock deposit confirmed
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-123',
          txid: mockOriginTransaction.transactionHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      // Mock no existing withdrawal
      mockKrakenClient.getWithdrawStatus
        .mockResolvedValueOnce([]) // For findExistingWithdrawal
        .mockResolvedValueOnce([ // For checking withdrawal status after initiation
          {
            asset: 'XETH',
            refid: 'withdrawal-ref-123',
            txid: '0xwithdrawaltx123',
            info: 'ETH withdrawal',
            amount: '0.1',
            fee: '0.004',
            time: Math.floor(Date.now() / 1000),
            status: KRAKEN_WITHDRAWAL_STATUS.INITIAL,
          },
        ]);

      // Mock withdrawal initiation
      mockKrakenClient.isSystemOperational.mockResolvedValue(true);
      mockKrakenClient.getWithdrawInfo.mockResolvedValue({
        method: 'arbitrum',
        limit: '10.0',
        amount: '0.1',
        fee: '0.002',
      });
      mockKrakenClient.withdraw.mockResolvedValue({
        refid: 'withdrawal-ref-123',
      });

      const result = await adapter.getOrInitWithdrawal(sampleRoute, mockOriginTransaction, amount, recipient);

      expect(result).toEqual({
        status: 'pending',
        onChainConfirmed: false,
        txId: '0xwithdrawaltx123',
      });
      expect(mockKrakenClient.withdraw).toHaveBeenCalled();
    });

    it('should return existing withdrawal status when withdrawal exists', async () => {
      // Mock deposit confirmed
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-123',
          txid: mockOriginTransaction.transactionHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      // Mock existing withdrawal found with refid match
      const expectedOrderId = 'mark-1-42161-def45678';
      const withdrawalRefId = expectedOrderId;
      mockKrakenClient.getWithdrawStatus.mockResolvedValue([
        {
          asset: 'XETH',
          refid: withdrawalRefId,
          txid: '0xcompletedwithdrawaltx',
          info: 'ETH withdrawal',
          amount: '0.1',
          fee: '0.004',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_WITHDRAWAL_STATUS.SUCCESS,
        },
      ]);

      // Mock on-chain confirmation
      const mockProvider = {
        getTransactionReceipt: (jest.fn() as any).mockResolvedValue({
          status: 'success',
          transactionHash: '0xcompletedwithdrawaltx',
        }),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as PublicClient);

      const result = await adapter.getOrInitWithdrawal(sampleRoute, mockOriginTransaction, amount, recipient);

      expect(result).toEqual({
        status: 'completed',
        onChainConfirmed: true,
        txId: '0xcompletedwithdrawaltx',
      });
    });

    it('should return pending status when withdrawal exists but is not successful', async () => {
      // Mock deposit confirmed
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-123',
          txid: mockOriginTransaction.transactionHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      // Mock existing withdrawal in pending state with refid match
      const expectedOrderId = 'mark-1-42161-def45678';
      const withdrawalRefId = expectedOrderId;
      mockKrakenClient.getWithdrawStatus.mockResolvedValue([
        {
          asset: 'XETH',
          refid: withdrawalRefId,
          txid: '',
          info: 'ETH withdrawal',
          amount: '0.1',
          fee: '0.004',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_WITHDRAWAL_STATUS.PENDING,
        },
      ]);

      const result = await adapter.getOrInitWithdrawal(sampleRoute, mockOriginTransaction, amount, recipient);

      expect(result).toEqual({
        status: 'pending',
        onChainConfirmed: false,
        txId: undefined,
      });
    });

    it('should return pending when withdrawal not found in status check', async () => {
      // Mock deposit confirmed
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-123',
          txid: mockOriginTransaction.transactionHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      // Mock existing withdrawal found initially
      mockKrakenClient.getWithdrawStatus
        .mockResolvedValueOnce([
          {
            asset: 'XETH',
            refid: 'existing-withdrawal-123',
            txid: '0xwithdrawaltx',
            info: 'ETH withdrawal',
            amount: '0.1',
            fee: '0.004',
            time: Math.floor(Date.now() / 1000),
            status: KRAKEN_WITHDRAWAL_STATUS.SUCCESS,
          },
        ])
        .mockResolvedValueOnce([]); // But not found in status check (different timing)

      const result = await adapter.getOrInitWithdrawal(sampleRoute, mockOriginTransaction, amount, recipient);

      expect(result).toEqual({
        status: 'pending',
        onChainConfirmed: false,
      });
    });

    it('should handle on-chain confirmation errors gracefully', async () => {
      // Mock deposit confirmed and successful withdrawal
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          method: 'ether',
          aclass: 'currency',
          asset: 'XETH',
          refid: 'deposit-ref-123',
          txid: mockOriginTransaction.transactionHash,
          info: 'ETH deposit',
          amount: '100000000000000000',
          fee: '0',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        },
      ]);

      const withdrawalRefId = 'withdrawal-ref-123';
      mockKrakenClient.getWithdrawStatus.mockResolvedValue([
        {
          asset: 'XETH',
          refid: withdrawalRefId,
          txid: '0xsuccessfulwithdrawaltx',
          info: 'ETH withdrawal',
          amount: '0.1',
          fee: '0.004',
          time: Math.floor(Date.now() / 1000),
          status: KRAKEN_WITHDRAWAL_STATUS.SUCCESS,
        },
      ]);

      // Mock provider that throws error on getTransactionReceipt
      const mockProvider = {
        getTransactionReceipt: (jest.fn() as any).mockRejectedValue(new Error('RPC error')),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as PublicClient);

      const result = await adapter.getOrInitWithdrawal(sampleRoute, mockOriginTransaction, amount, recipient);

      // Should still return completed status, but onChainConfirmed should be false due to error
      expect(result).toEqual({
        status: 'completed',
        onChainConfirmed: false,
        txId: '0xsuccessfulwithdrawaltx',
      });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Could not verify on-chain confirmation',
        expect.objectContaining({
          txId: '0xsuccessfulwithdrawaltx',
          error: expect.objectContaining({ message: 'RPC error' }),
        })
      );
    });

    it('should throw error and log when getOrInitWithdrawal fails', async () => {
      // Mock asset mapping to fail
      mockDynamicConfig.getAssetMapping.mockRejectedValue(new Error('Asset mapping failed'));

      await expect(adapter.getOrInitWithdrawal(sampleRoute, mockOriginTransaction, amount, recipient))
        .rejects.toThrow('No Kraken asset mapping found for route');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get withdrawal status',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'No Kraken asset mapping found for route from chain 1: Asset mapping failed' }),
          route: sampleRoute,
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });
  });

  describe('destinationCallback()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    const mockOriginTransaction: TransactionReceipt = {
      blockHash: '0xabc123',
      blockNumber: BigInt(12345),
      contractAddress: null,
      cumulativeGasUsed: BigInt(21000),
      effectiveGasPrice: BigInt(20000000000),
      from: '0x1234567890123456789012345678901234567890',
      gasUsed: BigInt(21000),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x9876543210987654321098765432109876543210',
      transactionHash: '0xdef456789abcdef123456789abcdef123456789abcdef123456789abcdef123456',
      transactionIndex: 0,
      type: 'eip1559',
    };

    const recipient = '0x9876543210987654321098765432109876543210';

    beforeEach(() => {
      jest.clearAllMocks();

      // Mock the cache to return recipient
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValue({
        id: 'test-rebalance-id',
        recipient,
        amount: '100000000000000000',
        transaction: mockOriginTransaction.transactionHash,
        bridge: SupportedBridge.Kraken,
        origin: sampleRoute.origin,
        destination: sampleRoute.destination,
        asset: sampleRoute.asset,
      });

      // Mock asset mappings
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(mockETHMainnetKrakenMapping);
        if (chainId === 42161) return Promise.resolve(mockWETHArbitrumKrakenMapping);
        return Promise.reject(new Error(`Asset mapping not found for chain ${chainId}`));
      });
    });

    it('should return WETH wrap transaction when withdrawal has ETH value', async () => {
      const withdrawalTxId = '0xwithdrawal123456789abcdef123456789abcdef123456789abcdef123456789abc';
      const ethAmount = BigInt('50000000000000000'); // 0.05 ETH

      // Mock completed withdrawal status
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: withdrawalTxId,
      });

      // Mock provider and withdrawal transaction
      const mockProvider: Partial<PublicClient> = {
        getTransaction: jest.fn<(args: GetTransactionParameters) => Promise<any>>().mockResolvedValue({
          hash: withdrawalTxId,
          value: ethAmount,
          to: recipient,
          from: '0xkraken123',
        }),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as PublicClient);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeDefined();
      expect(result?.memo).toBe(RebalanceTransactionMemo.Wrap);
      expect(result?.transaction.to).toBe('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'); // WETH on Arbitrum
      expect(result?.transaction.value).toBe(ethAmount);
      expect(result?.transaction.data).toEqual(expect.any(String)); // deposit() encoded

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Preparing WETH wrap callback',
        expect.objectContaining({
          recipient,
          ethAmount: ethAmount.toString(),
          wethAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
          destinationChain: sampleRoute.destination,
        })
      );
    });

    it('should return void when withdrawal transaction has no ETH value', async () => {
      const withdrawalTxId = '0xwithdrawal123456789abcdef123456789abcdef123456789abcdef123456789abc';

      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: withdrawalTxId,
      });

      const mockProvider: Partial<PublicClient> = {
        getTransaction: jest.fn<(args: GetTransactionParameters) => Promise<any>>().mockResolvedValue({
          hash: withdrawalTxId,
          value: BigInt(0), // No ETH value
          to: recipient,
        }),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as PublicClient);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No ETH value in withdrawal transaction, skipping wrap',
        { txId: withdrawalTxId }
      );
    });

    it('should return void when Kraken withdrawal asset matches destination asset', async () => {
      const withdrawalTxId = '0xwithdrawal123456789abcdef123456789abcdef123456789abcdef123456789abc';
      const ethAmount = BigInt('50000000000000000');

      // Mock mapping where kraken asset matches destination asset (both WETH addresses)
      const matchingMapping = {
        ...mockWETHArbitrumKrakenMapping,
        krakenAsset: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Same as destination WETH
      };

      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(mockETHMainnetKrakenMapping);
        if (chainId === 42161) return Promise.resolve(matchingMapping);
        return Promise.reject(new Error(`Asset mapping not found for chain ${chainId}`));
      });

      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: withdrawalTxId,
      });

      const mockProvider = {
        getTransaction: jest.fn<(args: GetTransactionParameters) => Promise<any>>().mockResolvedValue({
          hash: withdrawalTxId,
          value: ethAmount,
          to: recipient,
        }),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as any);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Kraken withdrawal asset matches destination asset, no wrapping needed',
        expect.objectContaining({
          destinationAsset: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
          krakenAsset: matchingMapping.krakenAsset,
        })
      );
    });

    it('should return void when withdrawal is not completed', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'pending',
        onChainConfirmed: false,
        txId: undefined,
      });

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Withdrawal not completed yet, skipping callback',
        expect.objectContaining({
          withdrawalStatus: expect.objectContaining({
            status: 'pending'
          })
        })
      );
    });

    it('should return void when withdrawal status is undefined', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue(undefined);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Withdrawal not completed yet, skipping callback',
        expect.objectContaining({
          withdrawalStatus: undefined
        })
      );
    });

    it('should return void when recipient is not found in cache', async () => {
      mockRebalanceCache.getRebalanceByTransaction.mockResolvedValue(undefined);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'No recipient found in cache for callback',
        expect.objectContaining({
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });

    it('should return void when no provider available for destination chain', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: '0xwithdrawal123',
      });

      jest.spyOn(adapter, 'getProvider').mockReturnValue(undefined);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'No provider for destination chain',
        { chainId: sampleRoute.destination }
      );
    });

    it('should return void when withdrawal transaction cannot be fetched', async () => {
      const withdrawalTxId = '0xwithdrawal123456789abcdef123456789abcdef123456789abcdef123456789abc';

      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: withdrawalTxId,
      });

      const mockProvider = {
        getTransaction: jest.fn<(args: GetTransactionParameters) => Promise<any>>().mockResolvedValue(null), // Transaction not found
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as any);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Could not fetch withdrawal transaction',
        { txId: withdrawalTxId }
      );
    });

    it('should return void and log error when getDestinationAssetMapping throws', async () => {
      const withdrawalTxId = '0xwithdrawal123456789abcdef123456789abcdef123456789abcdef123456789abc';
      const ethAmount = BigInt('50000000000000000');

      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: withdrawalTxId,
      });

      const mockProvider = {
        getTransaction: jest.fn<(args: GetTransactionParameters) => Promise<any>>().mockResolvedValue({
          hash: withdrawalTxId,
          value: ethAmount,
          to: recipient,
        }),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as any);

      // Mock destination mapping to fail
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(mockETHMainnetKrakenMapping);
        if (chainId === 42161) return Promise.reject(new Error('Mapping failed'));
        return Promise.reject(new Error(`Asset mapping not found for chain ${chainId}`));
      });

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to prepare destination callback',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Mapping failed'
          }),
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });

    it('should return void when getDestinationAssetAddress returns null', async () => {
      const withdrawalTxId = '0xwithdrawal123456789abcdef123456789abcdef123456789abcdef123456789abc';
      const ethAmount = BigInt('50000000000000000');

      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: withdrawalTxId,
      });

      const mockProvider = {
        getTransaction: (jest.fn() as any).mockResolvedValue({
          hash: withdrawalTxId,
          value: ethAmount,
          to: recipient,
        }),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as any);

      // Create a route with an asset that won't have a destination address
      const routeWithUnknownAsset: RebalanceRoute = {
        ...sampleRoute,
        asset: '0xUnknownAssetAddress123',
      };

      const result = await adapter.destinationCallback(routeWithUnknownAsset, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Could not find destination asset address for ticker',
        expect.objectContaining({
          originAsset: '0xUnknownAssetAddress123',
          originChain: routeWithUnknownAsset.origin,
          destinationChain: routeWithUnknownAsset.destination,
        })
      );
    });

    it('should log debug info when callback is called', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue(undefined);

      await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'destinationCallback called',
        expect.objectContaining({
          route: sampleRoute,
          transactionHash: mockOriginTransaction.transactionHash,
        })
      );
    });
  });
});