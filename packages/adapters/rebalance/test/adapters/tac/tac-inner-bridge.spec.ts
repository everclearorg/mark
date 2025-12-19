/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, cleanupHttpConnections } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { TransactionReceipt } from 'viem';
import { TacInnerBridgeAdapter } from '../../../src/adapters/tac/tac-inner-bridge';
import { 
  TacNetwork, 
  TacSdkConfig, 
  TAC_CHAIN_ID, 
  USDT_TAC, 
  USDT_TON_JETTON,
  TacOperationStatus,
  TAC_BRIDGE_SUPPORTED_ASSETS,
  TAC_RPC_PROVIDERS,
} from '../../../src/adapters/tac/types';

// Mock viem functions
const mockReadContract = jest.fn();
const mockGetBlockNumber = jest.fn();
const mockGetLogs = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem') as any;
  return {
    ...actual,
    createPublicClient: jest.fn(() => ({
      getBalance: jest.fn().mockResolvedValue(1000000n as never),
      readContract: mockReadContract,
      getTransactionReceipt: jest.fn(),
      getTransaction: jest.fn(),
      getBlockNumber: mockGetBlockNumber,
      getLogs: mockGetLogs,
    })),
  };
});

jest.mock('@mark/logger');
(jsonifyError as jest.Mock).mockImplementation((err) => {
  const error = err as { name?: string; message?: string; stack?: string };
  return {
    name: error?.name ?? 'unknown',
    message: error?.message ?? 'unknown',
    stack: error?.stack ?? 'unknown',
    context: {},
  };
});
jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core') as any;
  return {
    ...actual,
    cleanupHttpConnections: jest.fn(),
  };
});

// Mock the TAC SDK - we don't want to actually connect to TON/TAC
const mockSendCrossChainTransaction = jest.fn();
const mockGetSimplifiedOperationStatus = jest.fn();

jest.mock('@tonappchain/sdk', () => ({
  TacSdk: {
    create: jest.fn().mockResolvedValue({
      sendCrossChainTransaction: mockSendCrossChainTransaction,
    } as never),
  },
  Network: {
    MAINNET: 'mainnet',
    TESTNET: 'testnet',
  },
  SenderFactory: {
    getSender: jest.fn().mockResolvedValue({
      getSenderAddress: jest.fn().mockReturnValue('UQTestAddress'),
      wallet: { address: { toString: () => 'UQTestAddress' } },
    } as never),
  },
  OperationTracker: jest.fn().mockImplementation(() => ({
    getSimplifiedOperationStatus: mockGetSimplifiedOperationStatus,
  })),
}));

jest.mock('@ton/ton', () => ({
  TonClient: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    getContractState: jest.fn().mockResolvedValue({
      balance: 1000000000n,
      state: 'active',
      code: null,
    } as never),
  })),
}));

jest.mock('@ton/crypto', () => ({
  mnemonicToWalletKey: jest.fn().mockResolvedValue({
    publicKey: Buffer.from('test-public-key'),
    secretKey: Buffer.from('test-secret-key'),
  } as never),
}));

// Test adapter that exposes protected methods for testing
class TestTacInnerBridgeAdapter extends TacInnerBridgeAdapter {
  public getPublicClients() {
    return this.publicClients;
  }

  public getSdkConfig() {
    return this.sdkConfig;
  }

  public callGetTacAssetAddress(asset: string) {
    return this.getTacAssetAddress(asset);
  }

  public callGetPublicClient(chainId: number) {
    return this.getPublicClient(chainId);
  }

  public async callInitializeSdk() {
    return this.initializeSdk();
  }

  public setTacSdk(sdk: any) {
    this.tacSdk = sdk;
    this.sdkInitialized = true;
  }
}

// Mock the Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

// Mock chain configurations (no real credentials)
const mockChains: Record<string, ChainConfiguration> = {
  '239': {
    assets: [
      {
        address: USDT_TAC,
        symbol: 'USDT',
        decimals: 6,
        tickerHash: '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0',
        isNative: false,
        balanceThreshold: '0',
      },
    ],
    providers: ['https://mock-tac-rpc.example.com'],
    invoiceAge: 3600,
    gasThreshold: '5000000000000000',
    deployments: {
      everclear: '0xMockEverclearAddress',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
};

// Mock SDK config (no real credentials)
const mockSdkConfig: TacSdkConfig = {
  network: TacNetwork.MAINNET,
  tonMnemonic: 'test word one two three four five six seven eight nine ten eleven twelve',
  tonRpcUrl: 'https://mock-ton-rpc.example.com',
  apiKey: 'mock-api-key',
};

describe('TacInnerBridgeAdapter', () => {
  let adapter: TestTacInnerBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset logger mocks
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    // Create fresh adapter instance
    adapter = new TestTacInnerBridgeAdapter(mockChains, mockLogger, mockSdkConfig);
  });

  afterEach(() => {
    cleanupHttpConnections();
  });

  describe('constructor', () => {
    it('should initialize correctly with SDK config', () => {
      expect(adapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Initializing TacInnerBridgeAdapter', expect.objectContaining({
        tacChainId: TAC_CHAIN_ID,
        usdtOnTac: USDT_TAC,
        hasSdkConfig: true,
        network: 'mainnet',
      }));
    });

    it('should initialize without SDK config', () => {
      const adapterWithoutConfig = new TestTacInnerBridgeAdapter(mockChains, mockLogger);
      expect(adapterWithoutConfig).toBeDefined();
      expect(adapterWithoutConfig.getSdkConfig()).toBeUndefined();
    });

    it('should use testnet when specified', () => {
      const testnetConfig: TacSdkConfig = {
        network: TacNetwork.TESTNET,
        tonMnemonic: 'test mnemonic',
      };
      new TestTacInnerBridgeAdapter(mockChains, mockLogger, testnetConfig);
      expect(mockLogger.debug).toHaveBeenCalledWith('Initializing TacInnerBridgeAdapter', expect.objectContaining({
        network: 'testnet',
      }));
    });
  });

  describe('type', () => {
    it('should return the correct bridge type', () => {
      expect(adapter.type()).toBe(SupportedBridge.TacInner);
    });

    it('should return tac-inner string', () => {
      expect(adapter.type()).toBe('tac-inner');
    });
  });

  describe('getMinimumAmount', () => {
    it('should return null (no minimum requirement)', async () => {
      const route: RebalanceRoute = {
        origin: 30826, // TON
        destination: 239, // TAC
        asset: USDT_TON_JETTON,
      };

      const result = await adapter.getMinimumAmount(route);
      expect(result).toBeNull();
    });
  });

  describe('getReceivedAmount', () => {
    it('should return the same amount (1:1 for TAC bridge)', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TON_JETTON,
      };

      const amount = '1000000'; // 1 USDT
      const result = await adapter.getReceivedAmount(amount, route);
      expect(result).toBe(amount);
    });
  });

  describe('send', () => {
    it('should return empty array (actual bridge via executeTacBridge)', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TON_JETTON,
      };

      const result = await adapter.send('0xSender', '0xRecipient', '1000000', route);
      expect(result).toEqual([]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'TAC Inner Bridge send requested',
        expect.objectContaining({
          sender: '0xSender',
          recipient: '0xRecipient',
          amount: '1000000',
        }),
      );
    });
  });

  describe('destinationCallback', () => {
    it('should return undefined (no callback needed for TAC bridge)', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TON_JETTON,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        logs: [],
      };

      const result = await adapter.destinationCallback(route, mockReceipt as TransactionReceipt);
      expect(result).toBeUndefined();
    });
  });

  describe('constants', () => {
    it('should have correct TAC chain ID', () => {
      expect(TAC_CHAIN_ID).toBe(239);
    });

    it('should have correct USDT on TAC address', () => {
      expect(USDT_TAC).toBe('0xAF988C3f7CB2AceAbB15f96b19388a259b6C438f');
    });

    it('should have correct USDT on TON jetton address (deprecated constant for reference)', () => {
      expect(USDT_TON_JETTON).toBe('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
    });
  });

  describe('TacSdkConfig', () => {
    it('should accept network parameter', () => {
      const config: TacSdkConfig = {
        network: TacNetwork.MAINNET,
        tonMnemonic: 'test',
      };
      expect(config.network).toBe('mainnet');
    });

    it('should accept testnet network', () => {
      const config: TacSdkConfig = {
        network: TacNetwork.TESTNET,
        tonMnemonic: 'test',
      };
      expect(config.network).toBe('testnet');
    });

    it('should accept tonRpcUrl and apiKey', () => {
      const config: TacSdkConfig = {
        network: TacNetwork.MAINNET,
        tonMnemonic: 'test',
        tonRpcUrl: 'https://example.com',
        apiKey: 'test-key',
      };
      expect(config.tonRpcUrl).toBe('https://example.com');
      expect(config.apiKey).toBe('test-key');
    });
  });

  describe('TacNetwork enum', () => {
    it('should have mainnet value', () => {
      expect(TacNetwork.MAINNET).toBe('mainnet');
    });

    it('should have testnet value', () => {
      expect(TacNetwork.TESTNET).toBe('testnet');
    });
  });

  describe('executeTacBridge', () => {
    beforeEach(() => {
      mockSendCrossChainTransaction.mockReset();
    });

    it('should execute bridge successfully and return transaction linker', async () => {
      const mockTransactionLinker = {
        transactionHash: '0xmockhash',
        operationId: 'mock-op-id',
      };
      mockSendCrossChainTransaction.mockResolvedValue(mockTransactionLinker as never);

      const result = await adapter.executeTacBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toEqual(mockTransactionLinker);
      expect(mockLogger.info).toHaveBeenCalledWith('TAC bridge transaction sent successfully', expect.any(Object));
    });

    it('should still attempt to initialize SDK even without config', async () => {
      // Create adapter without SDK config
      const adapterNoSdk = new TestTacInnerBridgeAdapter(mockChains, mockLogger);
      
      // The SDK will attempt to initialize with default settings
      // Mock will still succeed since @tonappchain/sdk is mocked
      const mockTxLinker = { caller: '0x', shardCount: 1, shardsKey: 1, timestamp: Date.now() };
      mockSendCrossChainTransaction.mockResolvedValue(mockTxLinker as never);
      
      const result = await adapterNoSdk.executeTacBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '0xRecipient',
        '1000000',
        USDT_TON_JETTON,
      );

      // Should execute successfully with mocked SDK
      expect(result).toEqual(mockTxLinker);
    });

    it('should handle bridge execution errors gracefully', async () => {
      mockSendCrossChainTransaction.mockRejectedValue(new Error('Bridge failed') as never);

      const result = await adapter.executeTacBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '0xRecipient',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to execute TAC bridge', expect.any(Object));
    });

    it('should log sender wallet address', async () => {
      mockSendCrossChainTransaction.mockResolvedValue({ operationId: 'test' } as never);

      await adapter.executeTacBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        '2000000',
        USDT_TON_JETTON,
      );

      expect(mockLogger.info).toHaveBeenCalledWith('TAC bridge sender wallet', expect.objectContaining({
        finalRecipient: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
      }));
    });

    it('should return null when SDK is not initialized', async () => {
      // Create adapter without initializing SDK and force it to remain null
      const freshAdapter = new TestTacInnerBridgeAdapter(mockChains, mockLogger, mockSdkConfig);
      // Force SDK to be null but marked as "initialized" (edge case)
      freshAdapter.setTacSdk(null);

      const result = await freshAdapter.executeTacBridge(
        'test mnemonic',
        '0xRecipient',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('TAC SDK not initialized, cannot execute bridge');
    });
  });

  describe('executeSimpleBridge', () => {
    beforeEach(() => {
      mockSendCrossChainTransaction.mockReset();
    });

    it('should attempt simple bridge and return transaction linker', async () => {
      const mockTransactionLinker = { operationId: 'simple-op' };
      mockSendCrossChainTransaction.mockResolvedValue(mockTransactionLinker as never);

      const result = await adapter.executeSimpleBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toEqual(mockTransactionLinker);
    });

    it('should return null on error', async () => {
      mockSendCrossChainTransaction.mockRejectedValue(new Error('Simple bridge failed') as never);

      const result = await adapter.executeSimpleBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to execute simple bridge', expect.any(Object));
    });

    it('should return null when SDK is not initialized', async () => {
      // Create adapter without initializing SDK
      const freshAdapter = new TestTacInnerBridgeAdapter(mockChains, mockLogger, mockSdkConfig);
      // Force SDK to remain null by setting sdkInitialized to true but sdk to null
      freshAdapter.setTacSdk(null);

      const result = await freshAdapter.executeSimpleBridge(
        'test mnemonic',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('TAC SDK not initialized, cannot execute bridge');
    });

    it('should try bridgeAssets method when available', async () => {
      const mockBridgeAssets = jest.fn().mockResolvedValue({ operationId: 'bridge-assets-op' } as never);
      const mockSdk = {
        bridgeAssets: mockBridgeAssets,
        sendCrossChainTransaction: mockSendCrossChainTransaction,
      };
      adapter.setTacSdk(mockSdk);

      const result = await adapter.executeSimpleBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toEqual({ operationId: 'bridge-assets-op' });
      expect(mockBridgeAssets).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Using TAC SDK bridgeAssets method', expect.any(Object));
    });

    it('should try startBridging method when bridgeAssets not available', async () => {
      const mockStartBridging = jest.fn().mockResolvedValue({ operationId: 'start-bridging-op' } as never);
      const mockSdk = {
        startBridging: mockStartBridging,
        sendCrossChainTransaction: mockSendCrossChainTransaction,
      };
      adapter.setTacSdk(mockSdk);

      const result = await adapter.executeSimpleBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toEqual({ operationId: 'start-bridging-op' });
      expect(mockStartBridging).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Using TAC SDK startBridging method', expect.any(Object));
    });

    it('should fall back to sendCrossChainTransaction when other methods not available', async () => {
      const mockTxLinker = { operationId: 'fallback-op' };
      mockSendCrossChainTransaction.mockResolvedValue(mockTxLinker as never);
      const mockSdk = {
        sendCrossChainTransaction: mockSendCrossChainTransaction,
      };
      adapter.setTacSdk(mockSdk);

      const result = await adapter.executeSimpleBridge(
        'test word one two three four five six seven eight nine ten eleven twelve',
        '1000000',
        USDT_TON_JETTON,
      );

      expect(result).toEqual(mockTxLinker);
      expect(mockLogger.info).toHaveBeenCalledWith('Using sendCrossChainTransaction with minimal config', expect.any(Object));
    });
  });

  describe('trackOperation', () => {
    // TacTransactionLinker has structure: { caller, shardCount, shardsKey, timestamp }
    const mockTransactionLinker = {
      caller: '0xTestCaller',
      shardCount: 1,
      shardsKey: 12345,
      timestamp: Date.now(),
    };

    beforeEach(() => {
      mockGetSimplifiedOperationStatus.mockReset();
    });

    it('should return SUCCESSFUL status', async () => {
      mockGetSimplifiedOperationStatus.mockResolvedValue('SUCCESSFUL' as never);

      const result = await adapter.trackOperation(mockTransactionLinker);

      expect(result).toBe(TacOperationStatus.SUCCESSFUL);
    });

    it('should return FAILED status', async () => {
      mockGetSimplifiedOperationStatus.mockResolvedValue('FAILED' as never);

      const result = await adapter.trackOperation(mockTransactionLinker);

      expect(result).toBe(TacOperationStatus.FAILED);
    });

    it('should return PENDING status', async () => {
      mockGetSimplifiedOperationStatus.mockResolvedValue('PENDING' as never);

      const result = await adapter.trackOperation(mockTransactionLinker);

      expect(result).toBe(TacOperationStatus.PENDING);
    });

    it('should return NOT_FOUND for unknown status', async () => {
      mockGetSimplifiedOperationStatus.mockResolvedValue('OPERATION_ID_NOT_FOUND' as never);

      const result = await adapter.trackOperation(mockTransactionLinker);

      expect(result).toBe(TacOperationStatus.NOT_FOUND);
    });

    it('should return NOT_FOUND on error', async () => {
      mockGetSimplifiedOperationStatus.mockRejectedValue(new Error('Tracking failed') as never);

      const result = await adapter.trackOperation(mockTransactionLinker);

      expect(result).toBe(TacOperationStatus.NOT_FOUND);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to track TAC operation', expect.any(Object));
    });
  });

  describe('waitForOperation', () => {
    const mockTransactionLinker = {
      caller: '0xTestCaller',
      shardCount: 1,
      shardsKey: 12345,
      timestamp: Date.now(),
    };

    beforeEach(() => {
      mockGetSimplifiedOperationStatus.mockReset();
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return SUCCESSFUL when operation completes', async () => {
      mockGetSimplifiedOperationStatus.mockResolvedValue('SUCCESSFUL' as never);

      const promise = adapter.waitForOperation(mockTransactionLinker, 60000, 1000);
      jest.advanceTimersByTime(100);
      const result = await promise;

      expect(result).toBe(TacOperationStatus.SUCCESSFUL);
    });

    it('should return FAILED when operation fails', async () => {
      mockGetSimplifiedOperationStatus.mockResolvedValue('FAILED' as never);

      const promise = adapter.waitForOperation(mockTransactionLinker, 60000, 1000);
      jest.advanceTimersByTime(100);
      const result = await promise;

      expect(result).toBe(TacOperationStatus.FAILED);
    });
  });

  describe('readyOnDestination', () => {
    beforeEach(() => {
      mockReadContract.mockReset();
      mockGetBlockNumber.mockReset();
      mockGetLogs.mockReset();
      
      mockReadContract.mockResolvedValue(1000000n as never);
      mockGetBlockNumber.mockResolvedValue(1000000n as never);
      mockGetLogs.mockResolvedValue([] as never);
    });

    it('should return true when matching Transfer event found', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      // Mock a Transfer event with sufficient amount
      mockGetLogs.mockResolvedValue([{
        args: { value: 1000000n },
        transactionHash: '0xtransfertx',
        blockNumber: 999999n,
      }] as never);

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(true);
    });

    it('should return true via fallback when balance is sufficient but no recent events', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      // No Transfer events found, but balance is sufficient
      mockGetLogs.mockResolvedValue([] as never);
      mockReadContract.mockResolvedValue(2000000n as never); // More than required

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(true);
    });

    it('should return false when balance is insufficient', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      // No Transfer events and insufficient balance
      mockGetLogs.mockResolvedValue([] as never);
      mockReadContract.mockResolvedValue(100000n as never); // Less than required

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(false);
    });

    it('should return false when no recipient address available', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: undefined,
        logs: [],
      };

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('No recipient address available for balance check', expect.any(Object));
    });

    it('should use recipientOverride when provided', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0xWrongAddress',
        logs: [],
      };

      mockGetLogs.mockResolvedValue([{
        args: { value: 1000000n },
        transactionHash: '0xtransfertx',
        blockNumber: 999999n,
      }] as never);

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
        '0xCorrectRecipient',
      );

      expect(result).toBe(true);
    });

    it('should handle getLogs errors with fallback to balance check', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      mockGetLogs.mockRejectedValue(new Error('RPC error') as never);
      mockReadContract.mockResolvedValue(2000000n as never); // Sufficient balance

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith('Failed to query TAC logs, falling back to balance check', expect.any(Object));
    });

    it('should return false when readContract throws error', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      mockReadContract.mockRejectedValue(new Error('Balance check failed') as never);

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to check TAC Inner Bridge status', expect.any(Object));
    });

    it('should return false when TAC asset address cannot be found', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: '0x1234567890123456789012345678901234567890', // Unknown asset
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('Could not find TAC asset address', expect.any(Object));
    });

    it('should return false when getLogs fails and balance is insufficient', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      mockGetLogs.mockRejectedValue(new Error('RPC error') as never);
      mockReadContract.mockResolvedValue(100000n as never); // Insufficient balance

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('Failed to query TAC logs, falling back to balance check', expect.any(Object));
    });

    it('should return false when Transfer event amount is less than minimum', async () => {
      const route: RebalanceRoute = {
        origin: 30826,
        destination: 239,
        asset: USDT_TAC,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        to: '0x36BA155a8e9c45C0Af262F9e61Fff0D591472Fe5',
        logs: [],
      };

      // Transfer event exists but amount is too small
      mockGetLogs.mockResolvedValue([{
        args: { value: 100000n }, // Less than 95% of required
        transactionHash: '0xtransfertx',
        blockNumber: 999999n,
      }] as never);
      mockReadContract.mockResolvedValue(100000n as never); // Insufficient balance

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      expect(result).toBe(false);
    });
  });

  describe('getTacAssetAddress', () => {
    it('should return USDT_TAC for known USDT TAC address', () => {
      const result = adapter.callGetTacAssetAddress(USDT_TAC);
      expect(result).toBe(USDT_TAC);
    });

    it('should map TON USDT jetton to TAC USDT', () => {
      const result = adapter.callGetTacAssetAddress(USDT_TON_JETTON);
      expect(result).toBe(USDT_TAC);
    });

    it('should return USDT_TAC for asset containing usdt', () => {
      const result = adapter.callGetTacAssetAddress('some-usdt-asset');
      expect(result).toBe(USDT_TAC);
    });

    it('should return undefined for unknown asset', () => {
      const result = adapter.callGetTacAssetAddress('0xUnknownAsset123456789012345678901234567890');
      expect(result).toBeUndefined();
    });

    it('should return TAC address when given a matching TAC EVM address from supported assets', () => {
      // Test when asset is already in TAC format and matches a supported asset's tac address
      const result = adapter.callGetTacAssetAddress(USDT_TAC.toLowerCase());
      expect(result).toBe(USDT_TAC);
    });

    it('should handle case-insensitive TON address matching', () => {
      const result = adapter.callGetTacAssetAddress(USDT_TON_JETTON.toLowerCase());
      expect(result).toBe(USDT_TAC);
    });
  });

  describe('getPublicClient', () => {
    it('should create client with configured providers', () => {
      const client = adapter.callGetPublicClient(239);
      expect(client).toBeDefined();
    });

    it('should use fallback providers for TAC chain if not configured', () => {
      // Create adapter with empty chains config
      const adapterNoChains = new TestTacInnerBridgeAdapter({}, mockLogger, mockSdkConfig);
      const client = adapterNoChains.callGetPublicClient(TAC_CHAIN_ID);
      expect(client).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Using fallback TAC RPC providers', expect.any(Object));
    });

    it('should throw error for unknown chain without providers', () => {
      const adapterNoChains = new TestTacInnerBridgeAdapter({}, mockLogger, mockSdkConfig);
      expect(() => adapterNoChains.callGetPublicClient(12345)).toThrow('No providers found for chain 12345');
    });

    it('should cache and reuse clients', () => {
      const client1 = adapter.callGetPublicClient(239);
      const client2 = adapter.callGetPublicClient(239);
      expect(client1).toBe(client2);
    });
  });

  describe('initializeSdk', () => {
    it('should initialize SDK with correct network', async () => {
      await adapter.callInitializeSdk();
      expect(mockLogger.info).toHaveBeenCalledWith('TAC SDK initialized successfully', expect.any(Object));
    });

    it('should not re-initialize if already initialized', async () => {
      await adapter.callInitializeSdk();
      mockLogger.info.mockClear();
      await adapter.callInitializeSdk();
      // Should not log again since it's already initialized
      expect(mockLogger.info).not.toHaveBeenCalledWith('TAC SDK initialized successfully', expect.any(Object));
    });
  });

  describe('TacOperationStatus enum', () => {
    it('should have PENDING status', () => {
      expect(TacOperationStatus.PENDING).toBe('PENDING');
    });

    it('should have SUCCESSFUL status', () => {
      expect(TacOperationStatus.SUCCESSFUL).toBe('SUCCESSFUL');
    });

    it('should have FAILED status', () => {
      expect(TacOperationStatus.FAILED).toBe('FAILED');
    });

    it('should have NOT_FOUND status', () => {
      expect(TacOperationStatus.NOT_FOUND).toBe('OPERATION_ID_NOT_FOUND');
    });
  });

  describe('TAC_BRIDGE_SUPPORTED_ASSETS', () => {
    it('should have USDT mapping', () => {
      expect(TAC_BRIDGE_SUPPORTED_ASSETS.USDT).toBeDefined();
      expect(TAC_BRIDGE_SUPPORTED_ASSETS.USDT.ton).toBe(USDT_TON_JETTON);
      expect(TAC_BRIDGE_SUPPORTED_ASSETS.USDT.tac).toBe(USDT_TAC);
    });
  });

  describe('TAC_RPC_PROVIDERS', () => {
    it('should have fallback providers defined', () => {
      expect(TAC_RPC_PROVIDERS).toBeDefined();
      expect(TAC_RPC_PROVIDERS.length).toBeGreaterThan(0);
    });
  });
});
