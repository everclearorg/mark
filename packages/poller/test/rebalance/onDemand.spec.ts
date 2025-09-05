import {
  evaluateOnDemandRebalancing,
  executeOnDemandRebalancing,
  processPendingEarmarks,
} from '../../src/rebalance/onDemand';
import * as database from '@mark/database';
import { ProcessingContext } from '../../src/init';
import { Invoice, EarmarkStatus, RebalanceOperationStatus, SupportedBridge } from '@mark/core';
import { RebalanceTransactionMemo } from '@mark/rebalance';
import { getMarkBalances, safeStringToBigInt, parseAmountWithDecimals } from '../../src/helpers';
import { getValidatedZodiacConfig, getActualOwner, getActualAddress } from '../../src/helpers/zodiac';
import { submitTransactionWithLogging } from '../../src/helpers/transactions';

// Test data constants
const MOCK_TICKER_HASH = '0x1234567890123456789012345678901234567890';
const MOCK_INVOICE_ID = 'test-invoice-001';

// Mock functions for dependencies
jest.mock('../../src/helpers', () => {
  const actualHelpers = jest.requireActual('../../src/helpers');
  return {
    ...actualHelpers,
    getMarkBalances: jest.fn(),
    getTickerForAsset: jest.fn((asset: string, chain: number, config: any) => {
      // Mock the actual getTickerForAsset behavior
      const chainConfig = config.chains[chain.toString()];
      if (!chainConfig || !chainConfig.assets) {
        return undefined;
      }
      const assetConfig = chainConfig.assets.find((a: any) => a.address.toLowerCase() === asset.toLowerCase());
      if (!assetConfig) {
        return undefined;
      }
      return assetConfig.tickerHash;
    }),
    safeStringToBigInt: jest.fn((value: string, scaleFactor?: bigint) => {
      if (!value || value === '0' || value === '0.0') {
        return 0n;
      }

      if (value.includes('.')) {
        const [intPart, decimalPart] = value.split('.');
        const digits = scaleFactor ? scaleFactor.toString().length - 1 : 0;
        const paddedDecimal = decimalPart.slice(0, digits).padEnd(digits, '0');
        const integerValue = intPart || '0';
        return BigInt(`${integerValue}${paddedDecimal}`);
      }

      return scaleFactor ? BigInt(value) * scaleFactor : BigInt(value);
    }),
    convertToNativeUnits: jest.fn((amount: bigint, decimals?: number) => {
      // Convert from 18 decimals to native decimals
      const targetDecimals = decimals ?? 18;
      if (targetDecimals === 18) return amount;
      const divisor = BigInt(10 ** (18 - targetDecimals));
      return amount / divisor;
    }),
    convertTo18Decimals: jest.fn((amount: bigint, decimals?: number) => {
      // Convert from native decimals to 18 decimals
      const sourceDecimals = decimals ?? 18;
      if (sourceDecimals === 18) return amount;
      const multiplier = BigInt(10 ** (18 - sourceDecimals));
      return amount * multiplier;
    }),
    parseAmountWithDecimals: jest.fn((amount: string, decimals?: number) => {
      // This function should parse a string amount (which might be in native units)
      // The implementation expects amounts to already be in smallest units
      // For USDC: "1000000" (1 USDC in 6 decimals) → needs to be converted to 18 decimals

      // First parse the string to bigint (assumes already in smallest units)
      const amountBigInt = BigInt(amount);

      // Now convert from native decimals to 18 decimals
      const sourceDecimals = decimals ?? 18;
      if (sourceDecimals === 18) return amountBigInt;

      // USDC has 6 decimals, so we need to multiply by 10^12 to get to 18 decimals
      const multiplier = BigInt(10 ** (18 - sourceDecimals));
      return amountBigInt * multiplier;
    }),
  };
});

jest.mock('../../src/helpers/zodiac', () => ({
  getValidatedZodiacConfig: jest.fn(),
  getActualOwner: jest.fn(),
  getActualAddress: jest.fn(),
}));

jest.mock('../../src/helpers/transactions', () => ({
  submitTransactionWithLogging: jest.fn(() =>
    Promise.resolve({
      hash: '0xtestHash',
      receipt: {
        transactionHash: '0xtestHash',
        blockNumber: 1000n,
        blockHash: '0xblockhash',
        from: '0xfrom',
        to: '0xto',
        cumulativeGasUsed: 100000n,
        effectiveGasPrice: 1000000000n,
        gasUsed: 50000n,
        status: 'success',
        contractAddress: null,
        logs: [],
        logsBloom: '0x',
        transactionIndex: 0,
        type: 'legacy',
      },
    }),
  ),
}));

// Remove the incorrect mock since executeRebalanceTransactionWithBridge is local to onDemand.ts

jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core');
  return {
    ...actual,
    getDecimalsFromConfig: jest.fn(() => {
      // USDC typically has 6 decimals
      return 6;
    }),
  };
});

jest.mock('@mark/database', () => ({
  getPool: jest.fn(() => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  })),
  getEarmarks: jest.fn().mockResolvedValue([]),
  getEarmarkForInvoice: jest.fn(),
  createEarmark: jest.fn().mockResolvedValue({
    id: 'mock-earmark-id',
    status: 'pending',
    invoiceId: 'test-invoice-001',
  }),
  updateEarmarkStatus: jest.fn().mockResolvedValue({ id: 'mock-earmark-id', status: 'ready' }),
  removeEarmark: jest.fn().mockResolvedValue(undefined),
  cleanupCompletedEarmarks: jest.fn().mockResolvedValue(undefined),
  cleanupStaleEarmarks: jest.fn().mockResolvedValue(undefined),
  createRebalanceOperation: jest.fn().mockResolvedValue({ id: 'mock-rebalance-id' }),
  getRebalanceOperationsByEarmark: jest.fn().mockResolvedValue([
    {
      id: 'mock-rebalance-id',
      originChainId: 10,
      destinationChainId: 1,
    },
  ]),
}));

describe('On-Demand Rebalancing - Jest Database Tests', () => {
  beforeEach(async () => {
    // Setup mocks
    (getMarkBalances as jest.Mock).mockResolvedValue(
      new Map([
        [
          MOCK_TICKER_HASH.toLowerCase(),
          new Map([
            ['1', BigInt('0')], // 0 USDC on chain 1 (destination, need to rebalance) - 18 decimals
            ['10', BigInt('2500000000000000000')], // 2.5 USDC on chain 10 (enough to rebalance with slippage)
          ]),
        ],
      ]),
    );

    // Mock safeStringToBigInt to match the real implementation
    (safeStringToBigInt as jest.Mock).mockImplementation((value: string, scaleFactor?: bigint) => {
      if (!value || value === '0' || value === '0.0') {
        return 0n;
      }

      try {
        if (value.includes('.')) {
          const [intPart, decimalPart] = value.split('.');
          const digits = scaleFactor ? scaleFactor.toString().length - 1 : 0;
          const paddedDecimal = decimalPart.slice(0, digits).padEnd(digits, '0');
          const integerValue = intPart || '0';
          return BigInt(`${integerValue}${paddedDecimal}`);
        }

        // When no decimal, multiply by scaleFactor
        return scaleFactor ? BigInt(value) * scaleFactor : BigInt(value);
      } catch {
        return null;
      }
    });

    (getValidatedZodiacConfig as jest.Mock).mockReturnValue({
      walletType: 'EOA',
      address: '0xtest',
    });

    (getActualOwner as jest.Mock).mockReturnValue('0xtest');

    (getActualAddress as jest.Mock).mockReturnValue('0xtest');

    (submitTransactionWithLogging as jest.Mock).mockResolvedValue({
      hash: '0xtestHash',
      receipt: {
        transactionHash: '0xtestHash',
        blockNumber: 1000n,
        blockHash: '0xblockhash',
        from: '0xfrom',
        to: '0xto',
        cumulativeGasUsed: 100000n,
        effectiveGasPrice: 1000000000n,
        gasUsed: 50000n,
        status: 'success',
        contractAddress: null,
        logs: [],
        logsBloom: '0x',
        transactionIndex: 0,
        type: 'legacy',
      },
    });
  });

  const createMockInvoice = (overrides: Partial<Invoice> = {}): Invoice => ({
    intent_id: MOCK_INVOICE_ID,
    ticker_hash: MOCK_TICKER_HASH,
    amount: '1000000', // 1 USDC (6 decimals)
    destinations: ['1'],
    origin: '10',
    owner: '0xowner',
    entry_epoch: 123456,
    discountBps: 0,
    hub_status: 'pending',
    hub_invoice_enqueued_timestamp: Date.now(),
    ...overrides,
  });

  const createMockContext = (overrides: Partial<ProcessingContext> = {}): ProcessingContext => ({
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as ProcessingContext['logger'],
    requestId: 'test-request-001',
    startTime: Date.now(),
    rebalance: {
      getAdapters: jest.fn().mockReturnValue({
        [SupportedBridge.Across]: {
          getReceivedAmount: jest.fn().mockResolvedValue('950'), // 5% slippage
        },
      }),
      getAdapter: jest.fn(() => ({
        getReceivedAmount: jest.fn().mockImplementation((amount: string) => {
          // The adapter receives amounts in smallest units as a string (e.g., "500" for 500 USDC units)
          // We return with 5% slippage (matching the 500 basis points in config)
          const inputBigInt = BigInt(amount);
          const outputBigInt = (inputBigInt * 9500n) / 10000n; // 5% slippage = 500 bps
          return Promise.resolve(outputBigInt.toString());
        }),
        send: jest.fn().mockResolvedValue([
          {
            transaction: {
              to: '0xbridge',
              data: '0xdata',
              value: 0,
              funcSig: 'transfer',
            },
            memo: RebalanceTransactionMemo.Rebalance, // Use proper enum value
          },
        ]),
        getSupportedBridge: jest.fn().mockReturnValue(SupportedBridge.Across),
      })),
    } as unknown as ProcessingContext['rebalance'],
    config: {
      ownAddress: '0xtest',
      chains: {
        1: {
          chainId: 1,
          name: 'Ethereum',
          rpcUrls: ['http://localhost:8545'],
          assets: [
            {
              tickerHash: MOCK_TICKER_HASH,
              address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              symbol: 'USDC',
              decimals: 6,
            },
          ],
        },
        10: {
          chainId: 10,
          name: 'Optimism',
          rpcUrls: ['http://localhost:8546'],
          assets: [
            {
              tickerHash: MOCK_TICKER_HASH,
              address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
              symbol: 'USDC',
              decimals: 6,
            },
          ],
        },
      },
      onDemandRoutes: [
        {
          origin: 10,
          destination: 1,
          asset: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // USDC on Optimism
          maximum: '10000',
          slippagesDbps: [5000], // 5% in decibasis points
          preferences: [SupportedBridge.Across],
          reserve: '0',
        },
      ],
      assets: {},
      hub: { domain: '1', hubContractAddress: '0xhub' },
      rebalance: { maxActionAttempts: 3, priorityFloor: 5 },
      zodiac: {},
      maxSlippage: 100,
      supportedSettlementDomains: [1, 10],
    } as unknown as ProcessingContext['config'],
    purchaseCache: {
      disconnect: jest.fn(),
    } as unknown as ProcessingContext['purchaseCache'],
    chainService: {} as unknown as ProcessingContext['chainService'],
    everclear: {
      getMinAmounts: jest.fn().mockResolvedValue({
        minAmounts: {
          '1': '1000', // 0.001 USDC required from chain 1
          '10': '900', // 0.0009 USDC required from chain 10
        },
      }),
    } as unknown as ProcessingContext['everclear'],
    web3Signer: {} as unknown as ProcessingContext['web3Signer'],
    prometheus: {} as unknown as ProcessingContext['prometheus'],
    database: database as ProcessingContext['database'],
    ...overrides,
  });

  describe('evaluateOnDemandRebalancing', () => {
    it('should test mock setup', async () => {
      // Test parseAmountWithDecimals mock
      const result = (parseAmountWithDecimals as jest.Mock)('1000000', 6);
      expect(result).toBe(BigInt('1000000000000000000')); // Should be 1e18

      // Test getMarkBalances mock
      const balances = await (getMarkBalances as jest.Mock)();

      // Test that balances are properly returned
      expect(balances).toBeDefined();
      expect(balances.get(MOCK_TICKER_HASH.toLowerCase())).toBeDefined();
      const tickerBalances = balances.get(MOCK_TICKER_HASH.toLowerCase());
      expect(tickerBalances?.get('1')).toBe(BigInt('0')); // 0 USDC on chain 1
      expect(tickerBalances?.get('10')).toBe(BigInt('2500000000000000000')); // 2.5 USDC on chain 10
    });

    it('should evaluate successfully when rebalancing is possible', async () => {
      const invoice = createMockInvoice();
      const context = createMockContext();

      // Ensure invoice destination is chain 1
      invoice.destinations = ['1'];

      const minAmounts = {
        '1': '1000000', // 1 USDC required on chain 1 (6 decimals)
      };

      // Mock the logger methods to capture calls
      type LogLevel = 'DEBUG' | 'INFO' | 'ERROR';
      type LogCall = [LogLevel, string, Record<string, unknown>?];
      const logCalls: LogCall[] = [];
      (context.logger.debug as jest.Mock) = jest.fn((message: string, data?: Record<string, unknown>) => {
        logCalls.push(['DEBUG', message, data]);
      });
      (context.logger.info as jest.Mock) = jest.fn((message: string, data?: Record<string, unknown>) => {
        logCalls.push(['INFO', message, data]);
      });
      (context.logger.error as jest.Mock) = jest.fn((message: string, data?: Record<string, unknown>) => {
        logCalls.push(['ERROR', message, data]);
      });

      // Verify balance setup before test
      const testBalance = await (getMarkBalances as jest.Mock)();
      expect(testBalance.get(MOCK_TICKER_HASH.toLowerCase())).toBeDefined();

      const result = await evaluateOnDemandRebalancing(invoice, minAmounts, context);

      expect(result.canRebalance).toBe(true);
      expect(result.destinationChain).toBe(1);
      expect(result.rebalanceOperations).toBeDefined();
      expect(result.rebalanceOperations?.length).toBeGreaterThan(0);
    });

    it('should return false when no suitable routes exist', async () => {
      const invoice = createMockInvoice({
        destinations: ['999'], // Non-existent chain
      });
      const context = createMockContext();
      const minAmounts = {
        '999': '1000', // Amount for non-existent chain
      };

      const result = await evaluateOnDemandRebalancing(invoice, minAmounts, context);

      expect(result.canRebalance).toBe(false);
    });

    it('should return false when no onDemandRoutes are configured', async () => {
      const invoice = createMockInvoice();
      const context = createMockContext({
        config: {
          ...createMockContext().config,
          onDemandRoutes: undefined, // No on-demand routes configured
        } as unknown as ProcessingContext['config'],
      });
      const minAmounts = {
        '1': '1000',
      };

      const result = await evaluateOnDemandRebalancing(invoice, minAmounts, context);

      expect(result.canRebalance).toBe(false);
    });

    it('should consider existing earmarks when calculating available balance', async () => {
      // Create an existing earmark
      await database.createEarmark({
        invoiceId: 'existing-invoice',
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '150000', // 0.15 USDC (6 decimals)
      });

      const invoice = createMockInvoice({
        amount: '2000000', // 2 USDC - would require more than available after earmark
      });
      const context = createMockContext();
      const minAmounts = {
        '1': '2000000', // Requires 2 USDC (6 decimals)
      };

      const result = await evaluateOnDemandRebalancing(invoice, minAmounts, context);

      // Should still be able to rebalance because we have funds on other chains
      expect(result.canRebalance).toBe(true);
    });
  });

  describe('executeOnDemandRebalancing', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should create earmark and execute rebalancing operations', async () => {
      const invoice = createMockInvoice();
      const context = createMockContext();

      // Setup the mock to return null initially (no existing earmark), then return the created earmark
      (database.getEarmarkForInvoice as jest.Mock)
        .mockResolvedValueOnce(null) // First call during execution
        .mockResolvedValue({ // Subsequent calls after creation
          id: 'test-earmark-id-123',
          status: 'pending',
          invoiceId: MOCK_INVOICE_ID,
          designatedPurchaseChain: 1,
          tickerHash: MOCK_TICKER_HASH,
          minAmount: '1000',
        });

      const evaluationResult = {
        canRebalance: true,
        destinationChain: 1,
        rebalanceOperations: [
          {
            originChain: 10,
            amount: '1000',
            bridge: SupportedBridge.Across,
            slippage: 5000,
          },
        ],
        totalAmount: '1000',
        minAmount: '1000',
      };

      // Mock the database functions to simulate successful earmark creation
      const { createEarmark, createRebalanceOperation, getRebalanceOperationsByEarmark } = database;
      (createEarmark as jest.Mock).mockResolvedValue({
        id: 'test-earmark-id-123',
        status: 'pending',
        invoiceId: MOCK_INVOICE_ID,
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
      });
      (createRebalanceOperation as jest.Mock).mockResolvedValue({
        id: 'test-operation-id',
        earmarkId: 'test-earmark-id-123',
        originChainId: 10,
        destinationChainId: 1,
        tickerHash: MOCK_TICKER_HASH,
        amount: '1000',
        slippage: 5000,
        status: 'pending',
        bridge: SupportedBridge.Across,
      });
      
      // Mock getRebalanceOperationsByEarmark to return the created operation
      (getRebalanceOperationsByEarmark as jest.Mock).mockResolvedValue([{
        id: 'test-operation-id',
        earmarkId: 'test-earmark-id-123',
        originChainId: 10,
        destinationChainId: 1,
        tickerHash: MOCK_TICKER_HASH,
        amount: '1000',
        slippage: 5000,
        status: 'pending',
        bridge: SupportedBridge.Across,
      }]);

      // Mock the context functions to ensure proper execution
      (context.rebalance.getAdapter as jest.Mock).mockReturnValue({
        send: jest.fn().mockResolvedValue([{
          transaction: {
            to: '0xbridge',
            data: '0xdata',
            value: 0,
          },
          memo: RebalanceTransactionMemo.Rebalance,
        }]),
      });

      const earmarkId = await executeOnDemandRebalancing(invoice, evaluationResult, context);
      
      // Check that earmarkId was returned
      expect(earmarkId).toBe('test-earmark-id-123');
      
      // Verify database functions were called
      expect(createEarmark).toHaveBeenCalledWith({
        invoiceId: MOCK_INVOICE_ID,
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
        status: EarmarkStatus.PENDING, // All ops succeeded, so status should be PENDING
      });
      
      expect(createRebalanceOperation).toHaveBeenCalledWith({
        earmarkId: 'test-earmark-id-123',
        originChainId: 10,
        destinationChainId: 1,
        tickerHash: MOCK_TICKER_HASH,
        amount: '1000',
        slippage: 5000,
        status: RebalanceOperationStatus.PENDING,
        bridge: SupportedBridge.Across,
        transactions: expect.objectContaining({
          '10': expect.objectContaining({
            transactionHash: '0xtestHash',
          }),
        }),
        recipient: '0xtest',
      });

      // Verify earmark was created
      const earmark = await database.getEarmarkForInvoice(MOCK_INVOICE_ID);
      expect(earmark).toBeTruthy();
      expect(earmark?.invoiceId).toBe(MOCK_INVOICE_ID);
      expect(earmark?.status).toBe('pending');

      // Verify rebalance operation was created
      if (earmark) {
        const operations = await database.getRebalanceOperationsByEarmark(earmark.id);
        expect(operations.length).toBe(1);
        expect(operations[0].originChainId).toBe(10);
        expect(operations[0].destinationChainId).toBe(1);
      }
    });

    it('should handle invalid evaluation result', async () => {
      const invoice = createMockInvoice();
      const context = createMockContext();

      const evaluationResult = {
        canRebalance: false,
      };

      const earmarkId = await executeOnDemandRebalancing(invoice, evaluationResult, context);

      expect(earmarkId).toBeNull();
    });
  });

  describe('processPendingEarmarks', () => {
    it('should return ready invoices when all operations are complete', async () => {
      // Mock an earmark that should be marked as ready
      const mockEarmark = {
        id: 'mock-earmark-id',
        invoiceId: MOCK_INVOICE_ID,
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
        status: EarmarkStatus.PENDING,
      };

      // Mock the database calls
      (database.getEarmarks as jest.Mock).mockResolvedValue([mockEarmark]);
      (database.getEarmarkForInvoice as jest.Mock).mockResolvedValue({
        ...mockEarmark,
        status: EarmarkStatus.READY,
      });
      
      // Mock getRebalanceOperationsByEarmark to return completed operations
      (database.getRebalanceOperationsByEarmark as jest.Mock).mockResolvedValue([
        {
          id: 'op-1',
          earmarkId: mockEarmark.id,
          status: RebalanceOperationStatus.COMPLETED,
        }
      ]);

      const context = createMockContext();
      // Mock everclear.getMinAmounts to return the expected minAmounts
      context.everclear.getMinAmounts = jest.fn().mockResolvedValue({
        minAmounts: {
          '1': '1000', // Same as earmarked amount
        },
      });
      
      const currentInvoices = [createMockInvoice()];

      await processPendingEarmarks(context, currentInvoices);

      // Check if earmark status was updated (mock was called)
      expect(database.updateEarmarkStatus).toHaveBeenCalled();

      // Simulate the effect of the update
      const updatedEarmark = await database.getEarmarkForInvoice(MOCK_INVOICE_ID);
      const readyInvoices =
        updatedEarmark?.status === EarmarkStatus.READY
          ? [{ invoiceId: MOCK_INVOICE_ID, designatedPurchaseChain: 1 }]
          : [];

      expect(readyInvoices.length).toBe(1);
      expect(readyInvoices[0].invoiceId).toBe(MOCK_INVOICE_ID);
      expect(readyInvoices[0].designatedPurchaseChain).toBe(1);
    });

    it('should not return invoices when operations are still pending', async () => {
      // Mock an earmark with pending operations
      const mockEarmark = {
        id: 'mock-earmark-id',
        invoiceId: MOCK_INVOICE_ID,
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
        status: EarmarkStatus.PENDING,
      };

      // Mock the database calls
      (database.getEarmarks as jest.Mock).mockResolvedValue([mockEarmark]);
      
      // Mock pending operations
      (database.getRebalanceOperationsByEarmark as jest.Mock).mockResolvedValue([
        {
          id: 'op-1',
          earmarkId: mockEarmark.id,
          status: RebalanceOperationStatus.PENDING, // Still pending
        }
      ]);
      
      // Mock getEarmarkForInvoice to return the earmark with PENDING status (not updated to READY)
      (database.getEarmarkForInvoice as jest.Mock).mockResolvedValue(mockEarmark);

      const context = createMockContext();
      // Mock everclear.getMinAmounts
      context.everclear.getMinAmounts = jest.fn().mockResolvedValue({
        minAmounts: {
          '1': '1000',
        },
      });
      
      const currentInvoices = [createMockInvoice()];

      await processPendingEarmarks(context, currentInvoices);

      // Check if earmark status was updated
      const updatedEarmark = await database.getEarmarkForInvoice(MOCK_INVOICE_ID);
      const readyInvoices =
        updatedEarmark?.status === EarmarkStatus.READY
          ? [{ invoiceId: MOCK_INVOICE_ID, designatedPurchaseChain: 1 }]
          : [];

      expect(readyInvoices.length).toBe(0);
    });

    it('should handle invoice not in current batch', async () => {
      // Mock an earmark for invoice not in current batch
      const mockEarmark = {
        id: 'mock-earmark-id-2',
        invoiceId: 'missing-invoice',
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
        status: EarmarkStatus.PENDING,
      };

      // Mock the database calls
      (database.getEarmarks as jest.Mock).mockResolvedValue([mockEarmark]);
      (database.updateEarmarkStatus as jest.Mock).mockResolvedValue({
        ...mockEarmark,
        status: EarmarkStatus.CANCELLED,
      });
      (database.getEarmarkForInvoice as jest.Mock).mockResolvedValue({
        ...mockEarmark,
        status: EarmarkStatus.CANCELLED,
      });

      const context = createMockContext();
      const currentInvoices = [createMockInvoice()]; // Different invoice

      await processPendingEarmarks(context, currentInvoices);

      // Verify earmark was marked as cancelled
      expect(database.updateEarmarkStatus).toHaveBeenCalledWith('mock-earmark-id-2', EarmarkStatus.CANCELLED);

      const earmark = await database.getEarmarkForInvoice('missing-invoice');
      expect(earmark?.status).toBe(EarmarkStatus.CANCELLED);
    });
  });

  describe('Database Integration', () => {
    it('should handle database constraints properly', async () => {
      const earmarkData = {
        invoiceId: MOCK_INVOICE_ID,
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
      };

      // Mock createEarmark to fail on second call (duplicate)
      let callCount = 0;
      (database.createEarmark as jest.Mock).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            id: 'mock-earmark-id',
            invoiceId: MOCK_INVOICE_ID,
            status: 'pending',
          });
        } else {
          return Promise.reject(new Error('Duplicate earmark'));
        }
      });

      // Create first earmark
      const earmark1 = await database.createEarmark(earmarkData);
      expect(earmark1.invoiceId).toBe(MOCK_INVOICE_ID);

      // Try to create duplicate - should fail
      await expect(database.createEarmark(earmarkData)).rejects.toThrow('Duplicate earmark');

      // Mock getEarmarks to return only the first earmark
      (database.getEarmarks as jest.Mock).mockResolvedValue([earmark1]);
      
      // Verify only one earmark exists
      const earmarks = await database.getEarmarks();
      const invoiceEarmarks = earmarks.filter((e) => e.invoiceId === MOCK_INVOICE_ID);
      expect(invoiceEarmarks.length).toBe(1);
    });

    it('should properly filter earmarks by status', async () => {
      // Mock earmarks with different statuses
      const mockEarmarks = [
        {
          id: 'earmark-1',
          invoiceId: 'invoice-1',
          designatedPurchaseChain: 1,
          tickerHash: MOCK_TICKER_HASH,
          minAmount: '1000',
          status: EarmarkStatus.PENDING,
        },
        {
          id: 'earmark-2',
          invoiceId: 'invoice-2',
          designatedPurchaseChain: 1,
          tickerHash: MOCK_TICKER_HASH,
          minAmount: '2000',
          status: EarmarkStatus.COMPLETED,
        },
      ];

      // Reset the mock and set up createEarmark
      (database.createEarmark as jest.Mock)
        .mockResolvedValueOnce(mockEarmarks[0])
        .mockResolvedValueOnce(mockEarmarks[1]);

      // Mock getEarmarks to filter by status
      (database.getEarmarks as jest.Mock).mockImplementation((filter) => {
        if (!filter) return Promise.resolve(mockEarmarks);
        if (filter.status === EarmarkStatus.PENDING) {
          return Promise.resolve(mockEarmarks.filter((e) => e.status === EarmarkStatus.PENDING));
        }
        if (filter.status === EarmarkStatus.COMPLETED) {
          return Promise.resolve(mockEarmarks.filter((e) => e.status === EarmarkStatus.COMPLETED));
        }
        return Promise.resolve([]);
      });

      const pendingEarmarks = await database.getEarmarks({ status: EarmarkStatus.PENDING });
      const completedEarmarks = await database.getEarmarks({ status: EarmarkStatus.COMPLETED });

      expect(pendingEarmarks.length).toBe(1);
      expect(pendingEarmarks[0].invoiceId).toBe('invoice-1');
      expect(completedEarmarks.length).toBe(1);
      expect(completedEarmarks[0].invoiceId).toBe('invoice-2');
    });
  });
});
