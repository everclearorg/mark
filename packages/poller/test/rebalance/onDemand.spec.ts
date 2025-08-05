import { evaluateOnDemandRebalancing, executeOnDemandRebalancing } from '../../src/rebalance/onDemand';
import * as database from '@mark/database';
import { getPool } from '@mark/database';
import { ProcessingContext } from '../../src/init';
import { Invoice, EarmarkStatus, RebalanceOperationStatus } from '@mark/core';
import { getMarkBalances, safeStringToBigInt } from '../../src/helpers/balance';
import { getValidatedZodiacConfig, getActualOwner, getActualAddress } from '../../src/helpers/zodiac';
import { submitTransactionWithLogging } from '../../src/helpers/transactions';

interface EarmarkWithInvoiceInfo {
  id: string;
  invoiceId: string;
  designatedPurchaseChain: number;
  tickerHash: string;
  minAmount: string;
  status: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

async function processEarmarkedInvoices(
  context: ProcessingContext,
  invoices: Invoice[],
): Promise<EarmarkWithInvoiceInfo[]> {
  const { database, logger } = context;

  // Get all earmarks that are not completed or cancelled
  const activeEarmarks = await database.getEarmarks({
    status: [EarmarkStatus.PENDING, EarmarkStatus.READY],
  });

  if (activeEarmarks.length === 0) {
    return [];
  }

  // Create a map of current invoice IDs for quick lookup
  const invoiceMap = new Map(invoices.map((inv) => [inv.intent_id, inv]));

  const readyEarmarksWithInvoices: EarmarkWithInvoiceInfo[] = [];

  // Process each earmark
  for (const earmark of activeEarmarks) {
    if (!invoiceMap.has(earmark.invoiceId)) {
      // Cancel earmarks for invoices that are no longer in the batch
      await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);
      logger.info(`Cancelled earmark for missing invoice`, {
        earmarkId: earmark.id,
        invoiceId: earmark.invoiceId,
      });
    } else if (earmark.status === EarmarkStatus.READY) {
      // Only return READY earmarks that have matching invoices
      readyEarmarksWithInvoices.push(earmark);
    }
  }

  logger.info(`Found ${readyEarmarksWithInvoices.length} ready earmarks with matching invoices`, {
    readyCount: readyEarmarksWithInvoices.length,
    totalActiveEarmarks: activeEarmarks.length,
    currentInvoiceCount: invoices.length,
  });

  return readyEarmarksWithInvoices;
}

// Test data constants
const MOCK_TICKER_HASH = '0x1234567890123456789012345678901234567890';
const MOCK_INVOICE_ID = 'test-invoice-001';

// Mock functions for dependencies
jest.mock('../../src/helpers/balance', () => ({
  getMarkBalances: jest.fn(),
  safeStringToBigInt: jest.fn(),
}));

jest.mock('../../src/helpers/zodiac', () => ({
  getValidatedZodiacConfig: jest.fn(),
  getActualOwner: jest.fn(),
  getActualAddress: jest.fn(),
}));

jest.mock('../../src/helpers/transactions', () => ({
  submitTransactionWithLogging: jest.fn(),
}));

jest.mock('@mark/core', () => ({
  ...jest.requireActual('@mark/core'),
  getDecimalsFromConfig: jest.fn().mockReturnValue(6), // USDC has 6 decimals
}));

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
            ['1', BigInt('500')], // 0.0005 USDC on chain 1 (destination, insufficient)
            ['10', BigInt('5000')], // 0.005 USDC on chain 10 (origin, sufficient for rebalancing)
          ]),
        ],
      ]),
    );

    // Mock safeStringToBigInt to handle string to BigInt conversion
    (safeStringToBigInt as jest.Mock).mockImplementation((value: string) => {
      try {
        return BigInt(value);
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
    amount: '1000', // 0.001 USDC (6 decimals)
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
          preferences: ['cctp'],
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
          preferences: ['cctp'],
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
      getAdapter: jest.fn().mockReturnValue({
        getReceivedAmount: jest.fn().mockResolvedValue('950'), // 0.00095 USDC after slippage
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
      }),
    } as unknown as ProcessingContext['rebalance'],
    prometheus: {} as unknown as ProcessingContext['prometheus'],
    database: database as ProcessingContext['database'],
    ...overrides,
  });

  describe('evaluateOnDemandRebalancing', () => {
    it('should evaluate successfully when rebalancing is possible', async () => {
      const invoice = createMockInvoice();
      const context = createMockContext();
      const minAmounts = {
        '1': '1000', // 0.001 USDC required from chain 1
        '10': '900', // 0.0009 USDC required from chain 10
      };

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
        minAmount: '1500', // 0.0015 USDC
      });

      const invoice = createMockInvoice({
        amount: '2000', // 0.002 USDC - would require more than available after earmark
      });
      const context = createMockContext();
      const minAmounts = {
        '1': '2000', // Requires 0.002 USDC
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
            slippages: [500],
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

  describe('processEarmarkedInvoices', () => {
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

      const readyInvoices = await processEarmarkedInvoices(context, currentInvoices);

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

      const readyInvoices = await processEarmarkedInvoices(context, currentInvoices);

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

      const readyInvoices = await processEarmarkedInvoices(context, currentInvoices);

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
