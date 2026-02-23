import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventProcessor } from '#/processor';
import { QueuedEvent, EventPriority } from '#/queue';
import { ProcessingContext } from '@mark/poller/src/init';
import {
  Invoice,
  WebhookEventType,
  InvoiceEnqueuedEvent,
  SettlementEnqueuedEvent,
  InvalidPurchaseReasons,
  TransactionSubmissionType,
  MarkConfiguration,
  EarmarkStatus,
} from '@mark/core';
import { EventProcessingResultType } from '#/processor';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { PurchaseCache, PurchaseAction } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';

// Mock helper modules
jest.mock('#/helpers', () => ({
  processPendingEarmark: jest.fn(),
  getTimeSeconds: jest.fn(() => Math.floor(Date.now() / 1000)),
  splitAndSendIntents: jest.fn(),
}));

jest.mock('@mark/poller/src/helpers', () => ({
  getMarkBalances: jest.fn(),
  getCustodiedBalances: jest.fn(),
  getSupportedDomainsForTicker: jest.fn(),
  isXerc20Supported: jest.fn(),
}));

jest.mock('@mark/poller/src/invoice/validation', () => ({
  isValidInvoice: jest.fn(),
}));

jest.mock('@mark/poller/src/rebalance/onDemand', () => ({
  cleanupStaleEarmarks: jest.fn(),
  cleanupCompletedEarmarks: jest.fn(),
}));

describe('EventProcessor', () => {
  let eventProcessor: EventProcessor;
  let mockProcessingContext: ProcessingContext;
  let mockEverclear: jest.Mocked<EverclearAdapter>;
  let mockChainService: jest.Mocked<ChainService>;
  let mockPurchaseCache: jest.Mocked<PurchaseCache>;
  let mockPrometheus: jest.Mocked<PrometheusAdapter>;
  let mockDatabase: jest.Mocked<any>;
  let mockLogger: jest.Mocked<Logger>;
  let mockConfig: MarkConfiguration;

  beforeEach(() => {
    jest.clearAllMocks();

    mockEverclear = {
      fetchInvoiceById: jest.fn(),
      getMinAmounts: jest.fn(),
      fetchEconomyData: jest.fn(),
    } as any;

    mockChainService = {} as any;

    mockPurchaseCache = {
      isPaused: jest.fn(),
      getPurchases: jest.fn(),
      addPurchases: jest.fn(),
      removePurchases: jest.fn(),
    } as any;

    mockPrometheus = {
      recordInvalidPurchase: jest.fn(),
      recordPurchaseClearanceDuration: jest.fn(),
    } as any;

    mockDatabase = {
      getEarmarks: jest.fn(),
    } as any;

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockConfig = {
      chains: {},
      logLevel: 'debug',
    } as any;

    mockProcessingContext = {
      config: mockConfig,
      everclear: mockEverclear,
      chainService: mockChainService,
      purchaseCache: mockPurchaseCache,
      prometheus: mockPrometheus,
      database: mockDatabase,
      logger: mockLogger,
      requestId: 'test-request-id',
      startTime: Math.floor(Date.now() / 1000),
    } as any;

    eventProcessor = new EventProcessor(mockProcessingContext);
  });

  describe('processInvoiceEnqueued', () => {
    const createInvoiceEvent = (invoiceId: string): QueuedEvent => ({
      id: invoiceId,
      type: WebhookEventType.InvoiceEnqueued,
      data: {
        id: invoiceId,
        invoice: {
          id: invoiceId,
          intent: {
            id: invoiceId,
            queueIdx: '0',
            status: 'ADDED',
            initiator: '',
            receiver: '',
            inputAsset: '',
            outputAsset: '',
            maxFee: '0',
            origin: '',
            nonce: '0',
            timestamp: '0',
            ttl: '0',
            amount: '0',
            destinations: [],
            data: '',
          },
          tickerHash: '',
          amount: '0',
          owner: '',
          entryEpoch: '0',
        },
        transactionHash: '',
        timestamp: '0',
        gasPrice: '0',
        gasLimit: '0',
        blockNumber: '0',
        txOrigin: '',
        txNonce: '0',
      } as InvoiceEnqueuedEvent,
      priority: EventPriority.NORMAL,
      retryCount: 0,
      maxRetries: -1,
      scheduledAt: Date.now(),
      metadata: { source: 'test' },
    });

    const createMockInvoice = (overrides?: Partial<Invoice>): Invoice => ({
      intent_id: 'invoice-1',
      amount: '1000',
      owner: '0x123',
      entry_epoch: 1,
      origin: '1',
      destinations: ['2'],
      ticker_hash: '0xabc',
      discountBps: 0,
      hub_status: 'INVOICED',
      hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000),
      ...overrides,
    });

    it('should process invoice successfully', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();

      const { processPendingEarmark, splitAndSendIntents } = require('#/helpers');
      const { getMarkBalances, getCustodiedBalances, getSupportedDomainsForTicker, isXerc20Supported } =
        require('@mark/poller/src/helpers');
      const { isValidInvoice } = require('@mark/poller/src/invoice/validation');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0', '2': '0' },
        minAmounts: { '1': '100', '2': '200' },
      });
      mockPurchaseCache.isPaused.mockResolvedValue(false);
      mockPurchaseCache.getPurchases.mockResolvedValue([]);
      mockDatabase.getEarmarks.mockResolvedValue([]);
      processPendingEarmark.mockResolvedValue(undefined);
      isValidInvoice.mockReturnValue(null);
      isXerc20Supported.mockResolvedValue(false);
      getMarkBalances.mockResolvedValue(new Map());
      getCustodiedBalances.mockResolvedValue(new Map());
      getSupportedDomainsForTicker.mockReturnValue(['1', '2']);
      mockEverclear.fetchEconomyData.mockResolvedValue({
        currentEpoch: {
          epoch: 1,
          startBlock: 100,
          endBlock: 200,
        },
        incomingIntents: {},
      });
      splitAndSendIntents.mockResolvedValue([
        {
          target: invoice,
          purchase: {
            intentId: 'intent-1',
            params: {
              origin: '1',
              destinations: ['2'],
              to: '0x123',
              inputAsset: '0xabc',
              amount: '1000',
              callData: '0x',
              maxFee: '0',
            },
          },
          transactionHash: '0xtxhash',
          transactionType: TransactionSubmissionType.Onchain,
          cachedAt: Math.floor(Date.now() / 1000),
        },
      ]);
      mockPurchaseCache.addPurchases.mockResolvedValue(1);

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Success);
      expect(result.eventId).toBe('invoice-1');
      expect(mockEverclear.fetchInvoiceById).toHaveBeenCalledWith('invoice-1');
      expect(mockEverclear.getMinAmounts).toHaveBeenCalledWith('invoice-1');
      expect(splitAndSendIntents).toHaveBeenCalled();
      expect(mockPurchaseCache.addPurchases).toHaveBeenCalled();
    });

    it('should handle invoice not found', async () => {
      const event = createInvoiceEvent('invoice-1');
      const { cleanupStaleEarmarks } = require('@mark/poller/src/rebalance/onDemand');

      mockEverclear.fetchInvoiceById.mockRejectedValue(new Error('Not found'));

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Success);
      expect(cleanupStaleEarmarks).toHaveBeenCalledWith(['invoice-1'], mockProcessingContext);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Invoice not found',
        expect.objectContaining({
          invoiceId: 'invoice-1',
        }),
      );
    });

    it('should handle getMinAmounts failure', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockRejectedValue(new Error('API error'));

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.retryAfter).toBe(60000);
      expect(mockPrometheus.recordInvalidPurchase).toHaveBeenCalledWith(
        InvalidPurchaseReasons.TransactionFailed,
        expect.any(Object),
      );
    });

    it('should skip invoice if purchase cache is paused', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { processPendingEarmark } = require('#/helpers');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0' },
        minAmounts: { '1': '100' },
      });
      mockPurchaseCache.isPaused.mockResolvedValue(true);
      processPendingEarmark.mockResolvedValue(undefined);
      mockDatabase.getEarmarks.mockResolvedValue([]);

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.retryAfter).toBe(60000);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Purchase loop is paused, skipping invoice',
        expect.objectContaining({
          invoiceId: 'invoice-1',
        }),
      );
    });

    it('should skip invalid invoice and return invalid for permanent reasons', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { isValidInvoice } = require('@mark/poller/src/invoice/validation');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      isValidInvoice.mockReturnValue(InvalidPurchaseReasons.InvalidAmount);

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Invalid);
      expect(mockPrometheus.recordInvalidPurchase).toHaveBeenCalledWith(
        InvalidPurchaseReasons.InvalidAmount,
        expect.any(Object),
      );
      expect(mockEverclear.getMinAmounts).not.toHaveBeenCalled();
    });

    it('should skip invalid invoice but not return invalid for transient reasons (InvalidAge)', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { isValidInvoice } = require('@mark/poller/src/invoice/validation');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      isValidInvoice.mockReturnValue(InvalidPurchaseReasons.InvalidAge);

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(mockPrometheus.recordInvalidPurchase).toHaveBeenCalledWith(
        InvalidPurchaseReasons.InvalidAge,
        expect.any(Object),
      );
    });

    it('should skip invoice with XERC20 support and return invalid', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { isXerc20Supported } = require('@mark/poller/src/helpers');
      const { isValidInvoice } = require('@mark/poller/src/invoice/validation');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      isValidInvoice.mockReturnValue(null);
      isXerc20Supported.mockResolvedValue(true);

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Invalid);
      expect(mockPrometheus.recordInvalidPurchase).toHaveBeenCalledWith(
        InvalidPurchaseReasons.DestinationXerc20,
        expect.any(Object),
      );
      expect(mockEverclear.getMinAmounts).not.toHaveBeenCalled();
    });

    it('should skip invoice if purchase already exists', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { processPendingEarmark, splitAndSendIntents } = require('#/helpers');
      const { getMarkBalances, getCustodiedBalances, getSupportedDomainsForTicker, isXerc20Supported } =
        require('@mark/poller/src/helpers');
      const { isValidInvoice } = require('@mark/poller/src/invoice/validation');

      const existingPurchase: PurchaseAction = {
        target: invoice,
        purchase: {
          intentId: 'intent-1',
          params: {
            origin: '1',
            destinations: ['2'],
            to: '0x123',
            inputAsset: '0xabc',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
          },
        },
        transactionHash: '0xtxhash',
        transactionType: TransactionSubmissionType.Onchain,
        cachedAt: Math.floor(Date.now() / 1000),
      };

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0' },
        minAmounts: { '1': '100' },
      });
      mockPurchaseCache.isPaused.mockResolvedValue(false);
      mockPurchaseCache.getPurchases.mockResolvedValue([existingPurchase]);
      processPendingEarmark.mockResolvedValue(undefined);
      mockDatabase.getEarmarks.mockResolvedValue([]);
      isValidInvoice.mockReturnValue(null);
      isXerc20Supported.mockResolvedValue(false);
      getMarkBalances.mockResolvedValue(new Map());
      getCustodiedBalances.mockResolvedValue(new Map());
      getSupportedDomainsForTicker.mockReturnValue(['1']);
      mockEverclear.fetchEconomyData.mockResolvedValue({
        currentEpoch: {
          epoch: 1,
          startBlock: 100,
          endBlock: 200,
        },
        incomingIntents: {},
      });

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Success);
      expect(mockPrometheus.recordInvalidPurchase).toHaveBeenCalledWith(
        InvalidPurchaseReasons.PendingPurchaseRecord,
        expect.any(Object),
      );
      expect(splitAndSendIntents).not.toHaveBeenCalled();
    });

    it('should retry if no purchases generated', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { processPendingEarmark, splitAndSendIntents } = require('#/helpers');
      const { getMarkBalances, getCustodiedBalances, getSupportedDomainsForTicker, isXerc20Supported } =
        require('@mark/poller/src/helpers');
      const { isValidInvoice } = require('@mark/poller/src/invoice/validation');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0' },
        minAmounts: { '1': '100' },
      });
      mockPurchaseCache.isPaused.mockResolvedValue(false);
      mockPurchaseCache.getPurchases.mockResolvedValue([]);
      processPendingEarmark.mockResolvedValue(undefined);
      mockDatabase.getEarmarks.mockResolvedValue([]);
      isValidInvoice.mockReturnValue(null);
      isXerc20Supported.mockResolvedValue(false);
      getMarkBalances.mockResolvedValue(new Map());
      getCustodiedBalances.mockResolvedValue(new Map());
      getSupportedDomainsForTicker.mockReturnValue(['1']);
      mockEverclear.fetchEconomyData.mockResolvedValue({
        currentEpoch: {
          epoch: 1,
          startBlock: 100,
          endBlock: 200,
        },
        incomingIntents: {},
      });
      splitAndSendIntents.mockResolvedValue([]);

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.retryAfter).toBe(10000);
    });

    it('should skip invoice with pending earmark', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { processPendingEarmark } = require('#/helpers');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0' },
        minAmounts: { '1': '100' },
      });
      processPendingEarmark.mockResolvedValue(undefined);
      mockDatabase.getEarmarks.mockResolvedValue([
        {
          id: 'earmark-1',
          invoiceId: 'invoice-1',
          status: EarmarkStatus.PENDING,
          designatedPurchaseChain: 1,
        },
      ]);

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.retryAfter).toBe(10000);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipping invoice with pending earmark',
        expect.objectContaining({
          invoiceId: 'invoice-1',
        }),
      );
    });

    it('should handle processing errors', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { processPendingEarmark, splitAndSendIntents } = require('#/helpers');
      const { getMarkBalances, getCustodiedBalances, getSupportedDomainsForTicker, isXerc20Supported } =
        require('@mark/poller/src/helpers');
      const { isValidInvoice } = require('@mark/poller/src/invoice/validation');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0' },
        minAmounts: { '1': '100' },
      });
      mockPurchaseCache.isPaused.mockResolvedValue(false);
      mockPurchaseCache.getPurchases.mockResolvedValue([]);
      processPendingEarmark.mockResolvedValue(undefined);
      mockDatabase.getEarmarks.mockResolvedValue([]);
      isValidInvoice.mockReturnValue(null);
      isXerc20Supported.mockResolvedValue(false);
      getMarkBalances.mockResolvedValue(new Map());
      getCustodiedBalances.mockResolvedValue(new Map());
      getSupportedDomainsForTicker.mockReturnValue(['1']);
      mockEverclear.fetchEconomyData.mockResolvedValue({
        currentEpoch: {
          epoch: 1,
          startBlock: 100,
          endBlock: 200,
        },
        incomingIntents: {},
      });
      splitAndSendIntents.mockRejectedValue(new Error('Unexpected error'));

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.error).toBe('Unexpected error');
      expect(result.retryAfter).toBe(60000);
    });

    it('should return retry when processPendingEarmark fails with DB error', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { processPendingEarmark } = require('#/helpers');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0' },
        minAmounts: { '1': '100' },
      });
      processPendingEarmark.mockRejectedValue(new Error('Connection terminated due to connection timeout'));

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.retryAfter).toBe(30000);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to process pending earmark for invoice',
        expect.objectContaining({
          invoiceId: 'invoice-1',
        }),
      );
    });

    it('should return retry when getEarmarks fails after processPendingEarmark succeeds', async () => {
      const event = createInvoiceEvent('invoice-1');
      const invoice = createMockInvoice();
      const { processPendingEarmark } = require('#/helpers');

      mockEverclear.fetchInvoiceById.mockResolvedValue(invoice);
      mockEverclear.getMinAmounts.mockResolvedValue({
        invoiceAmount: '1000',
        amountAfterDiscount: '900',
        discountBps: '100',
        custodiedAmounts: { '1': '0' },
        minAmounts: { '1': '100' },
      });
      processPendingEarmark.mockResolvedValue(undefined);
      mockDatabase.getEarmarks.mockRejectedValue(new Error('Connection terminated due to connection timeout'));

      const result = await eventProcessor.processInvoiceEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.retryAfter).toBe(30000);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to process pending earmark for invoice',
        expect.objectContaining({
          invoiceId: 'invoice-1',
        }),
      );
    });
  });

  describe('processSettlementEnqueued', () => {
    const createMockInvoice = (overrides?: Partial<Invoice>): Invoice => ({
      intent_id: 'invoice-1',
      amount: '1000',
      owner: '0x123',
      entry_epoch: 1,
      origin: '1',
      destinations: ['2'],
      ticker_hash: '0xabc',
      discountBps: 0,
      hub_status: 'INVOICED',
      hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000),
      ...overrides,
    });

    const createSettlementEvent = (invoiceId: string): QueuedEvent => ({
      id: invoiceId,
      type: WebhookEventType.SettlementEnqueued,
      data: {
        id: invoiceId,
        intentId: invoiceId,
        domain: '0',
        entryEpoch: '0',
        asset: '0x',
        amount: '0',
        updateVirtualBalance: false,
        owner: '0x',
        transactionHash: '0x',
        timestamp: '0',
        gasPrice: '0',
        gasLimit: '0',
        blockNumber: '0',
        txOrigin: '0x',
        txNonce: '0',
      } as SettlementEnqueuedEvent,
      priority: EventPriority.NORMAL,
      retryCount: 0,
      maxRetries: -1,
      scheduledAt: Date.now(),
      metadata: { source: 'test' },
    });

    it('should process settlement successfully', async () => {
      const event = createSettlementEvent('invoice-1');
      const invoice = createMockInvoice({
        intent_id: 'invoice-1',
        origin: '1',
        ticker_hash: '0xabc',
        destinations: ['2'],
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000),
      });
      const purchase: PurchaseAction = {
        target: invoice,
        purchase: {
          intentId: 'intent-1',
          params: {
            origin: '1',
            destinations: ['2'],
            to: '0x123',
            inputAsset: '0xabc',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
          },
        },
        transactionHash: '0xtxhash',
        transactionType: TransactionSubmissionType.Onchain,
        cachedAt: Math.floor(Date.now() / 1000),
      };

      mockPurchaseCache.getPurchases.mockResolvedValue([purchase]);
      mockPurchaseCache.removePurchases.mockResolvedValue(1);

      const result = await eventProcessor.processSettlementEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Success);
      expect(result.eventId).toBe('invoice-1');
      expect(mockPurchaseCache.getPurchases).toHaveBeenCalledWith(['invoice-1']);
      expect(mockPurchaseCache.removePurchases).toHaveBeenCalledWith(['invoice-1']);
      expect(mockPrometheus.recordPurchaseClearanceDuration).toHaveBeenCalled();
    });

    it('should handle settlement when no purchase exists', async () => {
      const event = createSettlementEvent('invoice-1');

      mockPurchaseCache.getPurchases.mockResolvedValue([]);

      const result = await eventProcessor.processSettlementEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Success);
      expect(mockPurchaseCache.removePurchases).not.toHaveBeenCalled();
    });

    it('should handle processing errors', async () => {
      const event = createSettlementEvent('invoice-1');

      mockPurchaseCache.getPurchases.mockRejectedValue(new Error('Cache error'));

      const result = await eventProcessor.processSettlementEnqueued(event);

      expect(result.result).toBe(EventProcessingResultType.Failure);
      expect(result.error).toBe('Cache error');
      expect(result.retryAfter).toBe(60000);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to process settlement enqueued event',
        expect.objectContaining({
          eventId: 'invoice-1',
        }),
      );
    });
  });
});
