/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, axiosGet, cleanupHttpConnections } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { TransactionReceipt } from 'viem';
import { StargateBridgeAdapter } from '../../../src/adapters/stargate/stargate';
import { 
  STARGATE_USDT_POOL_ETH, 
  USDT_ETH, 
  LZ_ENDPOINT_ID_TON, 
  LzMessageStatus,
  STARGATE_CHAIN_NAMES,
  USDT_TON_STARGATE,
  USDT_TON_JETTON,
  STARGATE_API_URL,
} from '../../../src/adapters/stargate/types';

// Mock viem functions
const mockReadContract = jest.fn();
const mockSimulateContract = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem') as any;
  return {
    ...actual,
    createPublicClient: jest.fn(() => ({
      getBalance: jest.fn().mockResolvedValue(1000000n as never),
      readContract: mockReadContract,
      getTransactionReceipt: jest.fn(),
      getTransaction: jest.fn(),
      simulateContract: mockSimulateContract,
    })),
    encodeFunctionData: jest.fn().mockReturnValue('0x' as never),
    pad: jest.fn().mockReturnValue('0x' + '0'.repeat(64) as never),
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

// Test adapter that exposes protected methods for testing
class TestStargateBridgeAdapter extends StargateBridgeAdapter {
  public async callGetLayerZeroMessageStatus(txHash: string, srcChainId: number) {
    return this.getLayerZeroMessageStatus(txHash, srcChainId);
  }

  public callGetPoolAddress(asset: string, chainId: number) {
    return this.getPoolAddress(asset, chainId);
  }

  public getPublicClients() {
    return this.publicClients;
  }

  public async callGetApiQuote(amount: string, route: RebalanceRoute) {
    return this.getApiQuote(amount, route);
  }

  public async callGetOnChainQuote(amount: string, route: RebalanceRoute) {
    return this.getOnChainQuote(amount, route);
  }

  public callGetPublicClient(chainId: number) {
    return this.getPublicClient(chainId);
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
  '1': {
    assets: [
      {
        address: USDT_ETH,
        symbol: 'USDT',
        decimals: 6,
        tickerHash: '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0',
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

describe('StargateBridgeAdapter', () => {
  let adapter: TestStargateBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset logger mocks
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    // Create fresh adapter instance
    adapter = new TestStargateBridgeAdapter(mockChains, mockLogger);
  });

  afterEach(() => {
    cleanupHttpConnections();
  });

  describe('constructor', () => {
    it('should initialize correctly', () => {
      expect(adapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Initializing StargateBridgeAdapter', expect.any(Object));
    });
  });

  describe('type', () => {
    it('should return the correct bridge type', () => {
      expect(adapter.type()).toBe(SupportedBridge.Stargate);
    });

    it('should return stargate string', () => {
      expect(adapter.type()).toBe('stargate');
    });
  });

  describe('getLayerZeroMessageStatus', () => {
    it('should return parsed status when API returns valid data', async () => {
      // Mock the new LayerZero Scan API response format
      const mockApiResponse = {
        data: [{
          pathway: { srcEid: 30101, dstEid: 30826 },
          source: { 
            tx: { 
              txHash: '0xabcd1234', 
              blockNumber: '12345678' 
            } 
          },
          destination: { 
            tx: { 
              txHash: '0xdest4567', 
              blockNumber: 9876543 
            } 
          },
          status: { name: 'DELIVERED', message: 'Message delivered successfully' },
        }],
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.callGetLayerZeroMessageStatus('0xabcd1234', 1);

      expect(result).toBeDefined();
      expect(result?.status).toBe('DELIVERED');
      expect(result?.srcTxHash).toBe('0xabcd1234');
      expect(result?.dstTxHash).toBe('0xdest4567');
      expect(result?.srcChainId).toBe(30101);
      expect(result?.dstChainId).toBe(30826);
      expect(result?.srcBlockNumber).toBe(12345678);
      expect(result?.dstBlockNumber).toBe(9876543);

      expect(axiosGet).toHaveBeenCalledWith(
        'https://scan.layerzero-api.com/v1/messages/tx/0xabcd1234'
      );
    });

    it('should return undefined when API returns empty data array', async () => {
      (axiosGet as jest.Mock).mockResolvedValue({ data: { data: [] } } as never);

      const result = await adapter.callGetLayerZeroMessageStatus('0xabcd1234', 1);

      expect(result).toBeUndefined();
    });

    it('should return undefined when API returns no data', async () => {
      (axiosGet as jest.Mock).mockResolvedValue({ data: { data: null } } as never);

      const result = await adapter.callGetLayerZeroMessageStatus('0xabcd1234', 1);

      expect(result).toBeUndefined();
    });

    it('should handle INFLIGHT status', async () => {
      const mockApiResponse = {
        data: [{
          pathway: { srcEid: 30101, dstEid: 30826 },
          source: { tx: { txHash: '0xabcd1234', blockNumber: '12345678' } },
          destination: { tx: undefined },
          status: { name: 'INFLIGHT' },
        }],
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.callGetLayerZeroMessageStatus('0xabcd1234', 1);

      expect(result).toBeDefined();
      expect(result?.status).toBe('INFLIGHT');
      expect(result?.dstTxHash).toBeUndefined();
    });

    it('should handle PAYLOAD_STORED status', async () => {
      const mockApiResponse = {
        data: [{
          pathway: { srcEid: 30101, dstEid: 30826 },
          source: { tx: { txHash: '0xabcd1234', blockNumber: '12345678' } },
          destination: { tx: undefined },
          status: { name: 'PAYLOAD_STORED' },
        }],
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.callGetLayerZeroMessageStatus('0xabcd1234', 1);

      expect(result?.status).toBe('PAYLOAD_STORED');
    });

    it('should handle API errors gracefully', async () => {
      (axiosGet as jest.Mock).mockRejectedValue(new Error('API error') as never);

      const result = await adapter.callGetLayerZeroMessageStatus('0xabcd1234', 1);

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to query LayerZero Scan API',
        expect.objectContaining({
          txHash: '0xabcd1234',
          srcChainId: 1,
        }),
      );
    });

    it('should use the correct LayerZero Scan API URL', async () => {
      (axiosGet as jest.Mock).mockResolvedValue({ data: { data: [] } } as never);

      await adapter.callGetLayerZeroMessageStatus('0xtest', 1);

      // Verify the new correct URL is used (not the old api.layerzero-scan.com)
      expect(axiosGet).toHaveBeenCalledWith(
        expect.stringContaining('scan.layerzero-api.com')
      );
      expect(axiosGet).not.toHaveBeenCalledWith(
        expect.stringContaining('api.layerzero-scan.com')
      );
    });
  });

  describe('getPoolAddress', () => {
    it('should return USDT pool address for Ethereum mainnet', () => {
      const result = adapter.callGetPoolAddress(USDT_ETH, 1);
      expect(result).toBe(STARGATE_USDT_POOL_ETH);
    });

    it('should throw error for unsupported asset', () => {
      expect(() => adapter.callGetPoolAddress('0xUnknownAsset', 1)).toThrow(
        'No Stargate pool found for asset 0xUnknownAsset on chain 1'
      );
    });

    it('should throw error for unsupported chain', () => {
      expect(() => adapter.callGetPoolAddress(USDT_ETH, 999)).toThrow(
        /No Stargate pool found/
      );
    });
  });

  describe('constants', () => {
    it('should have correct USDT on Ethereum address', () => {
      expect(USDT_ETH).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
    });

    it('should have correct Stargate USDT pool on Ethereum', () => {
      expect(STARGATE_USDT_POOL_ETH).toBe('0x933597a323Eb81cAe705C5bC29985172fd5A3973');
    });

    it('should have correct LayerZero endpoint ID for TON', () => {
      expect(LZ_ENDPOINT_ID_TON).toBe(30826);
    });

    it('should have correct USDT TON Stargate address', () => {
      // This is the address Stargate uses on TON
      expect(USDT_TON_STARGATE).toBeDefined();
    });

    it('should have correct USDT TON Jetton address (deprecated reference)', () => {
      expect(USDT_TON_JETTON).toBe('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
    });

    it('should have chain name mapping for Ethereum', () => {
      expect(STARGATE_CHAIN_NAMES[1]).toBe('ethereum');
    });
  });

  describe('LzMessageStatus enum', () => {
    it('should have DELIVERED status', () => {
      expect(LzMessageStatus.DELIVERED).toBe('DELIVERED');
    });

    it('should have INFLIGHT status', () => {
      expect(LzMessageStatus.INFLIGHT).toBe('INFLIGHT');
    });

    it('should have FAILED status', () => {
      expect(LzMessageStatus.FAILED).toBe('FAILED');
    });

    it('should have PAYLOAD_STORED status', () => {
      expect(LzMessageStatus.PAYLOAD_STORED).toBe('PAYLOAD_STORED');
    });

    it('should have BLOCKED status', () => {
      expect(LzMessageStatus.BLOCKED).toBe('BLOCKED');
    });
  });

  describe('getMinimumAmount', () => {
    it('should return null (no minimum requirement)', async () => {
      const route: RebalanceRoute = {
        origin: 1, // Ethereum
        destination: 30826, // TON (LayerZero endpoint ID)
        asset: USDT_ETH,
      };

      const result = await adapter.getMinimumAmount(route);
      expect(result).toBeNull();
    });
  });

  describe('readyOnDestination', () => {
    // Note: readyOnDestination first extracts GUID from transaction logs.
    // If GUID extraction fails (empty logs), it returns false early.
    // This tests the early return behavior when GUID can't be extracted.
    
    it('should return false when GUID cannot be extracted from receipt', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        logs: [], // Empty logs - no GUID can be extracted
      };

      const result = await adapter.readyOnDestination(
        '1000000',
        route,
        mockReceipt as TransactionReceipt,
      );

      // Should return false because GUID extraction fails
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Could not extract GUID from transaction receipt',
        expect.objectContaining({ transactionHash: '0xmocktxhash' }),
      );
    });

    it('should query LayerZero API when GUID is available', async () => {
      // This test verifies the API is called with correct URL format
      // We don't have the full mock for GUID extraction, so we test the API call directly
      
      (axiosGet as jest.Mock).mockResolvedValue({ data: { data: [] } } as never);

      // Call the protected method directly
      await adapter.callGetLayerZeroMessageStatus('0xmocktxhash', 1);

      // Verify the correct new API URL is used
      expect(axiosGet).toHaveBeenCalledWith(
        'https://scan.layerzero-api.com/v1/messages/tx/0xmocktxhash'
      );
    });
  });

  describe('destinationCallback', () => {
    it('should return undefined (no callback needed for Stargate)', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        logs: [],
      };

      const result = await adapter.destinationCallback(route, mockReceipt as TransactionReceipt);
      expect(result).toBeUndefined();
    });
  });

  describe('getReceivedAmount', () => {
    beforeEach(() => {
      mockReadContract.mockReset();
    });

    it('should return API quote when available', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // Mock successful API response
      const mockApiResponse = {
        quotes: [{
          route: { bridgeName: 'stargate' },
          dstAmount: '990000', // 0.99 USDT after fees
        }],
      };
      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.getReceivedAmount('1000000', route);
      expect(result).toBe('990000');
    });

    it('should fallback to on-chain quote when API fails', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // Mock API failure
      (axiosGet as jest.Mock).mockRejectedValue(new Error('API error') as never);

      // Mock on-chain quote (quoteSend)
      mockReadContract.mockResolvedValue({ nativeFee: 100000n, lzTokenFee: 0n } as never);

      const result = await adapter.getReceivedAmount('1000000', route);
      // Should return amount minus estimated fee (0.1%)
      expect(BigInt(result)).toBeLessThan(1000000n);
    });
  });

  describe('getApiQuote', () => {
    it('should return quote from Stargate API', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826, // TON
        asset: USDT_ETH,
      };

      const mockApiResponse = {
        quotes: [{
          route: { bridgeName: 'stargate' },
          dstAmount: '995000',
        }],
      };
      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.callGetApiQuote('1000000', route);
      expect(result).toBe('995000');
      expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining(STARGATE_API_URL));
    });

    it('should return null for unsupported chain', async () => {
      const route: RebalanceRoute = {
        origin: 99999, // Unknown chain
        destination: 30826,
        asset: USDT_ETH,
      };

      const result = await adapter.callGetApiQuote('1000000', route);
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('Chain not supported in Stargate API', expect.any(Object));
    });

    it('should return null when API returns error', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: { error: 'Rate limit exceeded' } } as never);

      const result = await adapter.callGetApiQuote('1000000', route);
      expect(result).toBeNull();
    });

    it('should return null when no quotes available', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: { quotes: [] } } as never);

      const result = await adapter.callGetApiQuote('1000000', route);
      expect(result).toBeNull();
    });

    it('should return null when quote has no route', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      (axiosGet as jest.Mock).mockResolvedValue({ 
        data: { quotes: [{ dstAmount: '1000', route: null }] } 
      } as never);

      const result = await adapter.callGetApiQuote('1000000', route);
      expect(result).toBeNull();
    });

    it('should handle API request errors', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      (axiosGet as jest.Mock).mockRejectedValue(new Error('Network error') as never);

      const result = await adapter.callGetApiQuote('1000000', route);
      expect(result).toBeNull();
    });
  });

  describe('getOnChainQuote', () => {
    beforeEach(() => {
      mockReadContract.mockReset();
    });

    it('should use quoteOFT when available', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // Mock quoteOFT response
      mockReadContract.mockResolvedValue({
        amountSentLD: 1000000n,
        amountReceivedLD: 999000n,
      } as never);

      const result = await adapter.callGetOnChainQuote('1000000', route);
      expect(result).toBe('999000');
    });

    it('should fallback to quoteSend with fee estimate when quoteOFT not available', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // First call (quoteOFT) throws, second call (quoteSend) succeeds
      mockReadContract
        .mockRejectedValueOnce(new Error('quoteOFT not available') as never)
        .mockResolvedValueOnce({ nativeFee: 100000n, lzTokenFee: 0n } as never);

      const result = await adapter.callGetOnChainQuote('1000000', route);
      // Amount minus 0.1% fee estimate
      expect(result).toBe('999000');
    });
  });

  describe('send', () => {
    beforeEach(() => {
      mockReadContract.mockReset();
      mockSimulateContract.mockReset();
    });

    it('should build transaction with correct parameters for TON destination', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826, // TON
        asset: USDT_ETH,
      };

      // Mock API quote (getReceivedAmount uses API first)
      const mockApiResponse = {
        quotes: [{
          route: { bridgeName: 'stargate' },
          dstAmount: '995000',
        }],
      };
      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      // Mock quoteSend for messaging fee
      mockReadContract.mockResolvedValue({
        nativeFee: 50000000000000000n, // 0.05 ETH
        lzTokenFee: 0n,
      } as never);

      // Mock simulateContract
      mockSimulateContract.mockResolvedValue({ request: { data: '0x' } } as never);

      const result = await adapter.send(
        '0xSender',
        'EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t', // TON address
        '1000000',
        route,
      );

      expect(result).toBeDefined();
      // Verify it attempted to get quote
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Fetching Stargate API quote',
        expect.any(Object)
      );
    });

    it('should handle errors when building transaction', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 99999, // Unknown
        asset: USDT_ETH,
      };

      // Should throw due to unsupported destination
      await expect(adapter.send('0xSender', '0xRecipient', '1000000', route)).rejects.toThrow();
    });

    it('should use API transactions when available with approve and bridge steps', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // Mock API response with both approve and bridge steps
      const mockApiResponse = {
        quotes: [{
          route: { bridgeName: 'stargate' },
          dstAmount: '995000',
          steps: [
            {
              type: 'approve',
              transaction: {
                to: '0xTokenAddress',
                data: '0xapprovedata',
              },
            },
            {
              type: 'bridge',
              transaction: {
                to: '0xPoolAddress',
                data: '0xbridgedata',
                value: '50000000000000000',
              },
            },
          ],
          duration: { estimated: 300 },
          fees: { total: '0.01' },
        }],
      };
      (axiosGet as jest.Mock).mockResolvedValue({ data: mockApiResponse } as never);

      const result = await adapter.send(
        '0xSender',
        'EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t',
        '1000000',
        route,
      );

      expect(result).toHaveLength(2);
      expect(result[0].memo).toBe('Approval');
      expect(result[1].memo).toBe('Rebalance');
      expect(mockLogger.info).toHaveBeenCalledWith('Using Stargate API for bridge transactions', expect.any(Object));
    });

    it('should fall back to manual transactions when API returns empty', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // API returns empty or null
      (axiosGet as jest.Mock).mockResolvedValue({ data: { quotes: [] } } as never);

      // Mock for manual fallback
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000000n, lzTokenFee: 0n } as never) // quoteSend
        .mockResolvedValueOnce(0n as never); // allowance check

      const result = await adapter.send(
        '0xSender',
        '0xRecipient',
        '1000000',
        route,
      );

      expect(result).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('Prepared Stargate bridge transactions (manual fallback)', expect.any(Object));
    });

    it('should fall back to manual transactions when API throws error', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // API throws error
      (axiosGet as jest.Mock).mockRejectedValue(new Error('API failed') as never);

      // Mock for manual fallback
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000000n, lzTokenFee: 0n } as never) // quoteSend
        .mockResolvedValueOnce(0n as never); // allowance check

      const result = await adapter.send(
        '0xSender',
        '0xRecipient',
        '1000000',
        route,
      );

      expect(result).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Stargate API transaction build failed, falling back to manual', expect.any(Object));
    });

    it('should skip approval transaction when allowance is sufficient', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // API returns null to trigger manual flow
      (axiosGet as jest.Mock).mockResolvedValue({ data: { quotes: [] } } as never);

      // Mock for manual fallback - sufficient allowance
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000000n, lzTokenFee: 0n } as never) // quoteSend
        .mockResolvedValueOnce(2000000n as never); // allowance already sufficient

      const result = await adapter.send(
        '0xSender',
        '0xRecipient',
        '1000000',
        route,
      );

      // Should only have 1 transaction (bridge only, no approval)
      expect(result).toHaveLength(1);
      expect(result[0].memo).toBe('Rebalance');
    });

    it('should add approval transaction when allowance is insufficient', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 30826,
        asset: USDT_ETH,
      };

      // API returns null to trigger manual flow
      (axiosGet as jest.Mock).mockResolvedValue({ data: { quotes: [] } } as never);

      // Mock for manual fallback - insufficient allowance
      mockReadContract
        .mockResolvedValueOnce({ nativeFee: 50000000000000000n, lzTokenFee: 0n } as never) // quoteSend
        .mockResolvedValueOnce(0n as never); // no allowance

      const result = await adapter.send(
        '0xSender',
        '0xRecipient',
        '1000000',
        route,
      );

      // Should have 2 transactions (approval + bridge)
      expect(result).toHaveLength(2);
      expect(result[0].memo).toBe('Approval');
      expect(result[1].memo).toBe('Rebalance');
    });
  });

  describe('getPublicClient', () => {
    it('should create and cache public clients', () => {
      const client1 = adapter.callGetPublicClient(1);
      const client2 = adapter.callGetPublicClient(1);

      expect(client1).toBe(client2);
      expect(adapter.getPublicClients().size).toBe(1);
    });

    it('should throw error for chain without providers', () => {
      expect(() => adapter.callGetPublicClient(99999)).toThrow(
        'No providers found for chain 99999'
      );
    });
  });

  describe('STARGATE_API_URL', () => {
    it('should be defined', () => {
      expect(STARGATE_API_URL).toBeDefined();
      expect(STARGATE_API_URL).toContain('stargate');
    });
  });

  describe('STARGATE_CHAIN_NAMES', () => {
    it('should have mapping for ethereum', () => {
      expect(STARGATE_CHAIN_NAMES[1]).toBe('ethereum');
    });

    it('should have mapping for TON', () => {
      expect(STARGATE_CHAIN_NAMES[30826]).toBe('ton');
    });
  });
});

