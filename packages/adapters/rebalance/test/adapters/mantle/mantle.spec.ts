/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { AssetConfiguration, ChainConfiguration, RebalanceRoute, SupportedBridge } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { createPublicClient, decodeEventLog, TransactionReceipt, encodeFunctionData, erc20Abi } from 'viem';
import { MantleBridgeAdapter } from '../../../src/adapters/mantle/mantle';
import { RebalanceTransactionMemo } from '../../../src/types';
import { findMatchingDestinationAsset } from '../../../src/shared/asset';
import {
  METH_STAKING_CONTRACT_ADDRESS,
  METH_ON_ETH_ADDRESS,
  METH_ON_MANTLE_ADDRESS,
  MANTLE_BRIDGE_CONTRACT_ADDRESS,
} from '../../../src/adapters/mantle/types';

// Mock external dependencies
jest.mock('viem');
jest.mock('@mark/logger');
jest.mock('../../../src/shared/asset');

// Test adapter that exposes protected methods for testing
class TestMantleBridgeAdapter extends MantleBridgeAdapter {
  public getPublicClientTest(chainId: number) {
    return super.getPublicClient(chainId);
  }

  public getMessengerAddressesTest(chainId: number) {
    return super.getMessengerAddresses(chainId);
  }

  public extractMantleMessageTest(receipt: TransactionReceipt, messengerAddress: `0x${string}`) {
    return super.extractMantleMessage(receipt, messengerAddress);
  }

  public computeMessageHashTest(message: any) {
    return super.computeMessageHash(message);
  }

  public handleErrorTest(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    return super.handleError(error, context, metadata);
  }
}

// Mock Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

// Mock asset configurations
const mockAssets: Record<string, AssetConfiguration> = {
  WETH: {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol: 'WETH',
    decimals: 18,
    tickerHash: '0xWETHHash',
    isNative: false,
    balanceThreshold: '0',
  },
  mETH: {
    address: METH_ON_MANTLE_ADDRESS,
    symbol: 'mETH',
    decimals: 18,
    tickerHash: '0xmETHHash',
    isNative: false,
    balanceThreshold: '0',
  },
};

// Mock chain configurations
const mockChains: Record<string, ChainConfiguration> = {
  '1': {
    assets: [mockAssets['WETH']],
    providers: ['https://eth-mainnet.example.com'],
    invoiceAge: 3600,
    gasThreshold: '100000000000',
    deployments: {
      everclear: '0xEverclearAddress',
      permit2: '0xPermit2Address',
      multicall3: '0xMulticall3Address',
    },
  },
  '5000': {
    assets: [mockAssets['mETH']],
    providers: ['https://mantle-mainnet.example.com'],
    invoiceAge: 3600,
    gasThreshold: '100000000000',
    deployments: {
      everclear: '0xEverclearAddress',
      permit2: '0xPermit2Address',
      multicall3: '0xMulticall3Address',
    },
  },
};

describe('MantleBridgeAdapter', () => {
  let adapter: TestMantleBridgeAdapter;
  let mockReadContract: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock public client - use any casting for mock values to avoid TypeScript issues
    mockReadContract = jest.fn();
    const mockGetBlockNumber = jest.fn();
    (mockGetBlockNumber as any).mockResolvedValue(BigInt(1000000));
    const mockGetLogs = jest.fn();
    (mockGetLogs as any).mockResolvedValue([]);
    
    (createPublicClient as jest.Mock).mockReturnValue({
      readContract: mockReadContract,
      getBlockNumber: mockGetBlockNumber,
      getLogs: mockGetLogs,
    });

    // Setup default asset matching
    (findMatchingDestinationAsset as jest.Mock).mockImplementation((asset, origin, destination) => {
      if (destination === 5000) {
        return mockAssets['mETH'];
      }
      return undefined;
    });

    // Reset logger mocks
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    // Create adapter instance
    adapter = new TestMantleBridgeAdapter(mockChains, mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default configuration', () => {
      expect(adapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Initializing MantleBridgeAdapter', expect.any(Object));
    });

    it('should initialize with custom configuration', () => {
      const customConfig = {
        mantle: {
          l2Gas: 300000,
          stakingContractAddress: '0x1234567890123456789012345678901234567890',
          methL1Address: '0x2345678901234567890123456789012345678901',
          methL2Address: '0x3456789012345678901234567890123456789012',
          bridgeContractAddress: '0x4567890123456789012345678901234567890123',
        },
      };

      const customAdapter = new TestMantleBridgeAdapter(mockChains, mockLogger, customConfig);
      expect(customAdapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Initializing MantleBridgeAdapter',
        expect.objectContaining({
          l2Gas: '300000',
          stakingContract: customConfig.mantle.stakingContractAddress,
        }),
      );
    });
  });

  describe('type', () => {
    it('should return the correct bridge type', () => {
      expect(adapter.type()).toBe(SupportedBridge.Mantle);
    });
  });

  describe('getReceivedAmount', () => {
    const route: RebalanceRoute = {
      asset: mockAssets['WETH'].address,
      origin: 1,
      destination: 5000,
    };

    it('should return mETH amount for given ETH amount', async () => {
      const amount = '1000000000000000000'; // 1 ETH
      const expectedMethAmount = BigInt('980000000000000000'); // ~0.98 mETH
      const minimumStakeBound = BigInt('100000000000000'); // 0.0001 ETH

      mockReadContract
        .mockResolvedValueOnce(minimumStakeBound) // minimumStakeBound
        .mockResolvedValueOnce(expectedMethAmount); // ethToMETH

      const result = await adapter.getReceivedAmount(amount, route);

      expect(result).toBe(expectedMethAmount.toString());
      expect(mockReadContract).toHaveBeenCalledTimes(2);
      expect(mockReadContract).toHaveBeenCalledWith({
        address: METH_STAKING_CONTRACT_ADDRESS,
        abi: expect.any(Array),
        functionName: 'minimumStakeBound',
      });
      expect(mockReadContract).toHaveBeenCalledWith({
        address: METH_STAKING_CONTRACT_ADDRESS,
        abi: expect.any(Array),
        functionName: 'ethToMETH',
        args: [BigInt(amount)],
      });
    });

    it('should throw error if amount is below minimum stake bound', async () => {
      const amount = '100'; // Very small amount
      const minimumStakeBound = BigInt('100000000000000'); // 0.0001 ETH

      mockReadContract.mockResolvedValueOnce(minimumStakeBound);

      await expect(adapter.getReceivedAmount(amount, route)).rejects.toThrow(
        /is less than minimum stake bound/,
      );
    });

    it('should handle contract read errors gracefully', async () => {
      mockReadContract.mockRejectedValueOnce(new Error('RPC error'));

      await expect(adapter.getReceivedAmount('1000000000000000000', route)).rejects.toThrow(
        /Failed to get m-eth amount/,
      );
    });
  });

  describe('getMinimumAmount', () => {
    const route: RebalanceRoute = {
      asset: mockAssets['WETH'].address,
      origin: 1,
      destination: 5000,
    };

    it('should return minimum stake bound from contract', async () => {
      const minimumStakeBound = BigInt('100000000000000'); // 0.0001 ETH
      mockReadContract.mockResolvedValueOnce(minimumStakeBound);

      const result = await adapter.getMinimumAmount(route);

      expect(result).toBe(minimumStakeBound.toString());
    });

    it('should return null on error', async () => {
      mockReadContract.mockRejectedValueOnce(new Error('RPC error'));

      const result = await adapter.getMinimumAmount(route);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to get minimum stake bound for Mantle',
        expect.any(Object),
      );
    });
  });

  describe('send', () => {
    const route: RebalanceRoute = {
      asset: mockAssets['WETH'].address,
      origin: 1,
      destination: 5000,
    };
    const sender = '0x1111111111111111111111111111111111111111';
    const recipient = '0x2222222222222222222222222222222222222222';
    const amount = '1000000000000000000'; // 1 ETH

    beforeEach(() => {
      (encodeFunctionData as jest.Mock).mockReturnValue('0xmockeddata');
    });

    it('should return 4 transactions: unwrap, stake, approve, bridge', async () => {
      const methAmount = BigInt('980000000000000000');
      const minimumStakeBound = BigInt('100000000000000');

      mockReadContract
        .mockResolvedValueOnce(minimumStakeBound) // minimumStakeBound (getReceivedAmount)
        .mockResolvedValueOnce(methAmount) // ethToMETH (getReceivedAmount)
        .mockResolvedValueOnce(BigInt(0)); // allowance (insufficient)

      const result = await adapter.send(sender, recipient, amount, route);

      expect(result).toHaveLength(4);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(result[1].memo).toBe(RebalanceTransactionMemo.Stake);
      expect(result[2].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(result[3].memo).toBe(RebalanceTransactionMemo.Rebalance);
    });

    it('should skip approval if allowance is sufficient', async () => {
      const methAmount = BigInt('980000000000000000');
      const minimumStakeBound = BigInt('100000000000000');

      mockReadContract
        .mockResolvedValueOnce(minimumStakeBound)
        .mockResolvedValueOnce(methAmount)
        .mockResolvedValueOnce(methAmount); // allowance (sufficient)

      const result = await adapter.send(sender, recipient, amount, route);

      expect(result).toHaveLength(3);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Unwrap);
      expect(result[1].memo).toBe(RebalanceTransactionMemo.Stake);
      expect(result[2].memo).toBe(RebalanceTransactionMemo.Rebalance);
    });

    it('should throw error if destination asset not found', async () => {
      (findMatchingDestinationAsset as jest.Mock).mockReturnValue(undefined);

      await expect(adapter.send(sender, recipient, amount, route)).rejects.toThrow(
        /Could not find matching destination asset/,
      );
    });

    it('should correctly set unwrap transaction to WETH address', async () => {
      const methAmount = BigInt('980000000000000000');
      const minimumStakeBound = BigInt('100000000000000');

      mockReadContract
        .mockResolvedValueOnce(minimumStakeBound)
        .mockResolvedValueOnce(methAmount)
        .mockResolvedValueOnce(methAmount);

      const result = await adapter.send(sender, recipient, amount, route);

      // Unwrap transaction should target the WETH address
      expect(result[0].transaction.to).toBe(route.asset);
      expect(result[0].transaction.value).toBe(BigInt(0));
    });

    it('should correctly set stake transaction with ETH value', async () => {
      const methAmount = BigInt('980000000000000000');
      const minimumStakeBound = BigInt('100000000000000');

      mockReadContract
        .mockResolvedValueOnce(minimumStakeBound)
        .mockResolvedValueOnce(methAmount)
        .mockResolvedValueOnce(methAmount);

      const result = await adapter.send(sender, recipient, amount, route);

      // Stake transaction should have value = amount (ETH to stake)
      expect(result[1].transaction.to).toBe(METH_STAKING_CONTRACT_ADDRESS);
      expect(result[1].transaction.value).toBe(BigInt(amount));
    });

    it('should correctly set bridge transaction', async () => {
      const methAmount = BigInt('980000000000000000');
      const minimumStakeBound = BigInt('100000000000000');

      mockReadContract
        .mockResolvedValueOnce(minimumStakeBound)
        .mockResolvedValueOnce(methAmount)
        .mockResolvedValueOnce(methAmount);

      const result = await adapter.send(sender, recipient, amount, route);

      // Bridge transaction
      expect(result[2].transaction.to).toBe(MANTLE_BRIDGE_CONTRACT_ADDRESS);
      expect(result[2].transaction.value).toBe(BigInt(0));
      expect(result[2].transaction.funcSig).toBe('depositERC20To(address,address,address,uint256,uint32,bytes)');
    });
  });

  describe('destinationCallback', () => {
    const route: RebalanceRoute = {
      asset: mockAssets['WETH'].address,
      origin: 1,
      destination: 5000,
    };

    it('should return undefined (no callback needed for Mantle)', async () => {
      const mockReceipt = {
        transactionHash: '0xmocktxhash',
        logs: [],
      } as unknown as TransactionReceipt;

      const result = await adapter.destinationCallback(route, mockReceipt);

      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Mantle destinationCallback invoked - no action required',
        expect.any(Object),
      );
    });
  });

  describe('readyOnDestination', () => {
    const route: RebalanceRoute = {
      asset: mockAssets['WETH'].address,
      origin: 1,
      destination: 5000,
    };

    it('should return true when message is relayed', async () => {
      const messengerAddress = '0x676A795fe6E43C17c668de16730c3F690FEB7120';
      const mockReceipt = {
        transactionHash: '0xmocktxhash',
        logs: [
          {
            address: messengerAddress, // L1 messenger
            topics: ['0xSentMessageTopic'],
            data: '0x',
          },
        ],
      } as unknown as TransactionReceipt;

      // Mock decodeEventLog to return SentMessage event
      (decodeEventLog as jest.Mock).mockReturnValue({
        eventName: 'SentMessage',
        args: {
          target: '0x1111111111111111111111111111111111111111' as `0x${string}`,
          sender: '0x2222222222222222222222222222222222222222' as `0x${string}`,
          message: '0xMessageData' as `0x${string}`,
          messageNonce: BigInt(1),
          gasLimit: BigInt(200000),
        },
      });

      // Mock encodeFunctionData for computeMessageHash
      (encodeFunctionData as jest.Mock).mockReturnValue('0xencodedMessage');

      // Mock successfulMessages returns true (message has been relayed)
      mockReadContract.mockResolvedValueOnce(true);

      const result = await adapter.readyOnDestination('1000000000000000000', route, mockReceipt);

      expect(result).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Deposit ready status determined',
        expect.objectContaining({
          isReady: true,
        }),
      );
    });

    it('should return false on error', async () => {
      const mockReceipt = {
        transactionHash: '0xmocktxhash',
        logs: [],
      } as unknown as TransactionReceipt;

      const result = await adapter.readyOnDestination('1000000000000000000', route, mockReceipt);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('getMessengerAddresses', () => {
    it('should return correct addresses for Mantle mainnet', () => {
      const addresses = adapter.getMessengerAddressesTest(5000);

      expect(addresses).toEqual({
        l1: '0x676A795fe6E43C17c668de16730c3F690FEB7120',
        l2: '0x4200000000000000000000000000000000000007',
      });
    });

    it('should throw error for unsupported chain', () => {
      expect(() => adapter.getMessengerAddressesTest(99999)).toThrow(
        /Unsupported Mantle chain id/,
      );
    });
  });

  describe('getPublicClient', () => {
    it('should create and cache public client', () => {
      const client1 = adapter.getPublicClientTest(1);
      const client2 = adapter.getPublicClientTest(1);

      // Should be the same cached instance
      expect(client1).toBe(client2);
      // createPublicClient should only be called once for chain 1
      expect(createPublicClient).toHaveBeenCalledTimes(1);
    });

    it('should throw error if no providers for chain', () => {
      const chainsNoProviders = {
        '999': {
          ...mockChains['1'],
          providers: [],
        },
      };
      const adapterNoProviders = new TestMantleBridgeAdapter(chainsNoProviders, mockLogger);

      expect(() => adapterNoProviders.getPublicClientTest(999)).toThrow(
        /No providers found for chain/,
      );
    });
  });

  describe('handleError', () => {
    it('should log error and throw with context', () => {
      const error = new Error('Test error');
      const context = 'test operation';
      const metadata = { test: 'data' };

      expect(() => adapter.handleErrorTest(error, context, metadata)).toThrow(
        'Failed to test operation: Test error',
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to test operation',
        expect.objectContaining({
          error: jsonifyError(error),
          test: 'data',
        }),
      );
    });
  });

  describe('extractMantleMessage', () => {
    it('should throw error if no SentMessage event found', () => {
      const mockReceipt = {
        logs: [],
      } as unknown as TransactionReceipt;

      expect(() =>
        adapter.extractMantleMessageTest(mockReceipt, '0x676A795fe6E43C17c668de16730c3F690FEB7120'),
      ).toThrow(/Mantle SentMessage event not found/);
    });

    it('should extract message from receipt logs', () => {
      const messengerAddress = '0x676A795fe6E43C17c668de16730c3F690FEB7120';
      const mockReceipt = {
        logs: [
          {
            address: messengerAddress,
            topics: ['0xSentMessageTopic', '0xArg1', '0xArg2'],
            data: '0xdata',
          },
        ],
      } as unknown as TransactionReceipt;

      (decodeEventLog as jest.Mock).mockReturnValue({
        eventName: 'SentMessage',
        args: {
          target: '0x1111111111111111111111111111111111111111',
          sender: '0x2222222222222222222222222222222222222222',
          message: '0xMessageData',
          messageNonce: BigInt(123),
          gasLimit: BigInt(200000),
        },
      });

      const result = adapter.extractMantleMessageTest(mockReceipt, messengerAddress as `0x${string}`);

      expect(result).toEqual({
        target: '0x1111111111111111111111111111111111111111',
        sender: '0x2222222222222222222222222222222222222222',
        message: '0xMessageData',
        messageNonce: BigInt(123),
        gasLimit: BigInt(200000),
        mntValue: BigInt(0),
        ethValue: BigInt(0),
      });
    });
  });

  describe('configuration overrides', () => {
    it('should use custom L2 gas when configured', async () => {
      const customConfig = {
        mantle: {
          l2Gas: 500000,
        },
      };
      const customAdapter = new TestMantleBridgeAdapter(mockChains, mockLogger, customConfig);

      // Verify the config was applied by checking the debug log
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Initializing MantleBridgeAdapter',
        expect.objectContaining({
          l2Gas: '500000',
        }),
      );
    });

    it('should use default contract addresses when not configured', () => {
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Initializing MantleBridgeAdapter',
        expect.objectContaining({
          stakingContract: METH_STAKING_CONTRACT_ADDRESS,
          methL1: METH_ON_ETH_ADDRESS,
          methL2: METH_ON_MANTLE_ADDRESS,
          bridgeContract: MANTLE_BRIDGE_CONTRACT_ADDRESS,
        }),
      );
    });
  });
});

