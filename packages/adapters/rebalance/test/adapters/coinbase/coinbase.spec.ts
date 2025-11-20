/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { SupportedBridge, RebalanceRoute, AssetConfiguration, MarkConfiguration, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import * as database from '@mark/database';
import { TransactionReceipt, parseUnits, formatUnits, PublicClient } from 'viem';
import { CoinbaseBridgeAdapter } from '../../../src/adapters/coinbase/coinbase';
import { CoinbaseClient } from '../../../src/adapters/coinbase/client';
import { RebalanceTransactionMemo } from '../../../src/types';
import { getRebalanceOperationByTransactionHash } from '@mark/database';

jest.mock('../../../src/adapters/coinbase/client');
jest.mock('../../../src/shared/asset', () => ({
  findAssetByAddress: jest.fn(),
  findMatchingDestinationAsset: jest.fn(),
}));
jest.mock('@mark/database', () => ({
  getRebalanceOperationByTransactionHash: jest.fn(),
}));

class TestCoinbaseBridgeAdapter extends CoinbaseBridgeAdapter {
  public handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    // expose for testing error formatting/throw
    return super.handleError(error, context, metadata);
  }
  public getOrInitWithdrawal(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    recipient: string,
  ): Promise<any> {
    return super.getOrInitWithdrawal(amount, route, originTransaction, recipient);
  }
  public checkDepositConfirmed(route: RebalanceRoute, originTransaction: TransactionReceipt) {
    return super.checkDepositConfirmed(route, originTransaction);
  }
  public findExistingWithdrawal(route: RebalanceRoute, originTransaction: TransactionReceipt) {
    return super.findExistingWithdrawal(route, originTransaction);
  }
  public initiateWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    recipient: string,
  ) {
    return super.initiateWithdrawal(route, originTransaction, amount, recipient);
  }
  public getProvider(chainId: number) {
    return super.getProvider(chainId);
  }
}

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

const mockDatabase = {
  setPause: jest.fn(),
  isPaused: jest.fn(),
  getRebalanceOperationByTransactionHash: jest.fn(),
  createRebalanceOperation: jest.fn(),
  updateRebalanceOperation: jest.fn(),
  createCexWithdrawalRecord: jest.fn(),
  getCexWithdrawalRecord: jest.fn(),
} as unknown as jest.Mocked<typeof database>;

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
      {
        address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        symbol: 'USDC',
        decimals: 6,
        tickerHash: '0xUSDCHash',
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
};

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
    apiKey: 'test-coinbase-api-key',
    apiSecret: 'test-coinbase-api-secret',
    allowedRecipients: ['0x9876543210987654321098765432109876543210'],
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

const mockClient = {
  getCoinbaseNetwork: jest.fn(),
  getDepositAccount: jest.fn(),
  getTransactionByHash: jest.fn(),
  getWithdrawalById: jest.fn(),
  sendCrypto: jest.fn(),
  getAccounts: jest.fn(),
} as unknown as jest.Mocked<CoinbaseClient>;

describe('CoinbaseBridgeAdapter Unit', () => {
  let adapter: TestCoinbaseBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    const assetModule = jest.requireMock('../../../src/shared/asset') as any;
    assetModule.findAssetByAddress.mockImplementation((asset: string, chainId: number) => {
      if (asset === mockAssets.WETH.address && chainId === 1) return mockAssets.WETH;
      if (asset === mockAssets.USDC.address && chainId === 1) return mockAssets.USDC;
      if (asset === mockAssets.ETH.address) return mockAssets.ETH;
      return null;
    });
    assetModule.findMatchingDestinationAsset.mockImplementation((asset: string, origin: number, destination: number) => {
      if (asset === mockAssets.WETH.address && origin === 1 && destination === 42161) {
        return {
          address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
          symbol: 'WETH',
          decimals: 18,
          tickerHash: '0xWETHHash',
          isNative: false,
          balanceThreshold: '0',
        };
      }
      if (asset === mockAssets.USDC.address && origin === 1 && destination === 42161) {
        return {
          address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
          symbol: 'USDC',
          decimals: 6,
          tickerHash: '0xUSDCHash',
          isNative: false,
          balanceThreshold: '0',
        };
      }
      if (asset === mockAssets.ETH.address && origin === 1 && destination === 42161) {
        return {
          address: mockAssets.ETH.address,
          symbol: 'ETH',
          decimals: 18,
          tickerHash: '0xETHHash',
          isNative: true,
          balanceThreshold: '0',
        };
      }
      return null;
    });

    // Mock static factory to return our mocked client
    const getInstanceMock = jest.fn(async () => mockClient as any);
    (CoinbaseClient as any).getInstance = getInstanceMock;

    mockClient.getCoinbaseNetwork.mockImplementation((chainId: number) => {
      if (chainId === 42161) return { networkLabel: 'arbitrum' } as any;
      if (chainId === 1) return { networkLabel: 'ethereum' } as any;
      return { networkLabel: 'unknown' } as any;
    });
    mockClient.getDepositAccount.mockResolvedValue({
      accountId: 'acc-1',
      addressId: 'addr-1',
      address: '0x1234567890123456789012345678901234567890',
    } as any);

    adapter = new TestCoinbaseBridgeAdapter(mockConfig, mockLogger, mockDatabase);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('constructor', () => {
    it('initializes with valid credentials and allowed recipients', () => {
      expect(CoinbaseClient.getInstance).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('CoinbaseBridgeAdapter initialized', {
        hasapiKey: true,
        hasapiSecret: true,
        allowedRecipients: mockConfig.coinbase?.allowedRecipients?.join(','),
        bridgeType: SupportedBridge.Coinbase,
      });
    });

    it('throws without API key/secret', () => {
      const badCfg = { ...mockConfig, coinbase: { apiKey: '', apiSecret: '', allowedRecipients: ['0x1'] } } as any;
      expect(() => new TestCoinbaseBridgeAdapter(badCfg, mockLogger, mockDatabase)).toThrow(
        'CoinbaseBridgeAdapter requires API key ID and secret',
      );
    });

    it('throws without allowed recipients', () => {
      const badCfg = {
        ...mockConfig,
        coinbase: { apiKey: 'x', apiSecret: 'y', allowedRecipients: [] },
      } as any;
      expect(() => new TestCoinbaseBridgeAdapter(badCfg, mockLogger, mockDatabase)).toThrow(
        'CoinbaseBridgeAdapter requires at least one allowed recipient',
      );
    });
  });

  describe('type()', () => {
    it('returns SupportedBridge.Coinbase', () => {
      expect(adapter.type()).toBe(SupportedBridge.Coinbase);
    });
  });

  describe('send()', () => {
    const sender = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const recipient = '0x9876543210987654321098765432109876543210';
    const routeWeth: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.WETH.address };
    const routeUsdc: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.USDC.address };
    const amount = parseUnits('0.1', 18).toString();

    it('prepares WETH unwrap + native ETH send when Coinbase expects ETH', async () => {
      const result = await adapter.send(sender, recipient, amount, routeWeth);

      expect(result).toHaveLength(2);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(result[0].transaction.to).toBe(mockAssets.WETH.address);
      expect(result[0].transaction.value).toBe(BigInt(0));
      expect(result[0].transaction.data).toEqual(expect.any(String));

      expect(result[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[1].transaction.to).toBe('0x1234567890123456789012345678901234567890');
      expect(result[1].transaction.value).toBe(BigInt(amount));
      expect(result[1].transaction.data).toBe('0x');
    });

    it('prepares ERC20 transfer when bridge asset is token (USDC)', async () => {
      const result = await adapter.send(sender, recipient, '10000000', routeUsdc); // 10 USDC

      expect(result).toHaveLength(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe(routeUsdc.asset);
      expect(result[0].transaction.value).toBe(BigInt(0));
      expect(result[0].transaction.data).toEqual(expect.any(String));
    });
  });

  describe('checkDepositConfirmed()', () => {
    const route: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.WETH.address };
    const originTx: TransactionReceipt = {
      blockHash: '0xabc',
      blockNumber: BigInt(1),
      contractAddress: null,
      cumulativeGasUsed: BigInt(0),
      effectiveGasPrice: BigInt(0),
      from: '0x1',
      gasUsed: BigInt(0),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x2',
      transactionHash: '0xdeadbeef',
      transactionIndex: 0,
      type: 'eip1559',
    };

    it('returns confirmed=true when Coinbase transaction is completed', async () => {
      mockClient.getTransactionByHash.mockResolvedValue({
        id: 'txn-1',
        status: 'completed',
      } as any);

      const res = await adapter.checkDepositConfirmed(route, originTx);
      expect(res.confirmed).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit confirmation check',
        expect.objectContaining({
          transactionHash: originTx.transactionHash,
          confirmed: true,
          matchingTransactionId: 'txn-1',
          status: 'completed',
        }),
      );
    });

    it('returns confirmed=false when Coinbase transaction not found or not completed', async () => {
      mockClient.getTransactionByHash.mockResolvedValue({ id: 'txn-2', status: 'pending' } as any);
      const res = await adapter.checkDepositConfirmed(route, originTx);
      expect(res.confirmed).toBe(false);
    });

    it('returns confirmed=false when error occurs', async () => {
      mockClient.getTransactionByHash.mockRejectedValue(new Error('API error'));
      const res = await adapter.checkDepositConfirmed(route, originTx);
      expect(res.confirmed).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to check deposit confirmation', expect.any(Object));
    });
  });

  describe('readyOnDestination()', () => {
    const route: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.WETH.address };
    const originTx: TransactionReceipt = {
      blockHash: '0xabc',
      blockNumber: BigInt(1),
      contractAddress: null,
      cumulativeGasUsed: BigInt(0),
      effectiveGasPrice: BigInt(0),
      from: '0x1',
      gasUsed: BigInt(0),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x2',
      transactionHash: '0xfeedbead',
      transactionIndex: 0,
      type: 'eip1559',
    };
    const amount = parseUnits('0.1', 18).toString();

    beforeEach(() => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue({
        id: 'rebalance-1',
        recipient: mockConfig.coinbase?.allowedRecipients?.[0],
      } as any);
    });

    it('returns true when withdrawal is completed and on-chain confirmed', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'completed',
        onChainConfirmed: true,
        txId: '0xw',
      });
      const res = await adapter.readyOnDestination(amount, route, originTx);
      expect(res).toBe(true);
    });

    it('returns false when withdrawal not ready', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue({
        status: 'pending',
        onChainConfirmed: false,
      });
      const res = await adapter.readyOnDestination(amount, route, originTx);
      expect(res).toBe(false);
    });

    it('returns false when recipient is missing', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(undefined as any);
      const res = await adapter.readyOnDestination(amount, route, originTx);
      expect(res).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith('Cannot check withdrawal readiness - recipient missing from cache', expect.any(Object));
    });

    it('returns false when getOrInitWithdrawal returns undefined', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockResolvedValue(undefined);
      const res = await adapter.readyOnDestination(amount, route, originTx);
      expect(res).toBe(false);
    });

    it('returns false when getOrInitWithdrawal throws error', async () => {
      jest.spyOn(adapter, 'getOrInitWithdrawal').mockRejectedValue(new Error('Test error'));
      const res = await adapter.readyOnDestination(amount, route, originTx);
      expect(res).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to check if transaction is ready on destination', expect.any(Object));
    });
  });

  describe('destinationCallback()', () => {
    const route: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.WETH.address };
    const originTx: TransactionReceipt = {
      blockHash: '0xabc',
      blockNumber: BigInt(1),
      contractAddress: null,
      cumulativeGasUsed: BigInt(0),
      effectiveGasPrice: BigInt(0),
      from: '0x1',
      gasUsed: BigInt(0),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x2',
      transactionHash: '0xabc123',
      transactionIndex: 0,
      type: 'eip1559',
    };

    beforeEach(() => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue({
        id: 'rebalance-1',
        recipient: mockConfig.coinbase?.allowedRecipients?.[0],
        amount: parseUnits('0.5', 18).toString(),
      } as any);
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue({
        rebalanceOperationId: 'rebalance-1',
        platform: 'coinbase',
        metadata: { id: 'wd-1' },
      } as any);
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-1',
        status: 'completed',
        amount: { amount: '-0.5' },
        network: {
          hash: '0xwithdrawhash',
          transaction_fee: { amount: '0', currency: 'ETH' },
        },
      } as any);
    });

    it('returns WETH wrap transaction when destination requires wrapping', async () => {
      const provider = {
        getTransactionReceipt: (jest.fn() as any).mockResolvedValue({ status: 'success' }),
        readContract: jest.fn(),
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(provider as unknown as PublicClient);

      const result = await adapter.destinationCallback(route, originTx);
      expect(result).toBeDefined();
      expect(result?.memo).toBe(RebalanceTransactionMemo.Wrap);
      expect(result?.transaction.to).toBe('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
      expect(result?.transaction.value).toEqual(parseUnits('0.5', 18));
      expect(result?.transaction.data).toEqual(expect.any(String));
    });

    it('returns void when no withdrawal found', async () => {
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue(undefined as any);
      const res = await adapter.destinationCallback(route, originTx);
      expect(res).toBeUndefined();
    });

    it('returns void when no recipient found', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(undefined as any);
      const res = await adapter.destinationCallback(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith('No recipient found in cache for callback', {
        transactionHash: originTx.transactionHash,
      });
    });

    it('returns void when withdrawal not found', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue(undefined);
      const res = await adapter.destinationCallback(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith('No withdrawal found to execute callbacks for', {
        route,
        originTransaction: originTx,
      });
    });

    it('throws when withdrawal retrieval fails', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      mockClient.getWithdrawalById.mockResolvedValue(undefined as any);
      await expect(adapter.destinationCallback(route, originTx)).rejects.toThrow(
        'Failed to retrieve coinbase withdrawal status',
      );
    });

    it('throws when withdrawal not successful', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-1',
        status: 'pending',
        network: {},
      } as any);
      await expect(adapter.destinationCallback(route, originTx)).rejects.toThrow('is not successful/completed');
    });

    it('throws when withdrawal network hash is missing', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-1',
        status: 'completed',
        network: {},
      } as any);
      await expect(adapter.destinationCallback(route, originTx)).rejects.toThrow('is not successful/completed');
    });

    it('throws when destination asset config not found', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      const assetModule = jest.requireMock('../../../src/shared/asset') as any;
      assetModule.findMatchingDestinationAsset.mockReturnValue(null);
      await expect(adapter.destinationCallback(route, originTx)).rejects.toThrow('No destination asset config detected');
    });

    it('throws when destination native asset invalid', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      const assetModule = jest.requireMock('../../../src/shared/asset') as any;
      assetModule.findAssetByAddress.mockImplementation((addr: string) => {
        if (addr === '0x0000000000000000000000000000000000000000') return { isNative: false };
        return mockAssets.ETH;
      });
      await expect(adapter.destinationCallback(route, originTx)).rejects.toThrow('not properly configured');
    });

    it('returns void when wrapping not needed (non-WETH destination)', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      const assetModule = jest.requireMock('../../../src/shared/asset') as any;
      assetModule.findMatchingDestinationAsset.mockReturnValue(mockAssets.USDC);
      const res = await adapter.destinationCallback(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Destination asset does not require wrapping, no callbacks needed', expect.any(Object));
    });

    it('returns void when fee currency mismatch', async () => {
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-1',
        status: 'completed',
        amount: { amount: '-0.5' },
        network: {
          hash: '0xwithdrawhash',
          transaction_fee: { amount: '0', currency: 'USDC' },
        },
      } as any);
      const res = await adapter.destinationCallback(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith('Transaction fee symbol does not match bridge asset symbol, skipping wrap', expect.any(Object));
    });

    it('handles errors gracefully', async () => {
      mockClient.getWithdrawalById.mockRejectedValue(new Error('API error'));
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      await expect(adapter.destinationCallback(route, originTx)).rejects.toThrow('Failed to prepare destination callback');
    });
  });

  describe('findExistingWithdrawal()', () => {
    const route: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.WETH.address };
    const originTx: TransactionReceipt = {
      blockHash: '0xabc',
      blockNumber: BigInt(1),
      contractAddress: null,
      cumulativeGasUsed: BigInt(0),
      effectiveGasPrice: BigInt(0),
      from: '0x1',
      gasUsed: BigInt(0),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x2',
      transactionHash: '0xtest123',
      transactionIndex: 0,
      type: 'eip1559',
    };

    it('returns undefined when no rebalance operation found', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue(undefined as any);
      const res = await adapter.findExistingWithdrawal(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('No rebalance operation found for deposit', expect.any(Object));
    });

    it('returns undefined when no withdrawal record found', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue({ id: 'op-1' } as any);
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue(undefined as any);
      const res = await adapter.findExistingWithdrawal(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('No existing withdrawal found', expect.any(Object));
    });

    it('returns undefined when metadata missing id', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue({ id: 'op-1' } as any);
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue({
        rebalanceOperationId: 'op-1',
        platform: 'coinbase',
        metadata: {},
      } as any);
      const res = await adapter.findExistingWithdrawal(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Existing CEX withdrawal record missing expected Coinbase fields', expect.any(Object));
    });

    it('returns withdrawal id when found', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue({ id: 'op-1' } as any);
      mockDatabase.getCexWithdrawalRecord.mockResolvedValue({
        rebalanceOperationId: 'op-1',
        platform: 'coinbase',
        metadata: { id: 'wd-123' },
      } as any);
      const res = await adapter.findExistingWithdrawal(route, originTx);
      expect(res).toEqual({ id: 'wd-123' });
      expect(mockLogger.debug).toHaveBeenCalledWith('Found existing withdrawal', expect.any(Object));
    });

    it('handles errors gracefully', async () => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockRejectedValue(new Error('DB error'));
      const res = await adapter.findExistingWithdrawal(route, originTx);
      expect(res).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to find existing withdrawal', expect.any(Object));
    });
  });

  describe('initiateWithdrawal()', () => {
    const route: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.WETH.address };
    const originTx: TransactionReceipt = {
      blockHash: '0xabc',
      blockNumber: BigInt(1),
      contractAddress: null,
      cumulativeGasUsed: BigInt(0),
      effectiveGasPrice: BigInt(0),
      from: '0x1',
      gasUsed: BigInt(0),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x2',
      transactionHash: '0xinit123',
      transactionIndex: 0,
      type: 'eip1559',
    };
    const recipient = '0x9876543210987654321098765432109876543210';
    const amount = parseUnits('0.1', 18).toString();

    beforeEach(() => {
      jest.mocked(getRebalanceOperationByTransactionHash).mockResolvedValue({
        id: 'op-1',
        amount: amount,
      } as any);
      mockDatabase.createCexWithdrawalRecord.mockResolvedValue({} as any);
      mockClient.sendCrypto.mockResolvedValue({
        data: { id: 'wd-new', status: 'pending' },
      } as any);
    });

    it('successfully initiates withdrawal', async () => {
      const res = await adapter.initiateWithdrawal(route, originTx, amount, recipient);
      expect(res).toEqual({ id: 'wd-new' });
      expect(mockClient.sendCrypto).toHaveBeenCalled();
      expect(mockDatabase.createCexWithdrawalRecord).toHaveBeenCalled();
    });

    it('throws when no rebalance operation found', async () => {
      jest.mocked(getRebalanceOperationByTransactionHash).mockResolvedValue(undefined as any);
      await expect(adapter.initiateWithdrawal(route, originTx, amount, recipient)).rejects.toThrow(
        'No rebalance operation found for transaction',
      );
    });

    it('throws when origin asset not found', async () => {
      const assetModule = jest.requireMock('../../../src/shared/asset') as any;
      assetModule.findAssetByAddress.mockReturnValue(null);
      await expect(adapter.initiateWithdrawal(route, originTx, amount, recipient)).rejects.toThrow('No origin asset found');
    });

    it('handles withdrawal API errors', async () => {
      mockClient.sendCrypto.mockRejectedValue(new Error('API error'));
      await expect(adapter.initiateWithdrawal(route, originTx, amount, recipient)).rejects.toThrow('API error');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to initiate withdrawal', expect.any(Object));
    });
  });

  describe('getProvider()', () => {
    it('returns undefined for chain without config', () => {
      const res = adapter.getProvider(999);
      expect(res).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('No provider configured for chain', { chainId: 999 });
    });

    it('returns undefined for chain without providers', () => {
      const cfgNoProviders = {
        ...mockConfig,
        chains: {
          '1': { ...mockConfig.chains['1'], providers: [] },
        },
      };
      const adapterNoProviders = new TestCoinbaseBridgeAdapter(cfgNoProviders, mockLogger, mockDatabase);
      const res = adapterNoProviders.getProvider(1);
      expect(res).toBeUndefined();
    });

    it('handles errors when creating provider', () => {
      // Mock createPublicClient to throw an error
      const originalCreatePublicClient = require('viem').createPublicClient;
      jest.spyOn(require('viem'), 'createPublicClient').mockImplementationOnce(() => {
        throw new Error('Failed to create client');
      });
      
      const cfgInvalidProvider = {
        ...mockConfig,
        chains: {
          '1': { ...mockConfig.chains['1'], providers: ['invalid-url'] },
        },
      };
      const adapterInvalid = new TestCoinbaseBridgeAdapter(cfgInvalidProvider, mockLogger, mockDatabase);
      const res = adapterInvalid.getProvider(1);
      expect(res).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to create provider', expect.any(Object));
      
      // Restore original implementation
      jest.restoreAllMocks();
    });
  });

  describe('getOrInitWithdrawal()', () => {
    const route: RebalanceRoute = { origin: 1, destination: 42161, asset: mockAssets.WETH.address };
    const originTx: TransactionReceipt = {
      blockHash: '0xabc',
      blockNumber: BigInt(1),
      contractAddress: null,
      cumulativeGasUsed: BigInt(0),
      effectiveGasPrice: BigInt(0),
      from: '0x1',
      gasUsed: BigInt(0),
      logs: [],
      logsBloom: '0x',
      status: 'success',
      to: '0x2',
      transactionHash: '0xgetorinit',
      transactionIndex: 0,
      type: 'eip1559',
    };
    const recipient = '0x9876543210987654321098765432109876543210';
    const amount = parseUnits('0.1', 18).toString();

    beforeEach(() => {
      mockDatabase.getRebalanceOperationByTransactionHash.mockResolvedValue({
        id: 'rebalance-1',
        recipient,
      } as any);
    });

    it('returns undefined when deposit not confirmed', async () => {
      jest.spyOn(adapter, 'checkDepositConfirmed').mockResolvedValue({ confirmed: false });
      const res = await adapter.getOrInitWithdrawal(amount, route, originTx, recipient);
      expect(res).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Deposit not yet confirmed', expect.any(Object));
    });

    it('initiates withdrawal when not found', async () => {
      jest.spyOn(adapter, 'checkDepositConfirmed').mockResolvedValue({ confirmed: true });
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue(undefined);
      jest.spyOn(adapter, 'initiateWithdrawal').mockResolvedValue({ id: 'wd-new' });
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-new',
        status: 'pending',
        network: {},
      } as any);
      const res = await adapter.getOrInitWithdrawal(amount, route, originTx, recipient);
      expect(res).toBeDefined();
      expect(adapter.initiateWithdrawal).toHaveBeenCalled();
    });

    it('returns pending status when withdrawal not found by client', async () => {
      jest.spyOn(adapter, 'checkDepositConfirmed').mockResolvedValue({ confirmed: true });
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      mockClient.getWithdrawalById.mockResolvedValue(undefined as any);
      const res = await adapter.getOrInitWithdrawal(amount, route, originTx, recipient);
      expect(res).toEqual({ status: 'pending', onChainConfirmed: false });
    });

    it('handles on-chain confirmation when provider is undefined', async () => {
      jest.spyOn(adapter, 'checkDepositConfirmed').mockResolvedValue({ confirmed: true });
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      jest.spyOn(adapter, 'getProvider').mockReturnValue(undefined);
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-1',
        status: 'completed',
        network: { hash: '0xhash' },
      } as any);
      const res = await adapter.getOrInitWithdrawal(amount, route, originTx, recipient);
      expect(res).toBeDefined();
      expect(res?.onChainConfirmed).toBe(false);
    });

    it('handles on-chain confirmation error gracefully', async () => {
      jest.spyOn(adapter, 'checkDepositConfirmed').mockResolvedValue({ confirmed: true });
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      const getTransactionReceiptMock = jest.fn<() => Promise<any>>().mockRejectedValue(new Error('RPC error'));
      const provider = {
        getTransactionReceipt: getTransactionReceiptMock,
      };
      jest.spyOn(adapter, 'getProvider').mockReturnValue(provider as any);
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-1',
        status: 'completed',
        network: { hash: '0xhash' },
      } as any);
      const res = await adapter.getOrInitWithdrawal(amount, route, originTx, recipient);
      expect(res).toBeDefined();
      expect(res?.onChainConfirmed).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith('Could not verify on-chain confirmation', expect.any(Object));
    });

    it('marks withdrawal as completed when network hash exists', async () => {
      jest.spyOn(adapter, 'checkDepositConfirmed').mockResolvedValue({ confirmed: true });
      jest.spyOn(adapter, 'findExistingWithdrawal').mockResolvedValue({ id: 'wd-1' });
      jest.spyOn(adapter, 'getProvider').mockReturnValue(undefined);
      mockClient.getWithdrawalById.mockResolvedValue({
        id: 'wd-1',
        status: 'pending',
        network: { hash: '0xhash' },
      } as any);
      const res = await adapter.getOrInitWithdrawal(amount, route, originTx, recipient);
      expect(res?.status).toBe('completed');
    });

    it('handles errors and throws', async () => {
      jest.spyOn(adapter, 'checkDepositConfirmed').mockRejectedValue(new Error('Test error'));
      await expect(adapter.getOrInitWithdrawal(amount, route, originTx, recipient)).rejects.toThrow('Test error');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to get withdrawal status', expect.any(Object));
    });
  });

  describe('getAccounts()', () => {
    it('successfully retrieves accounts', async () => {
      mockClient.getAccounts.mockResolvedValue({
        data: [{ id: 'acc-1' }, { id: 'acc-2' }],
      } as any);
      const res = await adapter.getAccounts();
      expect(res.data).toHaveLength(2);
      expect(mockLogger.debug).toHaveBeenCalledWith('Retrieved Coinbase accounts', expect.any(Object));
    });

    it('handles errors', async () => {
      mockClient.getAccounts.mockRejectedValue(new Error('API error'));
      await expect(adapter.getAccounts()).rejects.toThrow('API error');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to retrieve Coinbase accounts', expect.any(Object));
    });
  });

  describe('handleError()', () => {
    it('logs and throws formatted error', () => {
      const error = new Error('Test error');
      expect(() => adapter.handleError(error, 'test operation', { key: 'value' })).toThrow('Failed to test operation: Test error');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to test operation', {
        error: jsonifyError(error),
        key: 'value',
      });
    });

    it('handles unknown error types', () => {
      expect(() => adapter.handleError('string error', 'test', {})).toThrow('Failed to test: Unknown error');
    });
  });
});


