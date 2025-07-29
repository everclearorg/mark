/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { TransactionReceipt, zeroAddress, parseEventLogs } from 'viem';
import {
  waitUntilQuoteExecutionCompletes,
  getQuote,
  getSupportedTokens,
  getDepositFromLogs,
  parseDepositLogs,
} from '../../../src/adapters/near/utils';
import {
  GetExecutionStatusResponse,
  OneClickService,
  Quote,
  QuoteRequest,
  TokenResponse,
  QuoteResponse,
} from '@defuse-protocol/one-click-sdk-typescript';

// Mock the external dependencies
jest.mock('@defuse-protocol/one-click-sdk-typescript');
jest.mock('viem');

// Make the mock available in the module
jest.mock('@defuse-protocol/one-click-sdk-typescript', () => {
  // Define MockApiError inside the factory function
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public data: any,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }

  return {
    ApiError,
    OneClickService: {
      getQuote: jest.fn(),
      getExecutionStatus: jest.fn(),
      getTokens: jest.fn(),
    },
    GetExecutionStatusResponse: {
      status: {
        SUCCESS: 'SUCCESS',
        PENDING_DEPOSIT: 'PENDING_DEPOSIT',
        PROCESSING: 'PROCESSING',
        FAILED: 'FAILED',
        REFUNDED: 'REFUNDED',
        KNOWN_DEPOSIT_TX: 'KNOWN_DEPOSIT_TX',
        INCOMPLETE_DEPOSIT: 'INCOMPLETE_DEPOSIT',
      },
    },
    TokenResponse: {
      blockchain: {
        NEAR: 'near',
        ETH: 'eth',
        BASE: 'base',
        ARB: 'arb',
        BTC: 'btc',
        SOL: 'sol',
      },
    },
    QuoteRequest: {
      swapType: {
        EXACT_INPUT: 'EXACT_INPUT',
      },
      depositType: {
        ORIGIN_CHAIN: 'ORIGIN_CHAIN',
      },
      refundType: {
        ORIGIN_CHAIN: 'ORIGIN_CHAIN',
      },
      recipientType: {
        DESTINATION_CHAIN: 'DESTINATION_CHAIN',
      },
    },
  };
});

const mockParseEventLogs = parseEventLogs as jest.MockedFunction<typeof parseEventLogs>;

describe('Near Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('waitUntilQuoteExecutionCompletes', () => {
    it('should complete successfully when quote execution is successful', async () => {
      const mockQuote: Quote = {
        depositAddress: '0x1234567890123456789012345678901234567890',
        amountIn: '1000000000000000000',
        amountOut: '50000000',
        amountInFormatted: '1.0',
        amountOutFormatted: '50.0',
        amountInUsd: '1000.0',
        amountOutUsd: '1000.0',
        minAmountIn: '990000000000000000',
        minAmountOut: '49500000',
        timeEstimate: 60,
      };

      const mockGetExecutionStatus = OneClickService.getExecutionStatus as jest.MockedFunction<
        typeof OneClickService.getExecutionStatus
      >;
      mockGetExecutionStatus.mockResolvedValueOnce({
        status: GetExecutionStatusResponse.status.SUCCESS,
        quoteResponse: {} as QuoteResponse,
        updatedAt: new Date().toISOString(),
        swapDetails: {},
      } as GetExecutionStatusResponse);

      await expect(waitUntilQuoteExecutionCompletes(mockQuote)).resolves.toBeUndefined();
      expect(mockGetExecutionStatus).toHaveBeenCalledWith(mockQuote.depositAddress);
    });

    it('should throw error when quote is missing depositAddress', async () => {
      const mockQuote: Quote = {
        amountIn: '1000000000000000000',
        amountOut: '50000000',
        amountInFormatted: '1.0',
        amountOutFormatted: '50.0',
        amountInUsd: '1000.0',
        amountOutUsd: '1000.0',
        minAmountIn: '990000000000000000',
        minAmountOut: '49500000',
        timeEstimate: 60,
      } as Quote;

      await expect(waitUntilQuoteExecutionCompletes(mockQuote)).rejects.toThrow(
        "Missing required field 'depositAddress'",
      );
    });

    it('should retry and eventually succeed', async () => {
      const mockQuote: Quote = {
        depositAddress: '0x1234567890123456789012345678901234567890',
      } as Quote;

      const mockGetExecutionStatus = OneClickService.getExecutionStatus as jest.MockedFunction<
        typeof OneClickService.getExecutionStatus
      >;
      mockGetExecutionStatus
        .mockResolvedValueOnce({
          status: GetExecutionStatusResponse.status.PENDING_DEPOSIT,
          quoteResponse: {} as QuoteResponse,
          updatedAt: new Date().toISOString(),
          swapDetails: {},
        } as GetExecutionStatusResponse)
        .mockResolvedValueOnce({
          status: GetExecutionStatusResponse.status.PROCESSING,
          quoteResponse: {} as QuoteResponse,
          updatedAt: new Date().toISOString(),
          swapDetails: {},
        } as GetExecutionStatusResponse)
        .mockResolvedValueOnce({
          status: GetExecutionStatusResponse.status.SUCCESS,
          quoteResponse: {} as QuoteResponse,
          updatedAt: new Date().toISOString(),
          swapDetails: {},
        } as GetExecutionStatusResponse);

      // Mock setTimeout to run immediately
      jest.useFakeTimers();
      const promise = waitUntilQuoteExecutionCompletes(mockQuote);

      // Fast-forward through all timeouts
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toBeUndefined();
      expect(mockGetExecutionStatus).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });

    it('should handle API errors gracefully', async () => {
      const mockQuote: Quote = {
        depositAddress: '0x1234567890123456789012345678901234567890',
      } as Quote;

      const mockGetExecutionStatus = OneClickService.getExecutionStatus as jest.MockedFunction<
        typeof OneClickService.getExecutionStatus
      >;

      const apiError = Object.assign(new Error('Internal Server Error'), {
        status: 500,
        data: null,
        name: 'ApiError',
      });
      mockGetExecutionStatus.mockRejectedValueOnce(apiError).mockResolvedValueOnce({
        status: GetExecutionStatusResponse.status.SUCCESS,
        quoteResponse: {} as QuoteResponse,
        updatedAt: new Date().toISOString(),
        swapDetails: {},
      } as GetExecutionStatusResponse);

      jest.useFakeTimers();
      const promise = waitUntilQuoteExecutionCompletes(mockQuote);
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to query execution status'));

      jest.useRealTimers();
    });

    it('should throw error after timeout', async () => {
      const mockQuote: Quote = {
        depositAddress: '0x1234567890123456789012345678901234567890',
      } as Quote;

      const mockGetExecutionStatus = OneClickService.getExecutionStatus as jest.MockedFunction<
        typeof OneClickService.getExecutionStatus
      >;

      // Mock to always return pending status
      mockGetExecutionStatus.mockResolvedValue({
        status: GetExecutionStatusResponse.status.PENDING_DEPOSIT,
        quoteResponse: {} as QuoteResponse,
        updatedAt: new Date().toISOString(),
        swapDetails: {},
      } as GetExecutionStatusResponse);

      // The timeout is 20 attempts * 3 seconds = 60 seconds
      // But since we're waiting for real timers, let's mock setTimeout to speed it up
      jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
        callback();
        return {} as NodeJS.Timeout;
      });

      await expect(waitUntilQuoteExecutionCompletes(mockQuote)).rejects.toThrow(
        "Quote hasn't been settled after 60 seconds",
      );
      expect(mockGetExecutionStatus).toHaveBeenCalledTimes(20);
    });
  });

  describe('getQuote', () => {
    it('should successfully get a quote', async () => {
      const mockRequest: QuoteRequest = {
        dry: false,
        swapType: QuoteRequest.swapType.EXACT_INPUT,
        slippageTolerance: 100,
        originAsset: 'WETH',
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: 'ETH',
        amount: '1000000000000000000',
        refundTo: '0x1234567890123456789012345678901234567890',
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: '0x1234567890123456789012345678901234567890',
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline: new Date(Date.now() + 3600000).toISOString(),
      };

      const mockQuote: Quote = {
        depositAddress: '0x1234567890123456789012345678901234567890',
        amountIn: '1000000000000000000',
        amountOut: '50000000',
        amountInFormatted: '1.0',
        amountOutFormatted: '50.0',
        amountInUsd: '1000.0',
        amountOutUsd: '1000.0',
        minAmountIn: '990000000000000000',
        minAmountOut: '49500000',
        timeEstimate: 60,
      };

      const mockGetQuote = OneClickService.getQuote as jest.MockedFunction<typeof OneClickService.getQuote>;
      mockGetQuote.mockResolvedValueOnce({
        quote: mockQuote,
        timestamp: new Date().toISOString(),
        signature: 'signature',
        quoteRequest: mockRequest,
      } as QuoteResponse);

      const result = await getQuote(mockRequest);
      expect(result).toEqual(mockQuote);
      expect(mockGetQuote).toHaveBeenCalledWith(mockRequest);
    });

    it('should throw error when no quote is received', async () => {
      const mockRequest: QuoteRequest = {} as QuoteRequest;

      const mockGetQuote = OneClickService.getQuote as jest.MockedFunction<typeof OneClickService.getQuote>;
      mockGetQuote.mockResolvedValueOnce({
        quote: undefined,
        timestamp: new Date().toISOString(),
        signature: 'signature',
        quoteRequest: mockRequest,
      } as any);

      await expect(getQuote(mockRequest)).rejects.toThrow('No quote received!');
    });

    it('should throw error when quote is missing depositAddress', async () => {
      const mockRequest: QuoteRequest = {} as QuoteRequest;
      const mockQuote: Quote = {
        amountIn: '1000000000000000000',
        amountOut: '50000000',
      } as Quote;

      const mockGetQuote = OneClickService.getQuote as jest.MockedFunction<typeof OneClickService.getQuote>;
      mockGetQuote.mockResolvedValueOnce({
        quote: mockQuote,
        timestamp: new Date().toISOString(),
        signature: 'signature',
        quoteRequest: mockRequest,
      } as QuoteResponse);

      await expect(getQuote(mockRequest)).rejects.toThrow(
        "Quote missing 'depositAddress' field. If this wasn't intended, ensure the 'dry' parameter is set to false when requesting a quote.",
      );
    });

    it('should handle API errors', async () => {
      const mockRequest: QuoteRequest = {} as QuoteRequest;
      const apiError = Object.assign(new Error('Bad Request'), {
        status: 400,
        data: null,
        name: 'ApiError',
      });

      const mockGetQuote = OneClickService.getQuote as jest.MockedFunction<typeof OneClickService.getQuote>;
      mockGetQuote.mockRejectedValueOnce(apiError);

      await expect(getQuote(mockRequest)).rejects.toThrow('No quote received!');
      expect(console.error).toHaveBeenCalledWith('Failed to get a quote: Bad Request');
    });

    it('should handle generic errors', async () => {
      const mockRequest: QuoteRequest = {} as QuoteRequest;
      const error = new Error('Network error');

      const mockGetQuote = OneClickService.getQuote as jest.MockedFunction<typeof OneClickService.getQuote>;
      mockGetQuote.mockRejectedValueOnce(error);

      await expect(getQuote(mockRequest)).rejects.toThrow('No quote received!');
      expect(console.error).toHaveBeenCalledWith('Failed to get a quote: Network error');
    });

    it('should handle unknown errors', async () => {
      const mockRequest: QuoteRequest = {} as QuoteRequest;
      const error = { some: 'object' };

      const mockGetQuote = OneClickService.getQuote as jest.MockedFunction<typeof OneClickService.getQuote>;
      mockGetQuote.mockRejectedValueOnce(error);

      await expect(getQuote(mockRequest)).rejects.toThrow('No quote received!');
      expect(console.error).toHaveBeenCalledWith('Failed to get a quote: {"some":"object"}');
    });
  });

  describe('getSupportedTokens', () => {
    it('should successfully get supported tokens', async () => {
      const mockTokens: TokenResponse[] = [
        {
          assetId: 'eth-eth',
          symbol: 'ETH',
          decimals: 18,
          blockchain: TokenResponse.blockchain.ETH,
          price: 2000.0,
          priceUpdatedAt: new Date().toISOString(),
          contractAddress: '0x0000000000000000000000000000000000000000',
        },
        {
          assetId: 'eth-usdc',
          symbol: 'USDC',
          decimals: 6,
          blockchain: TokenResponse.blockchain.ETH,
          price: 1.0,
          priceUpdatedAt: new Date().toISOString(),
          contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        },
      ];

      const mockGetTokens = OneClickService.getTokens as jest.MockedFunction<typeof OneClickService.getTokens>;
      mockGetTokens.mockResolvedValueOnce(mockTokens);

      const result = await getSupportedTokens();
      expect(result).toEqual(mockTokens);
      expect(mockGetTokens).toHaveBeenCalled();
    });

    it('should throw error when no tokens are found', async () => {
      const mockGetTokens = OneClickService.getTokens as jest.MockedFunction<typeof OneClickService.getTokens>;
      mockGetTokens.mockResolvedValueOnce([]);

      await expect(getSupportedTokens()).rejects.toThrow('No tokens found!');
    });

    it('should handle API errors', async () => {
      const apiError = Object.assign(new Error('Internal Server Error'), {
        status: 500,
        data: null,
        name: 'ApiError',
      });

      const mockGetTokens = OneClickService.getTokens as jest.MockedFunction<typeof OneClickService.getTokens>;
      mockGetTokens.mockRejectedValueOnce(apiError);

      await expect(getSupportedTokens()).rejects.toThrow('No tokens found!');
      expect(console.error).toHaveBeenCalledWith('Failed to get supported tokens: Internal Server Error');
    });
  });

  describe('getDepositFromLogs', () => {
    it('should successfully extract deposit from logs with ERC20 transfer', () => {
      const mockLog = {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        blockHash: '0xblock123',
        blockNumber: 12345678n,
        data: '0x',
        logIndex: 0,
        removed: false,
        topics: [],
        transactionHash: '0xabc123' as `0x${string}`,
        transactionIndex: 0,
      };

      const mockReceipt = {
        transactionHash: '0xabc123' as `0x${string}`,
        blockNumber: 12345678n,
        logs: [mockLog as any],
        blockHash: '0xblock456' as `0x${string}`,
        contractAddress: null,
        cumulativeGasUsed: 21000n,
        effectiveGasPrice: 1n,
        from: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        gasUsed: 21000n,
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        to: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        transactionIndex: 0,
        type: 'legacy' as const,
      } as TransactionReceipt;

      // Mock parseEventLogs to return a Transfer event
      mockParseEventLogs.mockReturnValueOnce([
        {
          args: {
            to: '0x1234567890123456789012345678901234567890',
            value: 1000000n,
          },
        },
      ] as any);

      const result = getDepositFromLogs({
        originChainId: 1,
        receipt: mockReceipt,
        value: 0n,
      });

      expect(result).toEqual({
        tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        receiverAddress: '0x1234567890123456789012345678901234567890',
        amount: 1000000n,
        depositTxHash: '0xabc123',
        depositTxBlock: 12345678n,
        originChainId: 1,
      });
    });

    it('should successfully extract deposit from logs with native transfer', () => {
      const mockReceipt = {
        transactionHash: '0xabc123' as `0x${string}`,
        blockNumber: 12345678n,
        logs: [],
        blockHash: '0xblock456' as `0x${string}`,
        contractAddress: null,
        cumulativeGasUsed: 21000n,
        effectiveGasPrice: 1n,
        from: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        gasUsed: 21000n,
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        to: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        transactionIndex: 0,
        type: 'legacy' as const,
      } as TransactionReceipt;

      // Mock parseEventLogs to return no Transfer events (native transfer)
      mockParseEventLogs.mockReturnValueOnce([]);

      const result = getDepositFromLogs({
        originChainId: 1,
        receipt: mockReceipt,
        value: 1000000000000000000n,
      });

      expect(result).toEqual({
        tokenAddress: zeroAddress,
        receiverAddress: '0x1234567890123456789012345678901234567890',
        amount: 1000000000000000000n,
        depositTxHash: '0xabc123',
        depositTxBlock: 12345678n,
        originChainId: 1,
      });
    });
  });

  describe('parseDepositLogs', () => {
    it('should parse ERC20 transfer logs', () => {
      const mockLog = {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        blockHash: '0xblock123',
        blockNumber: 12345678n,
      };

      const mockReceipt = {
        transactionHash: '0xabc123' as `0x${string}`,
        blockHash: '0xblock456' as `0x${string}`,
        blockNumber: 12345679n,
        to: '0x9876543210987654321098765432109876543210' as `0x${string}`,
        logs: [mockLog as any],
        contractAddress: null,
        cumulativeGasUsed: 21000n,
        effectiveGasPrice: 1n,
        from: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        gasUsed: 21000n,
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        transactionIndex: 0,
        type: 'legacy' as const,
      } as TransactionReceipt;

      const mockParsedLog = {
        args: {
          to: '0x1234567890123456789012345678901234567890',
          value: 1000000n,
        },
      };

      mockParseEventLogs.mockReturnValueOnce([mockParsedLog] as any);

      const result = parseDepositLogs(mockReceipt, 0n);

      expect(result).toEqual({
        depositTxHash: '0xblock123',
        depositTxBlock: 12345678n,
        tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        receiverAddress: '0x1234567890123456789012345678901234567890',
        amount: 1000000n,
      });

      expect(mockParseEventLogs).toHaveBeenCalledWith({
        abi: expect.anything(),
        eventName: 'Transfer',
        logs: [mockLog],
        args: undefined,
      });
    });

    it('should handle native token transfers when no Transfer logs found', () => {
      const mockReceipt = {
        transactionHash: '0xabc123' as `0x${string}`,
        blockHash: '0xblock456' as `0x${string}`,
        blockNumber: 12345679n,
        to: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        logs: [],
        contractAddress: null,
        cumulativeGasUsed: 21000n,
        effectiveGasPrice: 1n,
        from: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        gasUsed: 21000n,
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        transactionIndex: 0,
        type: 'legacy' as const,
      } as TransactionReceipt;

      mockParseEventLogs.mockReturnValueOnce([]);

      const result = parseDepositLogs(mockReceipt, 1000000000000000000n);

      expect(result).toEqual({
        depositTxHash: '0xblock456',
        depositTxBlock: 12345679n,
        tokenAddress: zeroAddress,
        receiverAddress: '0x1234567890123456789012345678901234567890',
        amount: 1000000000000000000n,
      });
    });

    it('should apply filters when provided', () => {
      const mockLog = {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        blockHash: '0xblock123',
        blockNumber: 12345678n,
      };

      const mockReceipt = {
        transactionHash: '0xabc123' as `0x${string}`,
        blockHash: '0xblock456' as `0x${string}`,
        blockNumber: 12345679n,
        to: '0x9876543210987654321098765432109876543210' as `0x${string}`,
        logs: [mockLog as any],
        contractAddress: null,
        cumulativeGasUsed: 21000n,
        effectiveGasPrice: 1n,
        from: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        gasUsed: 21000n,
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        transactionIndex: 0,
        type: 'legacy' as const,
      } as TransactionReceipt;

      const filter = {
        depositAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        inputAmount: 1000000n,
      };

      mockParseEventLogs.mockReturnValueOnce([]);

      parseDepositLogs(mockReceipt, 0n, filter);

      expect(mockParseEventLogs).toHaveBeenCalledWith({
        abi: expect.anything(),
        eventName: 'Transfer',
        logs: [mockLog],
        args: {
          to: filter.depositAddress,
          value: filter.inputAmount,
        },
      });
    });

    it('should handle empty logs array', () => {
      const mockReceipt = {
        transactionHash: '0xabc123' as `0x${string}`,
        blockHash: '0xblock456' as `0x${string}`,
        blockNumber: 12345679n,
        to: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        logs: [],
        contractAddress: null,
        cumulativeGasUsed: 21000n,
        effectiveGasPrice: 1n,
        from: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        gasUsed: 21000n,
        logsBloom: '0x' as `0x${string}`,
        status: 'success' as const,
        transactionIndex: 0,
        type: 'legacy' as const,
      } as TransactionReceipt;

      mockParseEventLogs.mockReturnValueOnce([]);

      const result = parseDepositLogs(mockReceipt, 1000000000000000000n);

      expect(result).toEqual({
        depositTxHash: '0xblock456',
        depositTxBlock: 12345679n,
        tokenAddress: zeroAddress,
        receiverAddress: '0x1234567890123456789012345678901234567890',
        amount: 1000000000000000000n,
      });
    });
  });
});
