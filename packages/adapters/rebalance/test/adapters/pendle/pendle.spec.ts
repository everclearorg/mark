import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PendleBridgeAdapter } from '../../../src/adapters/pendle/pendle';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../../src/types';
import { USDC_PTUSDE_PAIRS, PENDLE_SUPPORTED_CHAINS } from '../../../src/adapters/pendle/types';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockChains = {
  '1': {
    providers: ['https://mock-eth-rpc'],
    assets: [],
    invoiceAge: 0,
    gasThreshold: '0',
    deployments: {
      everclear: '0x0000000000000000000000000000000000000001',
      permit2: '0x0000000000000000000000000000000000000002',
      multicall3: '0x0000000000000000000000000000000000000003',
    },
  },
};

const sender = '0x' + '1'.repeat(40);
const recipient = '0x' + '2'.repeat(40);
const amount = '1000000000'; // 1000 USDC (6 decimals)
const usdcAddress = USDC_PTUSDE_PAIRS[1].usdc;
const ptUsdeAddress = USDC_PTUSDE_PAIRS[1].ptUSDe;

// Same-chain swap route (USDC → ptUSDe on mainnet)
const usdcToPtUsdeRoute = { 
  asset: usdcAddress, 
  origin: 1, 
  destination: 1,
  swapOutputAsset: ptUsdeAddress,
};

// Reverse route (ptUSDe → USDC on mainnet)
const ptUsdeToUsdcRoute = { 
  asset: ptUsdeAddress, 
  origin: 1, 
  destination: 1,
  swapOutputAsset: usdcAddress,
};

// Cross-chain route (should fail)
const crossChainRoute = { 
  asset: usdcAddress, 
  origin: 1, 
  destination: 42161, // Arbitrum
};

const mockReceipt = {
  blockHash: '0xblock',
  blockNumber: 1n,
  contractAddress: null,
  cumulativeGasUsed: 0n,
  effectiveGasPrice: 0n,
  from: sender,
  gasUsed: 0n,
  logs: [],
  logsBloom: '0x' + '0'.repeat(512),
  status: 'success',
  to: recipient,
  transactionHash: '0xhash',
  transactionIndex: 0,
  type: 'eip1559',
} as any;

// Mock Pendle API response
const mockPendleQuoteResponse = {
  routes: [
    {
      outputs: [{ amount: '990000000000000000000' }], // ~990 ptUSDe (18 decimals)
      data: {
        priceImpact: '0.001',
        swapFee: '0.003',
      },
      tx: {
        to: '0xPendleRouter',
        data: '0xswapdata',
        value: '0',
      },
    },
  ],
};

// Mock fetch globally with proper typing
const mockFetch = jest.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
global.fetch = mockFetch as unknown as typeof fetch;

// Mock viem
jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return Object.assign({}, actual, {
    createPublicClient: () => ({
      readContract: jest.fn<() => Promise<bigint>>().mockResolvedValue(0n), // No allowance
    }),
    encodeFunctionData: jest.fn(() => '0xapprovaldata'),
    http: jest.fn(() => ({})),
    fallback: jest.fn(() => ({})),
  });
});

describe('PendleBridgeAdapter', () => {
  let adapter: PendleBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => mockPendleQuoteResponse,
    } as Response);
    adapter = new PendleBridgeAdapter(mockChains, mockLogger);
  });

  describe('constructor and type', () => {
    it('constructs and returns correct type', () => {
      expect(adapter.type()).toBe('pendle');
    });
  });

  describe('getMinimumAmount', () => {
    it('returns null (no fixed minimum)', async () => {
      expect(await adapter.getMinimumAmount(usdcToPtUsdeRoute)).toBeNull();
    });
  });

  describe('validateSameChainSwap', () => {
    it('throws for cross-chain routes', async () => {
      await expect(adapter.getReceivedAmount(amount, crossChainRoute)).rejects.toThrow(
        'Pendle adapter only supports same-chain swaps'
      );
    });

    it('throws for unsupported chain', async () => {
      const unsupportedRoute = { asset: usdcAddress, origin: 999, destination: 999 };
      await expect(adapter.getReceivedAmount(amount, unsupportedRoute)).rejects.toThrow(
        'Chain 999 is not supported by Pendle SDK'
      );
    });

    it('throws for unsupported asset', async () => {
      const invalidAssetRoute = { 
        asset: '0xinvalidasset', 
        origin: 1, 
        destination: 1 
      };
      await expect(adapter.getReceivedAmount(amount, invalidAssetRoute)).rejects.toThrow(
        'Pendle adapter only supports USDC/ptUSDe swaps'
      );
    });

    it('passes for valid USDC → ptUSDe route', async () => {
      const result = await adapter.getReceivedAmount(amount, usdcToPtUsdeRoute);
      expect(result).toBe('990000000000000000000');
    });
  });

  describe('swap direction detection', () => {
    it('determines USDC → ptUSDe direction correctly', async () => {
      await adapter.getReceivedAmount(amount, usdcToPtUsdeRoute);
      
      // Verify fetch was called with correct tokensIn/tokensOut
      expect(mockFetch).toHaveBeenCalled();
      const fetchCall = String(mockFetch.mock.calls[0]?.[0] ?? '');
      expect(fetchCall).toContain(`tokensIn=${usdcAddress}`);
      expect(fetchCall).toContain(`tokensOut=${ptUsdeAddress}`);
    });

    it('determines ptUSDe → USDC direction correctly', async () => {
      await adapter.getReceivedAmount(amount, ptUsdeToUsdcRoute);
      
      const fetchCall = String(mockFetch.mock.calls[0]?.[0] ?? '');
      expect(fetchCall).toContain(`tokensIn=${ptUsdeAddress}`);
      expect(fetchCall).toContain(`tokensOut=${usdcAddress}`);
    });
  });

  describe('getReceivedAmount', () => {
    it('calls Pendle API with correct parameters', async () => {
      await adapter.getReceivedAmount(amount, usdcToPtUsdeRoute);
      
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchCall = String(mockFetch.mock.calls[0]?.[0] ?? '');
      expect(fetchCall).toContain('https://api-v2.pendle.finance/core/v2/sdk/1/convert');
      expect(fetchCall).toContain(`amountsIn=${amount}`);
      expect(fetchCall).toContain('slippage=0.005');
      expect(fetchCall).toContain('enableAggregator=true');
      expect(fetchCall).toContain('aggregators=kyberswap');
    });

    it('returns amount from best route', async () => {
      const result = await adapter.getReceivedAmount(amount, usdcToPtUsdeRoute);
      expect(result).toBe('990000000000000000000');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(adapter.getReceivedAmount(amount, usdcToPtUsdeRoute)).rejects.toThrow(
        'Pendle API request failed: 500 Internal Server Error'
      );
    });

    it('throws on empty routes response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ routes: [] }),
      } as Response);

      await expect(adapter.getReceivedAmount(amount, usdcToPtUsdeRoute)).rejects.toThrow(
        'Invalid quote response from Pendle API'
      );
    });
  });

  describe('send', () => {
    it('returns approval and swap transactions', async () => {
      const txs = await adapter.send(sender, recipient, amount, usdcToPtUsdeRoute);
      
      expect(txs.length).toBe(2); // Approval + Swap
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
    });

    it('swap transaction has correct target from API response', async () => {
      const txs = await adapter.send(sender, recipient, amount, usdcToPtUsdeRoute);
      
      const swapTx = txs.find(tx => tx.memo === RebalanceTransactionMemo.Rebalance);
      expect(swapTx?.transaction.to).toBe('0xPendleRouter');
      expect(swapTx?.transaction.data).toBe('0xswapdata');
    });

    it('includes effectiveAmount from API response', async () => {
      const txs = await adapter.send(sender, recipient, amount, usdcToPtUsdeRoute);
      
      const swapTx = txs.find(tx => tx.memo === RebalanceTransactionMemo.Rebalance);
      expect(swapTx?.effectiveAmount).toBe('990000000000000000000');
    });

    it('approval targets the token contract', async () => {
      const txs = await adapter.send(sender, recipient, amount, usdcToPtUsdeRoute);
      
      const approvalTx = txs.find(tx => tx.memo === RebalanceTransactionMemo.Approval);
      expect(approvalTx?.transaction.to).toBe(usdcAddress);
    });
  });

  describe('readyOnDestination', () => {
    it('returns true if transaction is successful (same-chain swap)', async () => {
      const ready = await adapter.readyOnDestination(amount, usdcToPtUsdeRoute, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false if transaction failed', async () => {
      const failedReceipt = { ...mockReceipt, status: 'reverted' };
      const ready = await adapter.readyOnDestination(amount, usdcToPtUsdeRoute, failedReceipt);
      expect(ready).toBe(false);
    });

    it('returns false if receipt is null', async () => {
      const ready = await adapter.readyOnDestination(amount, usdcToPtUsdeRoute, null as any);
      expect(ready).toBe(false);
    });
  });

  describe('destinationCallback', () => {
    it('returns void (same-chain swap, no callback needed)', async () => {
      const result = await adapter.destinationCallback(usdcToPtUsdeRoute, mockReceipt);
      expect(result).toBeUndefined();
    });
  });

  describe('Pendle constants', () => {
    it('has USDC/ptUSDe pair for mainnet', () => {
      expect(USDC_PTUSDE_PAIRS[1]).toBeDefined();
      expect(USDC_PTUSDE_PAIRS[1].usdc).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      expect(USDC_PTUSDE_PAIRS[1].ptUSDe).toBe('0xE8483517077afa11A9B07f849cee2552f040d7b2');
    });

    it('has mainnet in supported chains', () => {
      expect(PENDLE_SUPPORTED_CHAINS[1]).toBe('mainnet');
    });
  });
});

