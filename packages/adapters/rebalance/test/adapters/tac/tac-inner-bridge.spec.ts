/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, cleanupHttpConnections } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { TransactionReceipt } from 'viem';
import { TacInnerBridgeAdapter } from '../../../src/adapters/tac/tac-inner-bridge';
import { TacNetwork, TacSdkConfig, TAC_CHAIN_ID, USDT_TAC, USDT_TON_JETTON } from '../../../src/adapters/tac/types';

// Mock the external dependencies
jest.mock('viem', () => {
  const actual = jest.requireActual('viem') as any;
  return {
    ...actual,
    createPublicClient: jest.fn(() => ({
      getBalance: jest.fn().mockResolvedValue(1000000n as never),
      readContract: jest.fn().mockResolvedValue(1000000n as never),
      getTransactionReceipt: jest.fn(),
      getTransaction: jest.fn(),
      getBlockNumber: jest.fn().mockResolvedValue(1000000n as never),
      getLogs: jest.fn().mockResolvedValue([] as never),
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
jest.mock('@tonappchain/sdk', () => ({
  TacSdk: {
    create: jest.fn().mockResolvedValue({
      sendCrossChainTransaction: jest.fn(),
    } as never),
  },
  Network: {
    MAINNET: 'mainnet',
    TESTNET: 'testnet',
  },
  SenderFactory: {
    getSender: jest.fn().mockResolvedValue({
      getSenderAddress: jest.fn().mockReturnValue('UQTestAddress'),
    } as never),
  },
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
});
