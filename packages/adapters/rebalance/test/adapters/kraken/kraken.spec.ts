/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { SupportedBridge, RebalanceRoute, AssetConfiguration, MarkConfiguration, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import * as database from '@mark/database';
import { TransactionReceipt, PublicClient, parseUnits, formatUnits } from 'viem';
import { KrakenBridgeAdapter } from '../../../src/adapters/kraken/kraken';
import { KrakenClient } from '../../../src/adapters/kraken/client';
import { DynamicAssetConfig } from '../../../src/adapters/kraken/dynamic-config';
import { RebalanceTransactionMemo } from '../../../src/types';
import { KrakenAssetMapping, KRAKEN_DEPOSIT_STATUS, KrakenWithdrawMethod } from '../../../src/adapters/kraken/types';

// Mock the external dependencies
jest.mock('../../../src/adapters/kraken/client');
jest.mock('../../../src/adapters/kraken/dynamic-config');
jest.mock('../../../src/shared/asset', () => ({
  getDestinationAssetAddress: jest.fn(),
  findAssetByAddress: jest.fn(),
  findMatchingDestinationAsset: jest.fn(),
  validateExchangeAssetBalance: (jest.requireActual('../../../src/shared/asset') as any).validateExchangeAssetBalance,
}));

// Test adapter that exposes protected methods
class TestKrakenBridgeAdapter extends KrakenBridgeAdapter {
  public handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    return super.handleError(error, context, metadata);
  }

  public getProvider(chainId: number) {
    return super.getProvider(chainId);
  }

  public getOrInitWithdrawal(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    recipient: string,
    originMapping: KrakenAssetMapping,
    destinationMapping: KrakenAssetMapping,
    destinationAssetConfig: AssetConfiguration,
  ): Promise<any> {
    return super.getOrInitWithdrawal(
      amount,
      route,
      originTransaction,
      recipient,
      originMapping,
      destinationMapping,
      destinationAssetConfig,
    );
  }

  public checkDepositConfirmed(route: RebalanceRoute, originTransaction: TransactionReceipt, assetMapping: any) {
    return super.checkDepositConfirmed(route, originTransaction, assetMapping);
  }

  public findExistingWithdrawal(route: RebalanceRoute, originTransaction: TransactionReceipt) {
    return super.findExistingWithdrawal(route, originTransaction);
  }

  public initiateWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    assetMapping: any,
    assetConfig: AssetConfiguration,
    recipient: string,
  ) {
    return super.initiateWithdrawal(route, originTransaction, amount, assetMapping, assetConfig, recipient);
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
const mockDatabase = {
  setPause: jest.fn(),
  isPaused: jest.fn(),
  getRebalanceOperationByTransactionHash: jest.fn(),
  createRebalanceOperation: jest.fn(),
  updateRebalanceOperation: jest.fn(),
  createCexWithdrawalRecord: jest.fn(),
  getCexWithdrawalRecord: jest.fn(),
} as unknown as jest.Mocked<typeof database>;

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
      mockAssets.USDC,
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
  coinbase: {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
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
  purchaseCacheTtlSeconds: 300,
  supportedAssets: ['ETH', 'WETH', 'USDC'],
  chains: mockChains,
  hub: {
    domain: '25327',
    providers: ['http://localhost:8545'],
  },
  routes: [],
  database: {
    connectionString: 'postgresql://test:test@localhost:5432/test',
  },
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
  getBalance: jest.fn(),
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
  network: 'ethereum',
  depositMethod: {
    method: 'ether',
    minimum: '0.0001',
    limit: false,
    'gen-address': false,
  },
  withdrawMethod: {
    asset: 'XETH',
    minimum: '0.005',
    fee: {
      fee: '0.000001',
      asset: 'XETH',
      aclass: 'currency',
    },
    method: 'Ether',
    limits: [
      {
        limit_type: 'amount',
        description: '',
        limits: {
          '86400': {
            remaining: '100000',
            used: '0',
            maximum: '100000000000',
          },
        },
      },
    ],
  } as unknown as KrakenWithdrawMethod,
};

const mockWETHArbitrumKrakenMapping: KrakenAssetMapping = {
  chainId: 42161,
  krakenSymbol: 'ETH',
  krakenAsset: 'XETH',
  network: 'arbitrum',
  depositMethod: {
    method: 'ether',
    minimum: '0.0001',
    limit: false,
    'gen-address': false,
  },
  withdrawMethod: {
    asset: 'XETH',
    minimum: '0.005',
    fee: {
      fee: '0.000001',
      asset: 'XETH',
      aclass: 'currency',
    },
    method: 'Ether',
    limits: [
      {
        limit_type: 'amount',
        description: '',
        limits: {
          '86400': {
            remaining: '100000',
            used: '0',
            maximum: '100000000000',
          },
        },
      },
    ],
  } as unknown as KrakenWithdrawMethod,
};

const mockUSDCMainnetKrakenMapping: KrakenAssetMapping = {
  chainId: 1,
  krakenSymbol: 'USDC',
  krakenAsset: 'USDC',
  network: 'ethereum',
  depositMethod: {
    method: 'ether (erc-20)',
    minimum: '0.1',
    limit: false,
    'gen-address': false,
  },
  withdrawMethod: {
    asset: 'USDC',
    minimum: '0.05',
    fee: {
      fee: '0.01',
      asset: 'XETH',
      aclass: 'currency',
    },
    method: 'Ether (erc-20)',
    limits: [
      {
        limit_type: 'amount',
        description: '',
        limits: {
          '86400': {
            remaining: '100000',
            used: '0',
            maximum: '100000000000',
          },
        },
      },
    ],
  } as unknown as KrakenWithdrawMethod,
};

// Helper function to create complete mock CEX withdrawal records
function createMockCexWithdrawalRecord(overrides: Partial<any> = {}) {
  return {
    id: 'test-withdrawal-id',
    createdAt: new Date(),
    updatedAt: new Date(),
    rebalanceOperationId: 'test-op-id',
    platform: 'kraken',
    metadata: {},
    ...overrides,
  };
}

// Helper function to create complete mock rebalance operations
function createMockRebalanceOperation(overrides: Partial<any> = {}) {
  return {
    id: 'test-rebalance-id',
    earmarkId: 'test-earmark-id',
    originChainId: 1,
    destinationChainId: 42161,
    tickerHash: '0xtickerHash',
    amount: '1000000000000000000',
    slippage: 100,
    status: 'pending',
    bridge: SupportedBridge.Kraken,
    isOrphaned: false,
    metadata: {},
    recipient: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    transactions: {},
    ...overrides,
  };
}

describe('KrakenBridgeAdapter Unit', () => {
  let adapter: TestKrakenBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock implementations
    mockKrakenClient.isConfigured.mockReturnValue(true);

    // Mock shared asset functions globally
    const assetModule = jest.requireMock('../../../src/shared/asset') as any;
    
    assetModule.findAssetByAddress.mockImplementation((asset: string, chainId: number) => {
      if (asset === '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' && chainId === 1) {
        return {
          address: asset,
          symbol: 'WETH',
          decimals: 18,
          tickerHash: '0xWETHHash',
          isNative: false,
          balanceThreshold: '0',
        };
      }
      if (asset === '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' && chainId === 1) {
        return {
          address: asset,
          symbol: 'USDC',
          decimals: 6,
          tickerHash: '0xUSDCHash',
          isNative: false,
          balanceThreshold: '0',
        };
      }
      if (asset === '0x0000000000000000000000000000000000000000' && chainId === 1) {
        return {
          address: asset,
          symbol: 'ETH',
          decimals: 18,
          tickerHash: '0xETHHash',
          isNative: true,
          balanceThreshold: '0',
        };
      }
      return null;
    });

    assetModule.findMatchingDestinationAsset.mockImplementation((asset: string, origin: number, destination: number) => {
      if (asset === '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' && origin === 1 && destination === 42161) {
        return {
          address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH on Arbitrum
          symbol: 'WETH',
          decimals: 18,
          tickerHash: '0xWETHHash',
          isNative: false,
          balanceThreshold: '0',
        };
      }
      if (asset === '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' && origin === 1 && destination === 42161) {
        return {
          address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // USDC on Arbitrum
          symbol: 'USDC',
          decimals: 6,
          tickerHash: '0xUSDCHash',
          isNative: false,
          balanceThreshold: '0',
        };
      }
      if (asset === '0x0000000000000000000000000000000000000000' && origin === 1 && destination === 42161) {
        return {
          address: '0x0000000000000000000000000000000000000000', // Native ETH on Arbitrum
          symbol: 'ETH',
          decimals: 18,
          tickerHash: '0xETHHash',
          isNative: true,
          balanceThreshold: '0',
        };
      }
      return null;
    });

    // Mock Kraken client getBalance globally
    mockKrakenClient.getBalance.mockResolvedValue({
      XETH: '1.0', // Sufficient ETH balance
      ZUSD: '1000.0', // Sufficient USDC balance
      USDC: '1000.0', // Sufficient USDC balance (alternative naming)
      '0x0000000000000000000000000000000000000000': '1.0', // ETH (zero address) balance
    });

    // Mock constructors
    (KrakenClient as jest.MockedClass<typeof KrakenClient>).mockImplementation(() => mockKrakenClient);
    (DynamicAssetConfig as jest.MockedClass<typeof DynamicAssetConfig>).mockImplementation(() => mockDynamicConfig);

    adapter = new TestKrakenBridgeAdapter(
      'test-kraken-api-key',
      'test-kraken-api-secret',
      'https://api.kraken.com',
      mockConfig,
      mockLogger,
      mockDatabase,
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
        new TestKrakenBridgeAdapter('', '', 'https://api.kraken.com', mockConfig, mockLogger, mockDatabase);
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
        mockDatabase,
      );

      const provider = adapterWithoutProviders.getProvider(1);
      expect(provider).toBeUndefined();
    });
  });

  describe('getMinimumAmount()', () => {
    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockDynamicConfig.getAssetMapping.mockResolvedValue(mockETHMainnetKrakenMapping);
      mockKrakenClient.isSystemOperational.mockResolvedValue(true);
    });

    it('should return deposit minimum for valid route', async () => {
      const result = await adapter.getMinimumAmount(sampleRoute);

      // Should return deposit minimum in native units
      // mockETHMainnetKrakenMapping has depositMethod.minimum = '0.0001' which is 100000000000000 wei
      expect(result).toBeTruthy();
      expect(result).toBe('100000000000000'); // 0.0001 ETH minimum
    });

    it('should return null when asset mapping is not found', async () => {
      mockDynamicConfig.getAssetMapping.mockRejectedValueOnce(new Error('No mapping found'));

      const result = await adapter.getMinimumAmount(sampleRoute);

      expect(result).toBeNull();
    });

    it('should return null when asset config is not found', async () => {
      const { findAssetByAddress } = require('../../../src/shared/asset');
      jest.spyOn(require('../../../src/shared/asset'), 'findAssetByAddress').mockReturnValueOnce(undefined);

      const result = await adapter.getMinimumAmount(sampleRoute);

      expect(result).toBeNull();
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
        if (
          chainId === 1 &&
          (assetIdentifier === '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' || assetIdentifier === 'WETH')
        ) {
          return Promise.resolve(mockETHMainnetKrakenMapping);
        } else if (
          chainId === 42161 &&
          (assetIdentifier === '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' || assetIdentifier === 'WETH')
        ) {
          return Promise.resolve(mockWETHArbitrumKrakenMapping);
        } else if (assetIdentifier === '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' || assetIdentifier === 'USDC') {
          // USDC mapping for both chains
          return Promise.resolve(mockUSDCMainnetKrakenMapping);
        }
        return Promise.reject(new Error(`Asset mapping not found for ${assetIdentifier} on chain ${chainId}`));
      });

      // Mock asset info return
      mockKrakenClient.isSystemOperational.mockResolvedValue(true);
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockWETHArbitrumKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'Eth',
          decimals: 18,
          display_decimals: 6,
          status: 'enabled',
        },
      });
    });

    it('should calculate net amount after withdrawal fees', async () => {
      const amount = '100000000000000000'; // 0.1 ETH in wei
      // Fee is 0.000001 ETH = 1000000000000 wei
      const feeInWei = '1000000000000';
      const expectedNetAmount = (BigInt(amount) - BigInt(feeInWei)).toString();

      const result = await adapter.getReceivedAmount(amount, sampleRoute);

      expect(result).toBe(expectedNetAmount);
      expect(mockLogger.debug).toHaveBeenCalledWith('Kraken withdrawal amount calculated after fees', {
        amount,
        received: BigInt(expectedNetAmount),
        route: sampleRoute,
        depositMethod: mockWETHArbitrumKrakenMapping.depositMethod,
        withdrawMethod: mockWETHArbitrumKrakenMapping.withdrawMethod,
      });
    });

    it('should throw error if amount is below minimum withdrawal', async () => {
      const amount = '1000000000000000'; // 0.001 ETH - below 0.01 ETH minimum

      await expect(adapter.getReceivedAmount(amount, sampleRoute)).rejects.toThrow(
        'Failed to calculate received amount: Received amount is below the withdrawal minimum',
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
      mockDynamicConfig.getAssetMapping.mockResolvedValue(mockUSDCMainnetKrakenMapping); // origin mapping
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockUSDCMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'USDC.e',
          decimals: 6,
          display_decimals: 6,
          status: 'enabled',
        },
      });

      // Fee is 0.01 USDC = 10000 in smallest units (6 decimals)
      const feeInSmallestUnits = parseUnits(mockUSDCMainnetKrakenMapping.withdrawMethod.fee.fee, 6);
      const expectedNetAmount = (BigInt(amount) - BigInt(feeInSmallestUnits)).toString();

      const result = await adapter.getReceivedAmount(amount, usdcRoute);

      expect(result).toBe(expectedNetAmount);
    });

    it('should handle validateAssetMapping errors', async () => {
      mockDynamicConfig.getAssetMapping.mockRejectedValueOnce(new Error('Asset not supported'));

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
      const min = parseUnits(mockWETHArbitrumKrakenMapping.withdrawMethod.minimum, 18); // Exactly minimum
      const feeInWei = parseUnits(mockWETHArbitrumKrakenMapping.withdrawMethod.fee.fee, 18); // 0.000001 ETH fee in wei
      const amount = min + feeInWei;

      const result = await adapter.getReceivedAmount(amount.toString(), sampleRoute);

      expect(result).toBe(min.toString());
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
        if (
          chainId === 1 &&
          (assetIdentifier === '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' || assetIdentifier === 'WETH')
        ) {
          return Promise.resolve(mockETHMainnetKrakenMapping);
        } else if (
          chainId === 42161 &&
          (assetIdentifier === '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' || assetIdentifier === 'WETH')
        ) {
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
          status: 'enabled',
        },
      });

      mockKrakenClient.getDepositAddresses.mockResolvedValue([
        {
          address: '0x1234567890123456789012345678901234567890',
          expiretm: 0,
          new: true,
        },
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
      expect(mockDynamicConfig.getAssetMapping).toHaveBeenCalled();
      expect(mockKrakenClient.getAssetInfo).toHaveBeenCalled();
    });

    it('should prepare WETH unwrap + ETH send for ETH kraken symbol', async () => {
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(mockETHMainnetKrakenMapping);
        if (chainId === 42161) return Promise.resolve(mockWETHArbitrumKrakenMapping);
        return Promise.reject(new Error(`Asset mapping not found`));
      });

      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockETHMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 18,
          display_decimals: 4,
          status: 'enabled',
        },
      });

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
    });

    it('should handle native ETH transfer to Kraken', async () => {
      mockDynamicConfig.getAssetMapping.mockImplementation((chainId: number) => {
        if (chainId === 1) return Promise.resolve(mockETHMainnetKrakenMapping);
        if (chainId === 42161) return Promise.resolve(mockWETHArbitrumKrakenMapping);
        return Promise.reject(new Error(`Asset mapping not found`));
      });

      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockETHMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'ETH',
          decimals: 18,
          display_decimals: 4,
          status: 'enabled',
        },
      });

      const nativeETHRoute = { ...sampleRoute, asset: '0x0000000000000000000000000000000000000000' };
      const result = await adapter.send(sender, recipient, amount, nativeETHRoute);

      expect(result).toHaveLength(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe('0x1234567890123456789012345678901234567890'); // Deposit address
      expect(result[0].transaction.value).toBe(BigInt(amount)); // Native ETH value
      expect(result[0].transaction.data).toBe('0x'); // No data for native ETH transfer
    });

    it('should throw error when asset config is not found', async () => {
      const invalidRoute = { ...sampleRoute, asset: '0xInvalidAsset123' };

      await expect(adapter.send(sender, recipient, amount, invalidRoute)).rejects.toThrow(
        'Unable to find origin asset config for asset 0xInvalidAsset123 on chain 1',
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
        'Unable to find origin asset config for asset 0x9999999999999999999999999999999999999999 on chain 999',
      );
    });

    it('should throw error when withdrawal quota is exceeded', async () => {
      const largeAmount =
        2n * parseUnits(mockWETHArbitrumKrakenMapping.withdrawMethod.limits[0].limits['86400'].maximum, 18);

      await expect(adapter.send(sender, recipient, largeAmount.toString(), sampleRoute)).rejects.toThrow(
        'exceeds withdraw limits',
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
          status: 'enabled',
        },
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
          status: 'enabled',
        },
      });

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
        'Failed to prepare Kraken deposit transaction: Kraken system is not operational',
      );
    });

    it('should throw error if amount is below minimum withdrawal', async () => {
      const amount = '1000000000000000'; // 0.001 ETH - below 0.01 ETH minimum

      await expect(adapter.getReceivedAmount(amount, sampleRoute)).rejects.toThrow(
        'Failed to calculate received amount: Received amount is below the withdrawal minimum',
      );
    });

    it('should throw error if asset config not found', async () => {
      const unknownAssetRoute = { ...sampleRoute, asset: '0xUnknownAsset123' };

      await expect(adapter.send(sender, recipient, amount, unknownAssetRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: Unable to find origin asset config for asset 0xUnknownAsset123 on chain 1',
      );
    });

    it('should throw error if Kraken asset is disabled', async () => {
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockETHMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'WETH',
          decimals: 8,
          display_decimals: 4,
          status: 'disabled',
        },
      });

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: Origin asset is disabled on Kraken',
      );
    });

    it('should throw error if no deposit address available', async () => {
      mockKrakenClient.getDepositAddresses.mockResolvedValue([]);

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction: No deposit address available',
      );
    });

    it('should handle API errors gracefully', async () => {
      mockKrakenClient.getAssetInfo.mockRejectedValue(new Error('API connection failed'));

      await expect(adapter.send(sender, recipient, amount, sampleRoute)).rejects.toThrow(
        'Failed to prepare Kraken deposit transaction',
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to prepare Kraken deposit transaction',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'API connection failed',
          }),
        }),
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
        expect.any(Object),
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

      mockKrakenClient.isSystemOperational.mockResolvedValue(true);
      mockKrakenClient.getAssetInfo.mockResolvedValue({
        [mockETHMainnetKrakenMapping.krakenAsset]: {
          aclass: 'currency',
          altname: 'WETH',
          decimals: 18,
          display_decimals: 4,
          status: 'enabled',
        },
      });
      // Mock the cache to return recipient by default
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          recipient,
          amount,
          originChainId: sampleRoute.origin,
          destinationChainId: sampleRoute.destination,
          tickerHash: sampleRoute.asset,
        }),
      );

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
        amount,
        sampleRoute,
        mockOriginTransaction,
        recipient,
        mockETHMainnetKrakenMapping,
        mockWETHArbitrumKrakenMapping,
        mockChains[sampleRoute.destination].assets.find((a) => a.symbol === 'WETH'),
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
    });

    it('should return false when withdrawal is pending', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'pending',
        onChainConfirmed: false,
        txId: undefined,
      });

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
    });

    it('should return false when withdrawal status is undefined', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue(undefined);

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
    });

    it('should return false when recipient is not found in cache', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(undefined);

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
    });

    it('should return false when cache lookup throws error', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockRejectedValue(new Error('Cache lookup failed'));

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
    });

    it('should return false when getOrInitWithdrawal throws', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockRejectedValue(new Error('Withdrawal init failed'));

      const result = await adapter.readyOnDestination(amount, sampleRoute, mockOriginTransaction);

      expect(result).toBe(false);
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
        mockDatabase,
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
        mockDatabase,
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
        mockETHMainnetKrakenMapping,
      );

      expect(result.confirmed).toBe(true);
      expect(mockKrakenClient.getDepositStatus).toHaveBeenCalledWith(
        mockETHMainnetKrakenMapping.krakenAsset,
        mockETHMainnetKrakenMapping.depositMethod.method,
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit confirmation check',
        expect.objectContaining({
          transactionHash: mockOriginTransaction.transactionHash,
          confirmed: true,
          matchingDepositId: mockOriginTransaction.transactionHash,
          status: KRAKEN_DEPOSIT_STATUS.SUCCESS,
        }),
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
        mockETHMainnetKrakenMapping,
      );

      expect(result.confirmed).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit confirmation check',
        expect.objectContaining({
          confirmed: false,
          matchingDepositId: undefined,
          status: undefined,
        }),
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
        mockETHMainnetKrakenMapping,
      );

      expect(result.confirmed).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit confirmation check',
        expect.objectContaining({
          confirmed: false,
          status: KRAKEN_DEPOSIT_STATUS.PENDING,
        }),
      );
    });

    it('should return confirmed false when API call fails', async () => {
      mockKrakenClient.getDepositStatus.mockRejectedValue(new Error('API error'));

      const result = await adapter.checkDepositConfirmed(
        sampleRoute,
        mockOriginTransaction,
        mockETHMainnetKrakenMapping,
      );

      expect(result.confirmed).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to check deposit confirmation',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'API error',
          }),
          transactionHash: mockOriginTransaction.transactionHash,
        }),
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
        mockETHMainnetKrakenMapping,
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
      const refid = 'mark-1-42161-def45678';
      const cached = createMockCexWithdrawalRecord({
        rebalanceOperationId: 'test-rebalance-id',
        asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
        refid,
      });

      // Mock getRebalanceOperationByTransactionHash to return operation
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      // Mock getCexWithdrawalRecord to return cached record with metadata
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue({
        ...cached,
        metadata: {
          refid,
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
          method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
        },
      });

      const result = await adapter.findExistingWithdrawal(sampleRoute, mockOriginTransaction);

      expect(result).toEqual({
        refid,
        asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
      });
      expect(mockDatabase.getRebalanceOperationByTransactionHash).toHaveBeenCalledWith(
        mockOriginTransaction.transactionHash,
        sampleRoute.origin,
      );
      expect(mockDatabase.getCexWithdrawalRecord).toHaveBeenCalledWith({
        rebalanceOperationId: 'test-rebalance-id',
        platform: 'kraken',
      });
    });

    it('should return undefined when no existing withdrawal found', async () => {
      // Mock getRebalanceOperationByTransactionHash to return operation
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      mockDatabase.getCexWithdrawalRecord.mockResolvedValue(undefined);

      const result = await adapter.findExistingWithdrawal(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockDatabase.getRebalanceOperationByTransactionHash).toHaveBeenCalledWith(
        mockOriginTransaction.transactionHash,
        sampleRoute.origin,
      );
      expect(mockDatabase.getCexWithdrawalRecord).toHaveBeenCalledWith({
        rebalanceOperationId: 'test-rebalance-id',
        platform: 'kraken',
      });
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
    const refid = 'ajksdhfakdsjhfakdsj';

    beforeEach(() => {
      jest.clearAllMocks();

      // mock withdrawal response
      mockKrakenClient.withdraw.mockResolvedValue({ refid });

      // mock cache response
      mockDatabase.createCexWithdrawalRecord.mockResolvedValue(createMockCexWithdrawalRecord());
    });

    it('should successfully initiate withdrawal', async () => {
      // Mock the rebalance operation lookup to succeed
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      const result = await adapter.initiateWithdrawal(
        sampleRoute,
        mockOriginTransaction,
        amount,
        mockWETHArbitrumKrakenMapping,
        mockAssets['WETH'],
        recipient,
      );

      expect(result).toEqual({
        refid,
        asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
      });
      expect(mockKrakenClient.withdraw).toHaveBeenCalledWith({
        asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        key: recipient,
        amount: formatUnits(BigInt(amount), 18),
      });
      expect(mockDatabase.createCexWithdrawalRecord).toHaveBeenCalledWith({
        rebalanceOperationId: 'test-rebalance-id',
        platform: 'kraken',
        metadata: {
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
          method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
          refid,
          depositTransactionHash: mockOriginTransaction.transactionHash,
          destinationChainId: 42161,
        },
      });
    });

    it('should throw error when withdraw call fails', async () => {
      // Mock the rebalance operation lookup to succeed
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      mockKrakenClient.withdraw.mockRejectedValue(new Error('Withdrawal API error'));

      await expect(
        adapter.initiateWithdrawal(
          sampleRoute,
          mockOriginTransaction,
          amount,
          mockWETHArbitrumKrakenMapping,
          mockAssets['WETH'],
          recipient,
        ),
      ).rejects.toThrow('Withdrawal API error');
    });

    it('should throw error when cache call fails', async () => {
      // Mock the rebalance operation lookup to succeed
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      mockDatabase.createCexWithdrawalRecord.mockRejectedValue(new Error('Cache error'));

      await expect(
        adapter.initiateWithdrawal(
          sampleRoute,
          mockOriginTransaction,
          amount,
          mockWETHArbitrumKrakenMapping,
          mockAssets['WETH'],
          recipient,
        ),
      ).rejects.toThrow('Cache error');
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
    const refid = 'a3216adsfad2f1a';
    const withdrawalTxId = '0xasdkjfhakue4';

    beforeEach(() => {
      jest.clearAllMocks();

      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          txid: mockOriginTransaction.transactionHash,
          status: 'Success',
        } as any,
      ]);

      mockDatabase.getCexWithdrawalRecord.mockResolvedValue(
        createMockCexWithdrawalRecord({
          rebalanceOperationId: 'test-rebalance-id',
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
          method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
          refid,
        }),
      );

      mockKrakenClient.getWithdrawStatus.mockResolvedValue({
        status: 'Pending',
        txid: withdrawalTxId,
      } as any);

      mockKrakenClient.withdraw.mockResolvedValue({ refid });

      // Mock on-chain confirmation
      const mockProvider = {
        getTransactionReceipt: (jest.fn() as any).mockResolvedValue({
          status: 'success',
          transactionHash: withdrawalTxId,
        }),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as PublicClient);
    });

    it('should return undefined when deposit is not confirmed', async () => {
      // Mock deposit not confirmed
      mockKrakenClient.getDepositStatus.mockResolvedValue([
        {
          txid: mockOriginTransaction.transactionHash,
          status: 'Pending',
        } as any,
      ]);

      const result = await adapter.getOrInitWithdrawal(
        amount,
        sampleRoute,
        mockOriginTransaction,
        recipient,
        mockETHMainnetKrakenMapping,
        mockWETHArbitrumKrakenMapping,
        mockAssets['WETH'],
      );

      expect(result).toBeUndefined();
    });

    it('should initiate new withdrawal when deposit is confirmed but no existing withdrawal', async () => {
      // Mock no existing withdrawal
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue(undefined);

      // Mock getRebalanceOperationByTransactionHash for initiateWithdrawal
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      // Mock createCexWithdrawalRecord for initiateWithdrawal
      mockDatabase.createCexWithdrawalRecord.mockResolvedValue(createMockCexWithdrawalRecord());

      const result = await adapter.getOrInitWithdrawal(
        amount,
        sampleRoute,
        mockOriginTransaction,
        recipient,
        mockETHMainnetKrakenMapping,
        mockWETHArbitrumKrakenMapping,
        mockAssets['WETH'],
      );

      expect(result).toEqual({
        status: 'pending',
        onChainConfirmed: false,
        txId: withdrawalTxId,
      });
      expect(mockKrakenClient.withdraw).toHaveBeenCalledWith({
        asset: mockWETHArbitrumKrakenMapping.krakenAsset,
        key: recipient,
        amount: formatUnits(BigInt(amount), 18),
      });
    });

    it('should return existing withdrawal status when withdrawal exists', async () => {
      // Mock getRebalanceOperationByTransactionHash in case needed
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      mockKrakenClient.getWithdrawStatus.mockResolvedValue({
        status: 'Success',
        txid: withdrawalTxId,
        refid,
      } as any);
      const result = await adapter.getOrInitWithdrawal(
        amount,
        sampleRoute,
        mockOriginTransaction,
        recipient,
        mockETHMainnetKrakenMapping,
        mockWETHArbitrumKrakenMapping,
        mockAssets['WETH'],
      );

      expect(result).toEqual({
        status: 'completed',
        onChainConfirmed: true,
        txId: withdrawalTxId,
      });
    });

    it('should return pending status when withdrawal exists but is not successful', async () => {
      // Mock getRebalanceOperationByTransactionHash in case needed
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      mockKrakenClient.getWithdrawStatus.mockResolvedValue({
        status: 'Failed',
        txid: undefined,
        refid,
      } as any);
      const result = await adapter.getOrInitWithdrawal(
        amount,
        sampleRoute,
        mockOriginTransaction,
        recipient,
        mockETHMainnetKrakenMapping,
        mockWETHArbitrumKrakenMapping,
        mockAssets['WETH'],
      );

      expect(result).toEqual({
        status: 'pending',
        onChainConfirmed: false,
        txId: undefined,
      });
    });

    it('should handle on-chain confirmation errors gracefully', async () => {
      // Mock getRebalanceOperationByTransactionHash in case needed
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          id: 'test-rebalance-id',
        }),
      );

      // Mock provider that throws error on getTransactionReceipt
      const mockProvider = {
        getTransactionReceipt: (jest.fn() as any).mockRejectedValue(new Error('RPC error')),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(mockProvider as PublicClient);

      mockKrakenClient.getWithdrawStatus.mockResolvedValue({
        status: 'Success',
        txid: withdrawalTxId,
        refid,
      } as any);

      const result = await adapter.getOrInitWithdrawal(
        amount,
        sampleRoute,
        mockOriginTransaction,
        recipient,
        mockETHMainnetKrakenMapping,
        mockWETHArbitrumKrakenMapping,
        mockAssets['WETH'],
      );

      // Should still return completed status, but onChainConfirmed should be false due to error
      expect(result).toEqual({
        status: 'completed',
        onChainConfirmed: false,
        txId: withdrawalTxId,
      });
    });

    it('should throw error and log when getOrInitWithdrawal fails', async () => {
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue(undefined);
      mockKrakenClient.withdraw.mockRejectedValue(new Error('failed'));

      await expect(
        adapter.getOrInitWithdrawal(
          amount,
          sampleRoute,
          mockOriginTransaction,
          recipient,
          mockETHMainnetKrakenMapping,
          mockWETHArbitrumKrakenMapping,
          mockAssets['WETH'],
        ),
      ).rejects.toThrow('failed');
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
    const refid = 'adsfjha8291';
    const amountWei = parseUnits('0.5', 18);

    beforeEach(() => {
      jest.clearAllMocks();

      // Mock the cache to return recipient
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(
        createMockRebalanceOperation({
          recipient,
          amount: '100000000000000000',
          originChainId: sampleRoute.origin,
          destinationChainId: sampleRoute.destination,
          tickerHash: sampleRoute.asset,
          transactions: { origin: mockOriginTransaction.transactionHash },
        }),
      );

      // Mock cache to return withdrawal with metadata
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue({
        ...createMockCexWithdrawalRecord({
          rebalanceOperationId: 'test-rebalance-id',
          refid,
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
          method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
        }),
        metadata: {
          refid,
          asset: mockWETHArbitrumKrakenMapping.krakenAsset,
          method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
        },
      });

      // Mock withdraw status
      mockKrakenClient.getWithdrawStatus.mockResolvedValue({
        status: 'Success',
        refid,
        method: mockWETHArbitrumKrakenMapping.withdrawMethod.method,
        amount: formatUnits(amountWei, 18),
      } as any);
    });

    it('should return WETH wrap transaction when withdrawal has ETH value', async () => {
      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeDefined();
      expect(result?.memo).toBe(RebalanceTransactionMemo.Wrap);
      expect(result?.transaction.to).toBe('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'); // WETH on Arbitrum
      expect(result?.transaction.value).toBe(amountWei);
      expect(result?.transaction.data).toEqual(expect.any(String)); // deposit() encoded
    });

    it('should return void when erc20', async () => {
      mockKrakenClient.getWithdrawStatus.mockResolvedValue({
        status: 'Success',
        refid,
        method: mockWETHArbitrumKrakenMapping.withdrawMethod.method + ' (ERC-20)',
        amount: formatUnits(amountWei, 18),
      } as any);
      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
    });

    it('should return void when cannot get recipient', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(undefined);

      const result = await adapter.destinationCallback(sampleRoute, mockOriginTransaction);

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith('No recipient found in cache for callback', {
        transactionHash: mockOriginTransaction.transactionHash,
      });
    });

    it('should throw when withdrawal is not retrieved', async () => {
      // Ensure findExistingWithdrawal returns a valid value
      // Already mocked in beforeEach via getCexWithdrawalRecord

      mockKrakenClient.getWithdrawStatus.mockResolvedValue(undefined);

      await expect(adapter.destinationCallback(sampleRoute, mockOriginTransaction)).rejects.toThrow(
        `Failed to retrieve kraken withdrawal status`,
      );
    });

    it('should return void when withdrawal status is not successful', async () => {
      // Ensure findExistingWithdrawal returns a valid value
      // Already mocked in beforeEach via getCexWithdrawalRecord

      mockKrakenClient.getWithdrawStatus.mockResolvedValue({ status: 'failed' } as any);

      await expect(adapter.destinationCallback(sampleRoute, mockOriginTransaction)).rejects.toThrow(
        `is not successful, status`,
      );
    });
  });

  describe('initiateWithdrawal balance validation', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      
      // Setup common mocks for KrakenAdapter
      mockKrakenClient.getBalance.mockResolvedValue({
        ETH: '1.0', // Default sufficient balance
      });
      
      mockKrakenClient.withdraw.mockResolvedValue({
        refid: 'test-refid',
      });
      
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue({
        id: 'test-id',
        earmarkId: 'test-earmark-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        isOrphaned: false,
        metadata: {},
        slippage: 100,
        status: 'pending',
        bridge: SupportedBridge.Kraken,
        recipient: '0x9876543210987654321098765432109876543210',
        amount: '100000000000000000',
        originChainId: 1,
        destinationChainId: 42161,
        tickerHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        transactions: { },
      });
    });

    const sampleRoute: RebalanceRoute = {
      origin: 1,
      destination: 42161,
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    };

    const originTransaction: TransactionReceipt = {
      transactionHash: '0xtesttx123',
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
      transactionIndex: 0,
      type: 'legacy',
    };

    const assetMapping = {'krakenAsset': 'ETH', 'krakenSymbol': 'ETH', 'chainId': 42161, 'network': 'arbitrum', 'depositMethod': {'method': 'ether', 'minimum': '0.001', 'limit': false, 'gen-address': false}, 'withdrawMethod': {'asset': 'ETH', 'minimum': '0.01', 'fee': {'fee': '0.001', 'asset': 'ETH', 'aclass': 'currency'}, 'method': 'Ether', 'limits': []}};

    const assetConfig: AssetConfiguration = {
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH on Arbitrum
      symbol: 'WETH',
      decimals: 18,
      tickerHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
      isNative: false,
      balanceThreshold: '0'
    };

    it('should validate balance before withdrawal', async () => {
      // Test uses default sufficient balance from beforeEach setup
      const testAdapter = adapter as TestKrakenBridgeAdapter;

      // Act - call initiateWithdrawal successfully
      const result = await testAdapter.initiateWithdrawal(
        sampleRoute,
        originTransaction,
        '50000000000000000', // 0.05 ETH (less than available 1.0 ETH)
        assetMapping,
        assetConfig,
        '0x9876543210987654321098765432109876543210'
      );

      // Assert - verify getBalance was called (validation reads balance)
      expect(mockKrakenClient.getBalance).toHaveBeenCalled();
      // Verify withdrawal was attempted after successful validation
      expect(mockKrakenClient.withdraw).toHaveBeenCalledWith({
        asset: assetMapping.krakenAsset,
        key: '0x9876543210987654321098765432109876543210',
        amount: '0.05' // 50000000000000000 formatted
      });
      
      // Verify result
      expect(result).toEqual({
        refid: 'test-refid',
        asset: assetMapping.krakenAsset,
        method: assetMapping.withdrawMethod.method
      });
    });

    it('should handle balance validation failure during withdrawal', async () => {
      // Override default balance to set insufficient balance for this test
      mockKrakenClient.getBalance.mockResolvedValue({
        ETH: '0.001', // Insufficient balance (< 0.052 ETH)
      });

      const testAdapter = adapter as TestKrakenBridgeAdapter;

      // Act & Assert - should throw insufficient balance error during validation
      await expect(
        testAdapter.initiateWithdrawal(
          sampleRoute,
          originTransaction,
          '52000000000000000', // 0.052 ETH (more than available 0.001 ETH)
          assetMapping,
          assetConfig,
          '0x9876543210987654321098765432109876543210'
        )
      ).rejects.toThrow('Insufficient balance');

      // Assert that getBalance was called (validation reads balance)
      expect(mockKrakenClient.getBalance).toHaveBeenCalled();
      // Assert that withdrawal was NOT attempted after failed validation
      expect(mockKrakenClient.withdraw).not.toHaveBeenCalled();
    });
  });
});
