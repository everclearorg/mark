/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach, afterAll } from '@jest/globals';
import { AssetConfiguration, ChainConfiguration, RebalanceRoute, cleanupHttpConnections, axiosGet } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { Transaction } from 'ethers';
import { createPublicClient, decodeEventLog, TransactionReceipt, encodeFunctionData, zeroAddress, padHex } from 'viem';
import { AcrossBridgeAdapter } from '../../../src/adapters/across/across';
import {
  DepositStatusResponse,
  SuggestedFeesResponse,
  WETH_WITHDRAWAL_TOPIC,
} from '../../../src/adapters/across/types';
import { ACROSS_SPOKE_ABI } from '../../../src/adapters/across/abi';
import { getDepositFromLogs, parseFillLogs } from '../../../src/adapters/across/utils';
import { RebalanceTransactionMemo } from '../../../src/types';

// Mock the external dependencies
jest.mock('viem');
jest.mock('@mark/logger');
jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core') as any;
  return {
    ...actual,
    axiosGet: jest.fn(),
    cleanupHttpConnections: jest.fn(),
  };
});
jest.mock('../../../src/adapters/across/utils', () => ({
  getDepositFromLogs: jest.fn(),
  parseFillLogs: jest.fn(),
}));

// Test adapter that exposes private methods
class TestAcrossBridgeAdapter extends AcrossBridgeAdapter {
  public getSuggestedFees(route: RebalanceRoute, amount: string): Promise<SuggestedFeesResponse> {
    return super.getSuggestedFees(route, amount);
  }

  public getDepositStatusFromApi(route: RebalanceRoute, depositId: number): Promise<DepositStatusResponse> {
    return super.getDepositStatusFromApi(route, depositId);
  }

  public handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    return super.handleError(error, context, metadata);
  }

  public findMatchingDestinationAsset(
    asset: string,
    origin: number,
    destination: number,
  ): AssetConfiguration | undefined {
    return super.findMatchingDestinationAsset(asset, origin, destination);
  }

  public extractDepositId(origin: number, receipt: TransactionReceipt): number | undefined {
    return super.extractDepositId(origin, receipt);
  }

  public requiresCallback(
    route: RebalanceRoute,
    fillTxHash: string,
  ): Promise<{
    needsCallback: boolean;
    amount?: bigint;
    recipient?: string;
  }> {
    return super.requiresCallback(route, fillTxHash);
  }
}

// Mock the Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

// Mock data for testing
const mockUrl = 'https://across-api.example.com';

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
    decimals: 18,
    tickerHash: '0xUSDCHash',
    isNative: false,
    balanceThreshold: '0',
  },
};

const mockChains: Record<string, any> = {
  '1': {
    assets: Object.values(mockAssets),
    providers: ['https://base-mainnet.example.com'],
    invoiceAge: 3600,
    gasThreshold: '100000000000',
    deployments: {
      everclear: '0xEverclearAddress',
      permit2: '0xPermit2Address',
      multicall3: '0xMulticall3Address',
    },
  },
  '10': {
    assets: Object.values(mockAssets),
    providers: ['https://opt-mainnet.example.com'],
    invoiceAge: 3600,
    gasThreshold: '100000000000',
    deployments: {
      everclear: '0xEverclearAddress',
      permit2: '0xPermit2Address',
      multicall3: '0xMulticall3Address',
    },
  },
};

// Mock API response
const mockFeesResponse: SuggestedFeesResponse = {
  totalRelayFee: {
    total: '100000', // 0.1 USDC
    pct: '0.001',
  },
  lpFee: {
    total: '50000', // 0.05 USDC
    pct: '0.0005',
  },
  relayerCapitalFee: {
    total: '50000',
    pct: '0.0005',
  },
  relayerGasFee: {
    total: '50000',
    pct: '0.0005',
  },
  isAmountTooLow: false,
  spokePoolAddress: '0xSpokePoolAddress' as `0x${string}`,
  outputAmount: BigInt('500000500000500'),
  timestamp: Date.now(),
  fillDeadline: Date.now() + 3600000,
  exclusiveRelayer: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  exclusivityDeadline: '0x0000000000000000000000000000000000000000' as `0x${string}`,
};

// Mock deposit status response
const mockStatusResponse: DepositStatusResponse = {
  status: 'filled',
  fillTx: '0xfilltxhash',
  destinationChainId: 10,
  originChainId: 1,
  depositId: '12312',
  depositTxHash: '0xdeposittxhash',
};

const FILLED_V3_RELAY_TOPIC = '0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208';

describe('AcrossBridgeAdapter', () => {
  let adapter: TestAcrossBridgeAdapter;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Reset all mock implementations
    (axiosGet as jest.MockedFunction<typeof axiosGet>).mockReset();
    (createPublicClient as jest.Mock).mockImplementation(() => ({
      getBalance: jest.fn<() => Promise<bigint>>(),
      readContract: jest.fn<() => Promise<unknown>>(),
      getTransactionReceipt: jest.fn(),
    }));
    (decodeEventLog as jest.Mock).mockReset();
    (encodeFunctionData as jest.Mock).mockReset();
    (getDepositFromLogs as jest.Mock).mockReset();

    // Reset logger mocks
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    // Create fresh adapter instance
    adapter = new TestAcrossBridgeAdapter(mockUrl, mockChains as Record<string, ChainConfiguration>, mockLogger);
  });

  afterEach(() => {
    cleanupHttpConnections();
  });

  afterAll(() => {
    cleanupHttpConnections();
  });

  describe('constructor', () => {
    it('should initialize correctly', () => {
      expect(adapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Initializing AcrossBridgeAdapter', { url: mockUrl });
    });
  });

  describe('type', () => {
    it('should return the correct type', () => {
      expect(adapter.type()).toBe('across');
    });
  });

  describe('getReceivedAmount', () => {
    it('should calculate received amount correctly after subtracting fees', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock the findMatchingDestinationAsset method to return just the address
      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue({
        ...mockAssets['USDC'],
        address: mockAssets['USDC'].address,
      });

      // Mock axiosGet to return the fees response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockFeesResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Execute
      const amount = '10000000'; // 10 USDC
      const result = await adapter.getReceivedAmount(amount, route);

      // Expected: 10 USDC - 0.1 USDC - 0.05 USDC = 9.85 USDC
      expect(result).toBe(mockFeesResponse.outputAmount.toString());
      expect(axiosGet).toHaveBeenCalledWith(
        `${mockUrl}/suggested-fees?inputToken=${route.asset}&outputToken=${mockAssets['USDC'].address}&originChainId=${route.origin}&destinationChainId=${route.destination}&amount=10000000`,
      );
    });

    it('should throw an error if the API request fails', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock axiosGet to reject with an error
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockRejectedValueOnce(new Error('API error'));

      // Execute and expect error
      await expect(adapter.getReceivedAmount('10000000', route)).rejects.toThrow(
        'Failed to get received amount from Across',
      );
    });

    it('should throw an error if amount is too low', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock axiosGet to return fees response with isAmountTooLow: true
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: { ...mockFeesResponse, isAmountTooLow: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Execute and expect error
      await expect(adapter.getReceivedAmount('100', route)).rejects.toThrow(
        'Amount is too low for suggested route via across',
      );
    });
  });

  describe('send', () => {
    it('should prepare transaction request correctly', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock the findMatchingDestinationAsset method to return the destination asset
      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue({
        ...mockAssets['USDC'],
        address: mockAssets['USDC'].address,
      });

      // Mock axiosGet to return the fees response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockFeesResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });
      (encodeFunctionData as jest.Mock).mockReturnValueOnce('0xdata');
      const amount = '10000000'; // 10 USDC

      // Mock the public client to return sufficient allowance
      const mockReadContract = jest.fn();
      (mockReadContract as any).mockResolvedValue(BigInt(amount)); // Sufficient allowance
      (createPublicClient as jest.Mock).mockReturnValue({
        readContract: mockReadContract,
      });

      // Execute
      const senderAddress = '0x' + 'sender'.padStart(40, '0');
      const recipientAddress = '0x' + 'recipient'.padStart(40, '0');
      const result = await adapter.send(senderAddress, recipientAddress, amount, route);

      // Assert
      expect(result.length).toBe(1);
      expect(result[0].memo).toEqual(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe('0xSpokePoolAddress');
      expect(result[0].transaction.value).toBe(BigInt(0)); // ERC20 transfer, not native ETH
      expect(result[0].transaction.data).toEqual('0xdata');

      // Verify encodeFunctionData was called with correct args
      expect(encodeFunctionData).toHaveBeenCalledWith({
        abi: ACROSS_SPOKE_ABI,
        functionName: 'depositV3',
        args: [
          senderAddress, // depositor
          recipientAddress, // recipient
          mockAssets['USDC'].address, // inputToken
          mockAssets['USDC'].address, // outputToken
          BigInt(amount), // inputAmount
          mockFeesResponse.outputAmount, // outputAmount
          BigInt(route.destination), // destinationChainId
          zeroAddress, // exclusiveRelayer - must be zeroAddress per Zodiac permissions
          mockFeesResponse.timestamp, // quoteTimestamp
          mockFeesResponse.fillDeadline, // fillDeadline
          BigInt(0), // exclusivityDeadline - must be 0 per Zodiac permissions
          '0x', // message - must be "0x" per Zodiac permissions
        ],
      });
    });

    it('should include an approval transaction if allowance is insufficient', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };
      const amount = '10000000'; // 10 USDC
      const senderAddress = '0x' + 'sender'.padStart(40, '0');
      const recipientAddress = '0x' + 'recipient'.padStart(40, '0');

      // Mock the findMatchingDestinationAsset method to return the destination asset
      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue({
        ...mockAssets['USDC'],
        address: mockAssets['USDC'].address,
      });

      // Mock axiosGet to return the fees response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockFeesResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Mock encodeFunctionData for both approval and deposit
      (encodeFunctionData as jest.Mock)
        .mockReturnValueOnce('0xapproval_data') // For approve
        .mockReturnValueOnce('0xdeposit_data'); // For depositV3

      // Mock the public client to return insufficient allowance
      const mockReadContract = jest.fn();
      (mockReadContract as any).mockResolvedValue(BigInt(0)); // Insufficient allowance
      (createPublicClient as jest.Mock).mockReturnValue({
        readContract: mockReadContract,
      });

      // Execute
      const result = await adapter.send(senderAddress, recipientAddress, amount, route);

      // Assert
      expect(result.length).toBe(2);
      // Approval transaction
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(result[0].transaction.to).toBe(route.asset);
      expect(result[0].transaction.data).toBe('0xapproval_data');
      expect(result[0].transaction.value).toBe(BigInt(0));

      // Rebalance transaction
      expect(result[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[1].transaction.to).toBe(mockFeesResponse.spokePoolAddress);
      expect(result[1].transaction.data).toBe('0xdeposit_data');
      expect(result[1].transaction.value).toBe(BigInt(0));

      // Verify readContract was called for allowance check
      expect(mockReadContract).toHaveBeenCalledWith({
        address: route.asset as `0x${string}`,
        abi: expect.any(Array),
        functionName: 'allowance',
        args: [senderAddress, mockFeesResponse.spokePoolAddress],
      });
    });

    it('should not include an approval transaction if allowance is sufficient', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };
      const amount = '10000000'; // 10 USDC
      const senderAddress = '0x' + 'sender'.padStart(40, '0');
      const recipientAddress = '0x' + 'recipient'.padStart(40, '0');

      // Mock the findMatchingDestinationAsset method
      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue({
        ...mockAssets['USDC'],
        address: mockAssets['USDC'].address,
      });

      // Mock axiosGet to return the fees response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockFeesResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Mock encodeFunctionData for the deposit
      (encodeFunctionData as jest.Mock).mockReturnValueOnce('0xdeposit_data');

      // Mock the public client to return sufficient allowance
      const mockReadContract = jest.fn();
      (mockReadContract as any).mockResolvedValue(BigInt(amount)); // Sufficient allowance
      (createPublicClient as jest.Mock).mockReturnValue({
        readContract: mockReadContract,
      });

      // Execute
      const result = await adapter.send(senderAddress, recipientAddress, amount, route);

      // Assert
      expect(result.length).toBe(1);
      expect(result[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(result[0].transaction.to).toBe(mockFeesResponse.spokePoolAddress);
      expect(result[0].transaction.data).toBe('0xdeposit_data');
      expect(result[0].transaction.value).toBe(BigInt(0));

      // Verify readContract was called for allowance check
      expect(mockReadContract).toHaveBeenCalledWith({
        address: route.asset as `0x${string}`,
        abi: expect.any(Array),
        functionName: 'allowance',
        args: [senderAddress, mockFeesResponse.spokePoolAddress],
      });
    });

    it('should throw an error if amount is too low', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock axiosGet to return fees response with isAmountTooLow: true
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: { ...mockFeesResponse, isAmountTooLow: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Execute and expect error
      await expect(adapter.send('0xsender', '0xrecipient', '1000', route)).rejects.toThrow(
        'Amount is too low for bridging via Across',
      );
    });
  });

  describe('destinationCallback', () => {
    it('should return a transaction to wrap ETH to WETH if needed', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      // Mock transaction receipt
      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        blockHash: '0xmockblockhash',
        logs: [
          {
            address: '0xSpokePoolAddress',
            topics: [
              '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
              '0x0000000000000000000000000000000000000000000000000000000000000123',
            ],
            data: '0x',
            blockNumber: BigInt(1234),
            transactionHash: '0xmocktxhash',
            transactionIndex: 1,
            blockHash: '0xmockblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        logsBloom: '0x',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
      };

      // Mock the extractDepositId method
      jest.spyOn(adapter, 'extractDepositId').mockReturnValue(291);

      // Mock axiosGet to return the status response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockStatusResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Mock the requiresCallback function
      jest.spyOn(adapter, 'requiresCallback').mockResolvedValue({
        needsCallback: true,
        amount: BigInt('1000000000000000000'),
        recipient: '0xRecipient',
      });

      // Execute
      const result = await adapter.destinationCallback(route, mockReceipt as TransactionReceipt);

      // Assert
      expect(result).toEqual({
        transaction: {
          to: mockAssets['WETH'].address,
          data: '0xd0e30db0',
          value: BigInt('1000000000000000000'),
        },
        memo: RebalanceTransactionMemo.Wrap,
      });
    });

    it('should return void if no callback is needed', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock transaction receipt
      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        blockHash: '0xmockblockhash',
        logs: [
          {
            address: '0xSpokePoolAddress',
            topics: [
              '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
              '0x0000000000000000000000000000000000000000000000000000000000000123',
            ],
            data: '0x',
            blockNumber: BigInt(1234),
            transactionHash: '0xmocktxhash',
            transactionIndex: 1,
            blockHash: '0xmockblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        logsBloom: '0x',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
      };

      // Mock the extractDepositId method
      jest.spyOn(adapter, 'extractDepositId').mockReturnValue(291);

      // Mock axiosGet to return the status response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockStatusResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Mock the requiresCallback function
      jest.spyOn(adapter, 'requiresCallback').mockResolvedValue({
        needsCallback: false,
      });

      // Execute
      const result = await adapter.destinationCallback(route, mockReceipt as TransactionReceipt);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('readyOnDestination', () => {
    it('should return true if deposit is filled', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock transaction receipt
      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        blockHash: '0xmockblockhash',
        logs: [
          {
            address: '0xSpokePoolAddress',
            topics: [
              '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
              '0x0000000000000000000000000000000000000000000000000000000000000123',
            ],
            data: '0x',
            blockNumber: BigInt(1234),
            transactionHash: '0xmocktxhash',
            transactionIndex: 1,
            blockHash: '0xmockblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        logsBloom: '0x',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
      };

      // Mock the extractDepositId method
      jest.spyOn(adapter, 'extractDepositId').mockReturnValue(291);

      // Mock axiosGet to return the status response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockStatusResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Execute
      const result = await adapter.readyOnDestination('10000000', route, mockReceipt as TransactionReceipt);

      // Assert
      expect(result).toBe(true);
      expect(axiosGet).toHaveBeenCalledWith(`${mockUrl}/deposit/status`, {
        params: {
          originChainId: route.origin,
          depositId: 291,
        },
      });
    });

    it('should return false if deposit is not yet filled', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock transaction receipt
      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        blockHash: '0xmockblockhash',
        logs: [
          {
            address: '0xSpokePoolAddress',
            topics: [
              '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
              '0x0000000000000000000000000000000000000000000000000000000000000123',
            ],
            data: '0x',
            blockNumber: BigInt(1234),
            transactionHash: '0xmocktxhash',
            transactionIndex: 1,
            blockHash: '0xmockblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        logsBloom: '0x',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
      };

      // Mock axiosGet to return the status response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockStatusResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Execute
      const result = await adapter.readyOnDestination('10000000', route, mockReceipt as TransactionReceipt);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('getSuggestedFees', () => {
    it('should fetch and return suggested fees', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock the findMatchingDestinationAsset method
      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue({
        ...mockAssets['USDC'],
        address: mockAssets['USDC'].address,
      });

      // Mock axiosGet to return the fees response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockFeesResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Execute
      const result = await adapter.getSuggestedFees(route, '10000000');

      // Assert
      expect(result).toEqual(mockFeesResponse);
      expect(axiosGet).toHaveBeenCalledWith(
        `${mockUrl}/suggested-fees?inputToken=${route.asset}&outputToken=${mockAssets['USDC'].address}&originChainId=${route.origin}&destinationChainId=${route.destination}&amount=10000000`,
      );
    });
  });

  describe('getDepositStatusFromApi', () => {
    it('should fetch and return deposit status', async () => {
      // Mock route
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock API response
      const mockStatusResponse: DepositStatusResponse = {
        status: 'filled',
        fillTx: '0xfilltxhash',
        destinationChainId: 10,
        originChainId: 1,
        depositId: '291',
        depositTxHash: '0xdeposittxhash',
      };

      // Mock axiosGet to return the status response
      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockStatusResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      // Execute
      const result = await adapter.getDepositStatusFromApi(route, 291);

      // Assert
      expect(result).toEqual(mockStatusResponse);
      expect(axiosGet).toHaveBeenCalledWith(`${mockUrl}/deposit/status`, {
        params: {
          originChainId: route.origin,
          depositId: 291,
        },
      });
    });
  });

  describe('handleError', () => {
    it('should log and throw error with context', () => {
      const error = new Error('Test error');
      const context = 'test operation';
      const metadata = { test: 'data' };

      // Execute and expect error
      expect(() => adapter.handleError(error, context, metadata)).toThrow('Failed to test operation: Test error');

      // Assert logging
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to test operation', {
        error: jsonifyError(error),
        test: 'data',
      });
    });
  });

  describe('findMatchingDestinationAsset', () => {
    it('should find matching asset in destination chain', () => {
      const result = adapter.findMatchingDestinationAsset(mockAssets['USDC'].address, 1, 10);

      expect(result).toEqual(mockAssets['USDC']);
    });

    it('should return undefined if origin chain not found', () => {
      const result = adapter.findMatchingDestinationAsset(mockAssets['USDC'].address, 999, 10);

      expect(result).toBeUndefined();
    });

    it('should return undefined if destination chain not found', () => {
      const result = adapter.findMatchingDestinationAsset(mockAssets['USDC'].address, 1, 999);

      expect(result).toBeUndefined();
    });

    it('should return undefined if asset not found in origin chain', () => {
      const result = adapter.findMatchingDestinationAsset('0xInvalidAddress', 1, 10);

      expect(result).toBeUndefined();
    });
  });

  describe('extractDepositId', () => {
    it('should extract deposit ID from transaction receipt', () => {
      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        blockHash: '0xmockblockhash',
        logs: [
          {
            address: '0xSpokePoolAddress',
            topics: [undefined, '0x0000000000000000000000000000000000000000000000000000000000000123'] as any,
            data: '0x',
            blockNumber: BigInt(1234),
            transactionHash: '0xmocktxhash',
            transactionIndex: 1,
            blockHash: '0xmockblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        logsBloom: '0x',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
      };

      // Mock getDepositFromLogs to return a deposit with ID 291
      (getDepositFromLogs as jest.Mock).mockReturnValue({
        depositId: BigInt(291),
        inputToken: '0xInputToken',
        outputToken: '0xOutputToken',
        inputAmount: BigInt(1000),
        outputAmount: BigInt(1000),
        destinationChainId: 10,
        message: '0x',
        depositor: '0xDepositor',
        recipient: '0xRecipient',
        exclusiveRelayer: '0xRelayer',
        quoteTimestamp: 1234567890,
        fillDeadline: 1234567890,
        exclusivityDeadline: 1234567890,
        status: 'pending',
        depositTxHash: '0xmocktxhash',
        depositTxBlock: BigInt(1234),
        originChainId: 1,
      });

      const result = adapter.extractDepositId(1, mockReceipt as TransactionReceipt);

      expect(result).toBe(291);
      expect(getDepositFromLogs).toHaveBeenCalledWith({
        originChainId: 1,
        receipt: mockReceipt,
      });
    });

    it('should return undefined if no deposit event found', () => {
      const mockReceipt: Partial<TransactionReceipt> = {
        transactionHash: '0xmocktxhash',
        blockHash: '0xmockblockhash',
        logs: [],
        logsBloom: '0x',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
      };

      // Mock getDepositFromLogs to throw error when no deposit found
      (getDepositFromLogs as jest.Mock).mockImplementation(() => {
        throw new Error('No deposit log found.');
      });

      const result = adapter.extractDepositId(1, mockReceipt as TransactionReceipt);

      expect(result).toBeUndefined();
      expect(getDepositFromLogs).toHaveBeenCalledWith({
        originChainId: 1,
        receipt: mockReceipt,
      });
    });
  });

  describe('requiresCallback', () => {
    it('should throw error if origin asset is not found', async () => {
      const route: RebalanceRoute = {
        asset: '0xInvalidAddress',
        origin: 1,
        destination: 10,
      };

      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue(undefined);

      await expect(adapter.requiresCallback(route, '0xfilltxhash')).rejects.toThrow('Could not find origin asset');
    });

    it('should return needsCallback=false if destination native asset is not ETH', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      jest
        .spyOn(adapter, 'findMatchingDestinationAsset')
        .mockReturnValueOnce(mockAssets['WETH'])
        .mockReturnValueOnce({ ...mockAssets['ETH'], symbol: 'MATIC' });

      const result = await adapter.requiresCallback(route, '0xfilltxhash');

      expect(result).toEqual({ needsCallback: false });
    });

    it('should return needsCallback=false if provider is not available', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      jest
        .spyOn(adapter, 'findMatchingDestinationAsset')
        .mockReturnValueOnce(mockAssets['WETH'])
        .mockReturnValueOnce(mockAssets['ETH']);

      // Mock chains without provider
      const mockChainsWithoutProvider = {
        ...mockChains,
        '10': { ...mockChains['10'], providers: [] },
      };
      adapter = new TestAcrossBridgeAdapter(
        mockUrl,
        mockChainsWithoutProvider as Record<string, ChainConfiguration>,
        mockLogger,
      );

      const result = await adapter.requiresCallback(route, '0xfilltxhash');

      expect(result).toEqual({ needsCallback: false });
    });

    it('should throw error if no fill event is found', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValueOnce(mockAssets['ETH']);

      const mockReceipt = {
        logs: [],
        transactionHash: '0xfilltxhash',
        blockHash: '0xblockhash',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
        logsBloom: '0x',
      } as TransactionReceipt;

      const mockGetReceipt = jest
        .fn<(args: { hash: string }) => Promise<Transaction>>()
        .mockResolvedValue(mockReceipt as any);

      (createPublicClient as jest.Mock).mockReturnValue({
        getTransactionReceipt: mockGetReceipt,
        getBalance: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt('1000000000000000000')),
        readContract: jest.fn<() => Promise<unknown>>().mockResolvedValue(BigInt('1000000000000000000')),
      });

      // Mock parseFillLogs to return undefined (no fill event found)
      (parseFillLogs as jest.Mock).mockReturnValue(undefined);

      await expect(adapter.requiresCallback(route, '0xfilltxhash')).rejects.toThrow(
        'Failed to find fill logs from receipt',
      );

      // Verify parseFillLogs was called with correct args
      expect(parseFillLogs).toHaveBeenCalledWith(mockReceipt.logs, {
        inputToken: padHex(route.asset.toLowerCase() as `0x${string}`, { size: 32 }),
        originChainId: BigInt(route.origin),
      });
    });

    it('should return needsCallback=true when output token is zero hash (native ETH)', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValueOnce(mockAssets['ETH']);

      const mockReceipt = {
        logs: [
          {
            topics: [FILLED_V3_RELAY_TOPIC],
            data: '0x',
            address: '0xSpokePoolAddress',
            blockNumber: BigInt(1234),
            transactionHash: '0xfilltxhash',
            transactionIndex: 1,
            blockHash: '0xblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        transactionHash: '0xfilltxhash',
        blockHash: '0xblockhash',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
        logsBloom: '0x',
      } as TransactionReceipt;

      const mockGetReceipt = jest
        .fn<(args: { hash: string }) => Promise<Transaction>>()
        .mockResolvedValue(mockReceipt as any);

      (createPublicClient as jest.Mock).mockReturnValue({
        getTransactionReceipt: mockGetReceipt,
        getBalance: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt('1000000000000000000')),
        readContract: jest.fn<() => Promise<unknown>>().mockResolvedValue(BigInt('1000000000000000000')),
      });

      // Mock parseFillLogs to return undefined (no fill event found)
      (parseFillLogs as jest.Mock).mockReturnValue({
        outputToken: zeroAddress,
        recipient: '0xRecipient',
        outputAmount: BigInt('1000000000000000000'),
      });

      const result = await adapter.requiresCallback(route, '0xfilltxhash');

      expect(result).toEqual({
        needsCallback: true,
        amount: BigInt('1000000000000000000'),
        recipient: '0xRecipient',
      });
    });

    it('should return needsCallback=true when output token is WETH and has been withdrawn', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      jest
        .spyOn(adapter, 'findMatchingDestinationAsset')
        .mockReturnValueOnce(mockAssets['ETH'])
        .mockReturnValueOnce(mockAssets['WETH']);

      const mockReceipt = {
        logs: [
          {
            topics: [FILLED_V3_RELAY_TOPIC],
            data: '0x',
            address: '0xSpokePoolAddress',
            blockNumber: BigInt(1234),
            transactionHash: '0xfilltxhash',
            transactionIndex: 1,
            blockHash: '0xblockhash',
            logIndex: 0,
            removed: false,
          },
          {
            topics: [WETH_WITHDRAWAL_TOPIC],
            data: '0x',
            address: '0xSpokePoolAddress',
            blockNumber: BigInt(1234),
            transactionHash: '0xfilltxhash',
            transactionIndex: 1,
            blockHash: '0xblockhash',
            logIndex: 1,
            removed: false,
          },
        ],
        transactionHash: '0xfilltxhash',
        blockHash: '0xblockhash',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
        logsBloom: '0x',
      } as TransactionReceipt;

      const mockGetReceipt = jest
        .fn<(args: { hash: string }) => Promise<Transaction>>()
        .mockResolvedValue(mockReceipt as any);

      (createPublicClient as jest.Mock).mockReturnValue({
        getTransactionReceipt: mockGetReceipt,
        getBalance: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt('1000000000000000000')),
        readContract: jest.fn<() => Promise<unknown>>().mockResolvedValue(BigInt('1000000000000000000')),
      });

      // Mock parseFillLogs to return undefined (no fill event found)
      (parseFillLogs as jest.Mock).mockReturnValue({
        outputToken: mockAssets['WETH'].address,
        recipient: '0xRecipient',
        outputAmount: BigInt('1000000000000000000'),
      });

      const result = await adapter.requiresCallback(route, '0xfilltxhash');

      expect(result).toEqual({
        needsCallback: true,
        amount: BigInt('1000000000000000000'),
        recipient: '0xRecipient',
      });
    });

    it('should return needsCallback=false when output token is WETH but has not been withdrawn', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      jest
        .spyOn(adapter, 'findMatchingDestinationAsset')
        .mockReturnValueOnce(mockAssets['ETH'])
        .mockReturnValueOnce(mockAssets['WETH']);

      const mockReceipt = {
        logs: [
          {
            topics: [FILLED_V3_RELAY_TOPIC],
            data: '0x',
            address: '0xSpokePoolAddress',
            blockNumber: BigInt(1234),
            transactionHash: '0xfilltxhash',
            transactionIndex: 1,
            blockHash: '0xblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        transactionHash: '0xfilltxhash',
        blockHash: '0xblockhash',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
        logsBloom: '0x',
      } as TransactionReceipt;

      const mockGetReceipt = jest
        .fn<(args: { hash: string }) => Promise<Transaction>>()
        .mockResolvedValue(mockReceipt as any);

      (createPublicClient as jest.Mock).mockReturnValue({
        getTransactionReceipt: mockGetReceipt,
        getBalance: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt('1000000000000000000')),
        readContract: jest.fn<() => Promise<unknown>>().mockResolvedValue(BigInt('1000000000000000000')),
      });

      // Mock parseFillLogs to return undefined (no fill event found)
      (parseFillLogs as jest.Mock).mockReturnValue({
        outputToken: mockAssets['WETH'].address,
        recipient: '0xRecipient',
        outputAmount: BigInt('1000000000000000000'),
      });

      const result = await adapter.requiresCallback(route, '0xfilltxhash');

      expect(result).toEqual({
        needsCallback: false,
        amount: BigInt('1000000000000000000'),
        recipient: '0xRecipient',
      });
    });

    it('should return needsCallback=false when output token is not WETH', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      jest
        .spyOn(adapter, 'findMatchingDestinationAsset')
        .mockReturnValueOnce(mockAssets['ETH'])
        .mockReturnValueOnce(mockAssets['USDC']);

      const mockReceipt = {
        logs: [
          {
            topics: [FILLED_V3_RELAY_TOPIC],
            data: '0x',
            address: '0xSpokePoolAddress',
            blockNumber: BigInt(1234),
            transactionHash: '0xfilltxhash',
            transactionIndex: 1,
            blockHash: '0xblockhash',
            logIndex: 0,
            removed: false,
          },
        ],
        transactionHash: '0xfilltxhash',
        blockHash: '0xblockhash',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
        logsBloom: '0x',
      } as TransactionReceipt;

      const mockGetReceipt = jest
        .fn<(args: { hash: string }) => Promise<Transaction>>()
        .mockResolvedValue(mockReceipt as any);

      (createPublicClient as jest.Mock).mockReturnValue({
        getTransactionReceipt: mockGetReceipt,
        getBalance: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt('1000000000000000000')),
        readContract: jest.fn<() => Promise<unknown>>().mockResolvedValue(BigInt('1000000000000000000')),
      });

      // Mock parseFillLogs to return undefined (no fill event found)
      (parseFillLogs as jest.Mock).mockReturnValue({
        outputToken: mockAssets['USDC'].address,
        recipient: '0xRecipient',
        outputAmount: BigInt('1000000000000000000'),
      });

      const result = await adapter.requiresCallback(route, '0xfilltxhash');

      expect(result).toEqual({
        needsCallback: false,
        amount: BigInt('1000000000000000000'),
        recipient: '0xRecipient',
      });
    });
  });

  describe('error handling edge cases', () => {
    it('should handle missing destination asset error', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 999, // Unsupported destination
      };

      jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue(undefined);

      await expect(adapter.getReceivedAmount('1000000', route)).rejects.toThrow(
        'Could not find matching destination asset',
      );
    });

    it('should handle missing providers error', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      // Mock chains without providers
      const adapterwithoutProviders = new TestAcrossBridgeAdapter(
        mockUrl,
        { '1': { ...mockChains['1'], providers: [] } },
        mockLogger,
      );

      jest.spyOn(adapterwithoutProviders, 'findMatchingDestinationAsset').mockReturnValue(mockAssets['USDC']);

      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockResolvedValueOnce({
        data: mockFeesResponse,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      });

      await expect(adapterwithoutProviders.send('0xsender', '0xrecipient', '1000000', route)).rejects.toThrow(
        'No providers found for origin chain 1',
      );
    });

    it('should handle API errors gracefully', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockRejectedValueOnce(new Error('API Error'));

      await expect(adapter.getReceivedAmount('1000000', route)).rejects.toThrow();
    });

    it('should handle deposit status API errors', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['USDC'].address,
        origin: 1,
        destination: 10,
      };

      (axiosGet as jest.MockedFunction<typeof axiosGet>).mockRejectedValueOnce(new Error('Deposit API Error'));

      await expect(adapter.getDepositStatusFromApi(route, 123)).rejects.toThrow();
    });
  });

  describe('callback detection edge cases', () => {
    it('should handle transaction receipt without logs', async () => {
      const route: RebalanceRoute = {
        asset: mockAssets['WETH'].address,
        origin: 1,
        destination: 10,
      };

      const mockReceipt = {
        logs: [],
        transactionHash: '0xfilltxhash',
        blockHash: '0xblockhash',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
        logsBloom: '0x',
      } as TransactionReceipt;

      (createPublicClient as jest.Mock).mockReturnValue({
        getTransactionReceipt: jest.fn<() => Promise<TransactionReceipt>>().mockResolvedValue(mockReceipt),
      });

      (parseFillLogs as jest.Mock).mockReturnValue(undefined);

      await expect(adapter.requiresCallback(route, '0xfilltxhash')).rejects.toThrow();
    });

    it('should handle missing deposit ID extraction', async () => {
      const mockReceipt = {
        logs: [],
        transactionHash: '0xmocktxhash',
        blockHash: '0xmockblockhash',
        blockNumber: BigInt(1234),
        contractAddress: null,
        effectiveGasPrice: BigInt(0),
        from: '0xsender',
        to: '0xSpokePoolAddress',
        gasUsed: BigInt(0),
        cumulativeGasUsed: BigInt(0),
        status: 'success',
        type: 'eip1559',
        transactionIndex: 1,
        logsBloom: '0x',
      } as TransactionReceipt;

      (getDepositFromLogs as jest.Mock).mockReturnValue(undefined);

      const result = adapter.extractDepositId(1, mockReceipt);
      expect(result).toBeUndefined();
    });
  });
});
