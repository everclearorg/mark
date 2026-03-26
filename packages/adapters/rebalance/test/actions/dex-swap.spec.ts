/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ChainConfiguration, PostBridgeActionType, DexSwapActionConfig } from '@mark/core';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../src/types';

// Mock viem functions — use a module-level variable referenced inside jest.mock factory
const mockReadContract = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem') as any;
  return {
    ...actual,
    createPublicClient: jest.fn(() => ({
      readContract: (...args: any[]) => mockReadContract(...args),
    })),
  };
});

jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core') as any;
  return {
    ...actual,
    axiosPost: (...args: any[]) => (axiosPostMock as any)(...args),
  };
});

jest.mock('@mark/logger');

// This must be declared after the jest.mock calls
let axiosPostMock: jest.Mock;

import { DexSwapActionHandler } from '../../src/actions/dex-swap';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

describe('DexSwapActionHandler', () => {
  let handler: DexSwapActionHandler;
  const mockChains: Record<string, ChainConfiguration> = {
    '5000': {
      providers: ['http://mantle-rpc'],
      assets: [],
      invoiceAge: 3600,
      gasThreshold: '0',
      deployments: { everclear: '0x', permit2: '0x', multicall3: '0x' },
    },
  };

  const mockConfig: DexSwapActionConfig = {
    type: PostBridgeActionType.DexSwap,
    sellToken: '0x1111111111111111111111111111111111111111',
    buyToken: '0x2222222222222222222222222222222222222222',
    slippageBps: 100,
  };

  const mockSender = '0x3333333333333333333333333333333333333333';
  const mockAmount = '1000000'; // 1 USDT (6 decimals)
  const mockDestinationChainId = 5000;

  const mockSwapRouter = '0x4444444444444444444444444444444444444444';
  const mockQuoteResponse = {
    data: {
      success: true,
      data: {
        quotes: [
          {
            provider: 'odos',
            order: { priceRank: 1 },
            estOutput: { raw: '1000000000000000000', units: '1.0' },
            txs: [
              {
                action: 'Swap' as const,
                to: mockSwapRouter,
                data: '0xswapdata',
                value: '0',
              },
            ],
          },
        ],
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    axiosPostMock = jest.fn();
    handler = new DexSwapActionHandler(mockChains, mockLogger, 'https://quotes.api.everclear.org');
  });

  it('should build approval + swap transactions (happy path)', async () => {
    // Balance > requested amount
    mockReadContract
      .mockResolvedValueOnce(BigInt(2000000) as never) // balanceOf
      .mockResolvedValueOnce(BigInt(0) as never); // allowance (insufficient)

    axiosPostMock.mockResolvedValueOnce(mockQuoteResponse as never);

    const txs = await handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig);

    expect(txs).toHaveLength(2);

    // First tx: approval
    expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
    expect(txs[0].transaction.to).toBe('0x1111111111111111111111111111111111111111');

    // Second tx: swap
    expect(txs[1].memo).toBe(RebalanceTransactionMemo.DexSwap);
    expect(txs[1].transaction.to).toBe(mockSwapRouter);
    expect(txs[1].transaction.data).toBe('0xswapdata');
    expect(txs[1].effectiveAmount).toBe('1000000000000000000');

    // Verify quote-service was called correctly
    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://quotes.api.everclear.org/quote',
      expect.objectContaining({
        sellToken: '0x1111111111111111111111111111111111111111',
        buyToken: '0x2222222222222222222222222222222222222222',
        amount: mockAmount,
        sender: '0x3333333333333333333333333333333333333333',
        receiver: '0x3333333333333333333333333333333333333333',
        destinationChain: mockDestinationChainId,
        slippageBps: 100,
        options: ['excludeApproves'],
      }),
    );
  });

  it('should skip approval when allowance is sufficient', async () => {
    // Balance sufficient
    mockReadContract
      .mockResolvedValueOnce(BigInt(2000000) as never) // balanceOf
      .mockResolvedValueOnce(BigInt(2000000) as never); // allowance (sufficient)

    axiosPostMock.mockResolvedValueOnce(mockQuoteResponse as never);

    const txs = await handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig);

    expect(txs).toHaveLength(1);
    expect(txs[0].memo).toBe(RebalanceTransactionMemo.DexSwap);
    expect(txs[0].effectiveAmount).toBe('1000000000000000000');
  });

  it('should return empty array when balance is zero', async () => {
    mockReadContract.mockResolvedValueOnce(BigInt(0) as never); // balanceOf = 0

    const txs = await handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig);

    expect(txs).toHaveLength(0);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('should use min(balance, amount) as swap amount', async () => {
    // Balance less than requested amount
    mockReadContract
      .mockResolvedValueOnce(BigInt(500000) as never) // balanceOf = 0.5 USDT
      .mockResolvedValueOnce(BigInt(0) as never); // allowance

    axiosPostMock.mockResolvedValueOnce(mockQuoteResponse as never);

    await handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig);

    // Should have used balance (500000) not amount (1000000)
    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        amount: '500000',
      }),
    );
  });

  it('should throw when quote-service returns no quotes', async () => {
    mockReadContract
      .mockResolvedValueOnce(BigInt(1000000) as never) // balanceOf

    axiosPostMock.mockResolvedValueOnce({
      data: {
        success: true,
        data: { quotes: [] },
      },
    } as never);

    await expect(
      handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig),
    ).rejects.toThrow('quote-service returned no quotes');
  });

  it('should throw when quote-service returns error', async () => {
    mockReadContract
      .mockResolvedValueOnce(BigInt(1000000) as never) // balanceOf

    axiosPostMock.mockResolvedValueOnce({
      data: {
        success: false,
        error: 'Service unavailable',
      },
    } as never);

    await expect(
      handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig),
    ).rejects.toThrow('quote-service returned no quotes');
  });

  it('should throw when best quote has no Swap transaction', async () => {
    mockReadContract
      .mockResolvedValueOnce(BigInt(1000000) as never) // balanceOf

    axiosPostMock.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          quotes: [
            {
              provider: 'odos',
              order: { priceRank: 1 },
              estOutput: { raw: '1000000000000000000', units: '1.0' },
              txs: [
                { action: 'Approve', to: '0x', data: '0x', value: '0' },
              ],
            },
          ],
        },
      },
    } as never);

    await expect(
      handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig),
    ).rejects.toThrow('has no Swap transaction');
  });

  it('should set effectiveAmount to estOutput.raw from best quote', async () => {
    const customEstOutput = '9999999999999999999';
    mockReadContract
      .mockResolvedValueOnce(BigInt(1000000) as never) // balanceOf
      .mockResolvedValueOnce(BigInt(1010000) as never); // allowance (sufficient including slippage padding)

    axiosPostMock.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          quotes: [
            {
              provider: 'kyberswap',
              order: { priceRank: 1 },
              estOutput: { raw: customEstOutput, units: '9.999' },
              txs: [
                { action: 'Swap', to: '0x5555555555555555555555555555555555555555', data: '0xdata', value: '0' },
              ],
            },
          ],
        },
      },
    } as never);

    const txs = await handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig);

    expect(txs).toHaveLength(1);
    expect(txs[0].effectiveAmount).toBe(customEstOutput);
  });

  it('should throw for wrong action type', async () => {
    const wrongConfig = {
      type: PostBridgeActionType.AaveSupply,
      poolAddress: '0x',
      supplyAsset: '0x',
    } as any;

    await expect(
      handler.buildTransactions(mockSender, mockAmount, mockDestinationChainId, wrongConfig),
    ).rejects.toThrow('unexpected action type');
  });

  it('should throw when no providers for destination chain', async () => {
    const handlerNoProviders = new DexSwapActionHandler(
      { '5000': { ...mockChains['5000'], providers: [] } },
      mockLogger,
      'https://quotes.api.everclear.org',
    );

    await expect(
      handlerNoProviders.buildTransactions(mockSender, mockAmount, mockDestinationChainId, mockConfig),
    ).rejects.toThrow('No providers found');
  });
});
