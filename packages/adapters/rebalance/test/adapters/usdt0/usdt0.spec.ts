/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, axiosGet, cleanupHttpConnections } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { TransactionReceipt } from 'viem';
import { Usdt0BridgeAdapter } from '../../../src/adapters/usdt0/usdt0';
import {
  USDT0_LEGACY_MESH_ETH,
  USDT_ETH,
  USDT0_LZ_ENDPOINT_TON,
  USDT0_LEGACY_MESH_FEE_BPS,
} from '../../../src/adapters/usdt0/types';
import { RebalanceTransactionMemo } from '../../../src/types';

// Mock viem functions
const mockReadContract = jest.fn();
const mockDecodeEventLog = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem') as any;
  return {
    ...actual,
    createPublicClient: jest.fn(() => ({
      getBalance: jest.fn().mockResolvedValue(1000000n as never),
      readContract: mockReadContract,
      getTransactionReceipt: jest.fn(),
    })),
    encodeFunctionData: jest.fn().mockReturnValue('0xmockEncodedData' as never),
    pad: jest.fn().mockReturnValue(('0x' + '0'.repeat(64)) as never),
    decodeEventLog: (...args: any[]) => mockDecodeEventLog(...args),
  };
});

jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core') as any;
  return {
    ...actual,
    axiosGet: jest.fn(),
    cleanupHttpConnections: jest.fn(),
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

// Mock logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

// Mock chain configurations
const USDT_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';

const mockChains: Record<string, ChainConfiguration> = {
  '1': {
    assets: [
      {
        address: USDT_ETH,
        symbol: 'USDT',
        decimals: 6,
        tickerHash: USDT_TICKER_HASH,
        isNative: false,
        balanceThreshold: '0',
      },
    ],
    providers: ['https://mock-eth-rpc.example.com'],
    invoiceAge: 3600,
    gasThreshold: '5000000000000000',
    deployments: {
      everclear: '0xMockEverclearAddress',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
};

// Standard test route: ETH USDT -> TON
const ethToTonRoute: RebalanceRoute = {
  asset: USDT_ETH,
  origin: 1,
  destination: 30826, // TON chain ID used by the TAC rebalancer
};

const mockSender = '0x1234567890abcdef1234567890abcdef12345678';
const mockTonRecipient = 'EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t';

describe('Usdt0BridgeAdapter', () => {
  let adapter: Usdt0BridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    adapter = new Usdt0BridgeAdapter(mockChains, mockLogger);
  });

  afterEach(() => {
    cleanupHttpConnections();
  });

  describe('constructor', () => {
    it('should initialize and log contract details', () => {
      expect(adapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Initializing Usdt0BridgeAdapter (Legacy Mesh)',
        expect.objectContaining({
          contract: USDT0_LEGACY_MESH_ETH,
          tonEndpointId: USDT0_LZ_ENDPOINT_TON,
        }),
      );
    });
  });

  describe('type', () => {
    it('should return SupportedBridge.Usdt0', () => {
      expect(adapter.type()).toBe(SupportedBridge.Usdt0);
    });

    it('should return usdt0 string', () => {
      expect(adapter.type()).toBe('usdt0');
    });
  });

  describe('getMinimumAmount', () => {
    it('should return null to defer to caller config', async () => {
      const result = await adapter.getMinimumAmount(ethToTonRoute);
      expect(result).toBeNull();
    });
  });

  describe('getReceivedAmount', () => {
    it('should apply fixed 0.03% Legacy Mesh fee', async () => {
      const result = await adapter.getReceivedAmount('1000000', ethToTonRoute);

      // 1000000 - (1000000 * 3 / 10000) = 1000000 - 300 = 999700
      expect(result).toBe('999700');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'USDT0 received amount (fixed 0.03% Legacy Mesh fee)',
        expect.objectContaining({
          estimatedReceived: '999700',
          feeBps: '3',
        }),
      );
    });

    it('should handle large amounts correctly', async () => {
      const result = await adapter.getReceivedAmount('100000000000', ethToTonRoute); // 100k USDT

      // 100000000000 - (100000000000 * 3 / 10000) = 100000000000 - 30000000 = 99970000000
      expect(result).toBe('99970000000');
    });

    it('should handle small amounts (1 USDT)', async () => {
      const result = await adapter.getReceivedAmount('1000000', ethToTonRoute);
      expect(Number(result)).toBeGreaterThan(0);
      expect(Number(result)).toBeLessThanOrEqual(1000000);
    });
  });

  describe('send', () => {
    beforeEach(() => {
      // Mock quoteSend for messaging fee
      mockReadContract.mockResolvedValue({
        nativeFee: 50000000000000n, // ~0.00005 ETH
        lzTokenFee: 0n,
      } as never);
    });

    it('should return approval + send transactions when allowance is insufficient', async () => {
      // First call: quoteSend, Second call: allowance check
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000n, lzTokenFee: 0n } as never) // quoteSend
        .mockResolvedValueOnce(0n as never); // allowance = 0

      const txs = await adapter.send(mockSender, mockTonRecipient, '1000000', ethToTonRoute);

      // Should have approval + send transactions
      expect(txs.length).toBe(2);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Rebalance);

      // Send tx should target USDT0 Legacy Mesh contract
      expect(txs[1].transaction.to).toBe(USDT0_LEGACY_MESH_ETH);
      // Should pay native fee as value
      expect(txs[1].transaction.value).toBe(50000000000000n);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'USDT0 bridge transactions prepared',
        expect.objectContaining({
          contract: USDT0_LEGACY_MESH_ETH,
          dstEid: USDT0_LZ_ENDPOINT_TON,
          transactionCount: 2,
        }),
      );
    });

    it('should add zero-approval for mainnet USDT when existing allowance is non-zero', async () => {
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000n, lzTokenFee: 0n } as never) // quoteSend
        .mockResolvedValueOnce(500000n as never); // existing non-zero allowance

      const txs = await adapter.send(mockSender, mockTonRecipient, '1000000', ethToTonRoute);

      // Should have zero-approval + approval + send = 3 transactions
      expect(txs.length).toBe(3);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval); // zero approval
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Approval); // actual approval
      expect(txs[2].memo).toBe(RebalanceTransactionMemo.Rebalance); // send

      expect(mockLogger.info).toHaveBeenCalledWith(
        'USDT0: Adding zero-approval for mainnet USDT (non-standard ERC20)',
        expect.any(Object),
      );
    });

    it('should skip approval when allowance is sufficient', async () => {
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000n, lzTokenFee: 0n } as never) // quoteSend
        .mockResolvedValueOnce(2000000n as never); // allowance > amount

      const txs = await adapter.send(mockSender, mockTonRecipient, '1000000', ethToTonRoute);

      // Should have only the send transaction
      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
    });

    it('should handle EVM recipient address (0x-prefixed)', async () => {
      const evmRecipient = '0xabcdef1234567890abcdef1234567890abcdef12';

      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000n, lzTokenFee: 0n } as never)
        .mockResolvedValueOnce(2000000n as never);

      const txs = await adapter.send(mockSender, evmRecipient, '1000000', ethToTonRoute);

      expect(txs.length).toBe(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'USDT0 encoding recipient address',
        expect.objectContaining({
          isTonAddress: false,
        }),
      );
    });

    it('should handle TON address recipient', async () => {
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000n, lzTokenFee: 0n } as never)
        .mockResolvedValueOnce(2000000n as never);

      const txs = await adapter.send(mockSender, mockTonRecipient, '1000000', ethToTonRoute);

      expect(txs.length).toBe(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'USDT0 encoding recipient address',
        expect.objectContaining({
          isTonAddress: true,
        }),
      );
    });

    it('should throw when quoteSend fails', async () => {
      mockReadContract.mockRejectedValueOnce(new Error('RPC error') as never);

      await expect(adapter.send(mockSender, mockTonRecipient, '1000000', ethToTonRoute)).rejects.toThrow(
        'Failed to prepare USDT0 bridge',
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to prepare USDT0 bridge transactions',
        expect.objectContaining({
          sender: mockSender,
          recipient: mockTonRecipient,
        }),
      );
    });
  });

  describe('destinationCallback', () => {
    it('should be a no-op (auto-delivery)', async () => {
      const mockReceipt = { transactionHash: '0xabc123' } as unknown as TransactionReceipt;
      const result = await adapter.destinationCallback(ethToTonRoute, mockReceipt);
      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'USDT0 destinationCallback invoked - no action required (auto-delivery)',
        expect.any(Object),
      );
    });
  });

  describe('readyOnDestination', () => {
    const mockGuid = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

    const mockReceipt = {
      transactionHash: '0xabcd1234',
      logs: [
        {
          data: '0x' as `0x${string}`,
          topics: [
            '0x85496b760a4b105f3571ae44ffdc7ea14dc10cafe07bb51a4cf783bd19f3a5d1',
            mockGuid,
            ('0x' + '00'.repeat(12) + mockSender.slice(2)) as `0x${string}`,
          ] as [`0x${string}`, ...`0x${string}`[]],
        },
      ],
    } as unknown as TransactionReceipt;

    beforeEach(() => {
      // Mock decodeEventLog to return a valid OFTSent event
      mockDecodeEventLog.mockReturnValue({
        eventName: 'OFTSent',
        args: { guid: mockGuid },
      });
    });

    it('should return true when LayerZero status is DELIVERED', async () => {
      const mockApiResponse = {
        data: [
          {
            pathway: { srcEid: 30101, dstEid: USDT0_LZ_ENDPOINT_TON },
            source: { tx: { txHash: '0xabcd1234', blockNumber: '12345678' } },
            destination: { tx: { txHash: '0xdest4567', blockNumber: 9876543 } },
            status: { name: 'DELIVERED' },
          },
        ],
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.readyOnDestination('1000000', ethToTonRoute, mockReceipt);

      expect(result).toBe(true);
      expect(axiosGet).toHaveBeenCalledWith('https://scan.layerzero-api.com/v1/messages/tx/0xabcd1234');
    });

    it('should return false when LayerZero status is INFLIGHT', async () => {
      const mockApiResponse = {
        data: [
          {
            pathway: { srcEid: 30101, dstEid: USDT0_LZ_ENDPOINT_TON },
            source: { tx: { txHash: '0xabcd1234', blockNumber: '12345678' } },
            destination: { tx: undefined },
            status: { name: 'INFLIGHT' },
          },
        ],
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.readyOnDestination('1000000', ethToTonRoute, mockReceipt);

      expect(result).toBe(false);
    });

    it('should return false and log error when status is FAILED', async () => {
      const mockApiResponse = {
        data: [
          {
            pathway: { srcEid: 30101, dstEid: USDT0_LZ_ENDPOINT_TON },
            source: { tx: { txHash: '0xabcd1234', blockNumber: '12345678' } },
            destination: { tx: undefined },
            status: { name: 'FAILED' },
          },
        ],
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.readyOnDestination('1000000', ethToTonRoute, mockReceipt);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'USDT0 LayerZero message failed or blocked',
        expect.objectContaining({
          status: 'FAILED',
        }),
      );
    });

    it('should return false when no GUID can be extracted from receipt', async () => {
      // Make decodeEventLog throw so no GUID is found
      mockDecodeEventLog.mockImplementation(() => {
        throw new Error('not OFTSent');
      });

      const emptyReceipt = {
        transactionHash: '0xnoevents',
        logs: [{ data: '0x', topics: ['0xdeadbeef'] }],
      } as unknown as TransactionReceipt;

      const result = await adapter.readyOnDestination('1000000', ethToTonRoute, emptyReceipt);

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'USDT0: Could not extract GUID from OFTSent event',
        expect.any(Object),
      );
    });

    it('should return false when LayerZero API returns no data', async () => {
      (axiosGet as jest.Mock).mockResolvedValue({ data: { data: [] } } as never);

      const result = await adapter.readyOnDestination('1000000', ethToTonRoute, mockReceipt);

      expect(result).toBe(false);
    });

    it('should return false when LayerZero API fails', async () => {
      (axiosGet as jest.Mock).mockRejectedValue(new Error('API error') as never);

      const result = await adapter.readyOnDestination('1000000', ethToTonRoute, mockReceipt);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'USDT0: Failed to query LayerZero Scan API',
        expect.objectContaining({
          txHash: '0xabcd1234',
        }),
      );
    });
  });

  describe('getDestinationTxHash', () => {
    it('should return destination tx hash when available', async () => {
      const mockApiResponse = {
        data: [
          {
            pathway: { srcEid: 30101, dstEid: USDT0_LZ_ENDPOINT_TON },
            source: { tx: { txHash: '0xabcd1234', blockNumber: '12345678' } },
            destination: { tx: { txHash: '0xdest4567' } },
            status: { name: 'DELIVERED' },
          },
        ],
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.getDestinationTxHash('0xabcd1234');

      expect(result).toBe('0xdest4567');
    });

    it('should return undefined when API fails', async () => {
      (axiosGet as jest.Mock).mockRejectedValue(new Error('API error') as never);

      const result = await adapter.getDestinationTxHash('0xabcd1234');

      expect(result).toBeUndefined();
    });
  });

  describe('constants', () => {
    it('should use correct Legacy Mesh contract address', () => {
      expect(USDT0_LEGACY_MESH_ETH).toBe('0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0');
    });

    it('should use correct TON endpoint ID (different from Stargate)', () => {
      expect(USDT0_LZ_ENDPOINT_TON).toBe(30343);
      // Stargate uses 30826, USDT0 uses 30343
      expect(USDT0_LZ_ENDPOINT_TON).not.toBe(30826);
    });

    it('should use correct USDT address', () => {
      expect(USDT_ETH).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
    });

    it('should have correct fee rate (0.03%)', () => {
      expect(USDT0_LEGACY_MESH_FEE_BPS).toBe(3n);
    });
  });
});
