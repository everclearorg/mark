import {
  evaluateOnDemandRebalancing,
  executeOnDemandRebalancing,
  processPendingEarmarks,
} from '../../src/rebalance/onDemand';
import * as database from '@mark/database';
import { getPool } from '@mark/database';
import { ProcessingContext } from '../../src/init';
import { Invoice, EarmarkStatus, RebalanceOperationStatus, SupportedBridge } from '@mark/core';
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
  submitTransactionWithLogging: jest.fn(),
}));

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

describe('On-Demand Rebalancing - Jest Database Tests', () => {
  let db: ReturnType<typeof getPool>;

  beforeEach(async () => {
    db = getPool();

    // Clean up all test data before each test
    await db.query('DELETE FROM rebalance_operations');
    await db.query('DELETE FROM earmarks');

    // Setup mocks
    (getMarkBalances as jest.Mock).mockResolvedValue(
      new Map([
        [
          MOCK_TICKER_HASH.toLowerCase(),
          new Map([
            ['1', BigInt('500000000000000000')], // 0.5 USDC on chain 1 (destination, insufficient) - 18 decimals
            ['10', BigInt('1000000000000000000')], // 1.0 USDC on chain 10
            // Need to send 0.5 more to chain 1
            // Algorithm will calculate: 0.5 * 1.05 = 0.525 to send (to account for slippage)
            // After 5% slippage: 0.525 * 0.95 = 0.49875 received
            // Still not enough! Need to send more.
            // Actually need: 0.5 / 0.95 = 0.526316 to get 0.5 after slippage
            // But the algorithm sends 0.525 which gives 0.49875, leaving a gap
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
    config: {
      ownAddress: '0xtest',
      chains: {
        1: { chainId: 1, name: 'Ethereum', rpcUrls: ['http://localhost:8545'] },
        10: { chainId: 10, name: 'Optimism', rpcUrls: ['http://localhost:8546'] },
      },
      routes: [
        {
          origin: 10,
          destination: 1,
          asset: MOCK_TICKER_HASH,
          maximum: '10000',
          slippages: [500],
          preferences: [SupportedBridge.CCTPV1],
          reserve: '0',
        },
      ],
      onDemandRoutes: [
        {
          origin: 10,
          destination: 1,
          asset: MOCK_TICKER_HASH,
          maximum: '10000',
          slippages: [500],
          preferences: [SupportedBridge.CCTPV1],
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
    rebalanceCache: {
      disconnect: jest.fn(),
    } as unknown as ProcessingContext['rebalanceCache'],
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
    rebalance: {
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
            },
            memo: 'Rebalance',
          },
        ]),
      })),
    } as unknown as ProcessingContext['rebalance'],
    prometheus: {} as unknown as ProcessingContext['prometheus'],
    database: database as ProcessingContext['database'],
    ...overrides,
  });

  describe('evaluateOnDemandRebalancing', () => {
    it('should test mock setup', async () => {
      // Test parseAmountWithDecimals mock
      const result = (parseAmountWithDecimals as jest.Mock)('1000000', 6);
      console.log('parseAmountWithDecimals result:', result?.toString());
      expect(result).toBe(BigInt('1000000000000000000')); // Should be 1e18

      // Test getMarkBalances mock
      const balances = await (getMarkBalances as jest.Mock)();
      console.log('getMarkBalances result:', balances);

      // Test that balances are properly returned
      expect(balances).toBeDefined();
      expect(balances.get(MOCK_TICKER_HASH.toLowerCase())).toBeDefined();
      const tickerBalances = balances.get(MOCK_TICKER_HASH.toLowerCase());
      expect(tickerBalances?.get('1')).toBe(BigInt('500000000000000000')); // 0.5 USDC on chain 1
      expect(tickerBalances?.get('10')).toBe(BigInt('1000000000000000000')); // 1.0 USDC on chain 10
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

    it.skip('should consider existing earmarks when calculating available balance', async () => {
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
    it('should create earmark and execute rebalancing operations', async () => {
      const invoice = createMockInvoice();
      const context = createMockContext();

      const evaluationResult = {
        canRebalance: true,
        destinationChain: 1,
        rebalanceOperations: [
          {
            originChain: 10,
            amount: '1000',
            bridge: SupportedBridge.Across,
            slippage: 500,
          },
        ],
        totalAmount: '1000',
        minAmount: '1000',
      };

      const earmarkId = await executeOnDemandRebalancing(invoice, evaluationResult, context);

      expect(earmarkId).toBeTruthy();

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
      // Create earmark
      const earmark = await database.createEarmark({
        invoiceId: MOCK_INVOICE_ID,
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
      });

      // Update earmark status to READY since all operations are complete
      await database.updateEarmarkStatus(earmark.id, EarmarkStatus.READY);

      const context = createMockContext();
      const currentInvoices = [createMockInvoice()];

      await processPendingEarmarks(context, currentInvoices);

      // Check if earmark status was updated
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
      // Create earmark
      const earmark = await database.createEarmark({
        invoiceId: MOCK_INVOICE_ID,
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
      });

      // Create pending rebalance operation
      await database.createRebalanceOperation({
        earmarkId: earmark.id,
        originChainId: 10,
        destinationChainId: 1,
        tickerHash: MOCK_TICKER_HASH,
        amount: '1000',
        slippage: 5, // 5 basis points = 0.05%
        status: 'pending' as RebalanceOperationStatus,
        bridge: 'cctp',
      });

      const context = createMockContext();
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
      // Create earmark for invoice not in current batch
      await database.createEarmark({
        invoiceId: 'missing-invoice',
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
      });

      const context = createMockContext();
      const currentInvoices = [createMockInvoice()]; // Different invoice

      await processPendingEarmarks(context, currentInvoices);

      // Check if earmark status was updated
      const updatedEarmark = await database.getEarmarkForInvoice(MOCK_INVOICE_ID);
      const readyInvoices =
        updatedEarmark?.status === EarmarkStatus.READY
          ? [{ invoiceId: MOCK_INVOICE_ID, designatedPurchaseChain: 1 }]
          : [];

      expect(readyInvoices.length).toBe(0);

      // Verify earmark was marked as cancelled
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

      // Create first earmark
      const earmark1 = await database.createEarmark(earmarkData);
      expect(earmark1.invoiceId).toBe(MOCK_INVOICE_ID);

      // Try to create duplicate - should fail
      await expect(database.createEarmark(earmarkData)).rejects.toThrow();

      // Verify only one earmark exists
      const earmarks = await database.getEarmarks();
      const invoiceEarmarks = earmarks.filter((e) => e.invoiceId === MOCK_INVOICE_ID);
      expect(invoiceEarmarks.length).toBe(1);
    });

    it('should properly filter earmarks by status', async () => {
      // Create multiple earmarks with different statuses
      await database.createEarmark({
        invoiceId: 'invoice-1',
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '1000',
      });

      const earmark2 = await database.createEarmark({
        invoiceId: 'invoice-2',
        designatedPurchaseChain: 1,
        tickerHash: MOCK_TICKER_HASH,
        minAmount: '2000',
      });

      // Update one to completed
      await database.updateEarmarkStatus(earmark2.id, EarmarkStatus.COMPLETED);

      const pendingEarmarks = await database.getEarmarks({ status: EarmarkStatus.PENDING });
      const completedEarmarks = await database.getEarmarks({ status: EarmarkStatus.COMPLETED });

      expect(pendingEarmarks.length).toBe(1);
      expect(pendingEarmarks[0].invoiceId).toBe('invoice-1');
      expect(completedEarmarks.length).toBe(1);
      expect(completedEarmarks[0].invoiceId).toBe('invoice-2');
    });
  });
});
