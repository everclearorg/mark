import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { checkPendingInvoices, checkSettledInvoices } from '#/helpers/invoice';
import { InvoiceHandlerAdapters } from '#/init';
import { EventQueue } from '#/queue';
import { EventConsumer } from '#/consumer';
import { EventProcessor } from '#/processor';
import { WebhookHandler } from '@mark/webhooks';
import {
  Invoice,
  AxiosQueryError,
} from '@mark/core';
import { Logger } from '@mark/logger';
import { ProcessingContext } from '@mark/poller/src/init';

describe('Invoice Helpers', () => {
  let mockAdapters: InvoiceHandlerAdapters;
  let mockEverclear: any;
  let mockPurchaseCache: any;
  let mockEventQueue: jest.Mocked<EventQueue>;
  let mockEventConsumer: jest.Mocked<EventConsumer>;
  let mockLogger: jest.Mocked<Logger>;
  let mockProcessingContext: ProcessingContext;

  beforeEach(() => {
    jest.clearAllMocks();

    mockEverclear = {
      fetchInvoicesByTxNonce: jest.fn(),
      fetchInvoiceById: jest.fn(),
    };

    mockPurchaseCache = {
      getAllPurchases: jest.fn(),
    };

    mockEventQueue = {
      hasEvent: jest.fn(),
      enqueueEvent: jest.fn(),
      dequeueEvents: jest.fn(),
      moveProcessingToPending: jest.fn(),
      acknowledgeProcessedEvent: jest.fn(),
      moveToDeadLetterQueue: jest.fn(),
      getBackfillCursor: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
      setBackfillCursor: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getQueueDepths: jest.fn(),
      getQueueStatus: jest.fn(),
    } as any;

    mockEventConsumer = {
      addEvent: jest.fn(),
    } as any;

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockProcessingContext = {
      purchaseCache: mockPurchaseCache,
      everclear: mockEverclear,
      logger: mockLogger,
    } as any;

    mockAdapters = {
      processingContext: mockProcessingContext,
      webhookHandler: {} as WebhookHandler,
      eventQueue: mockEventQueue,
      eventProcessor: {} as EventProcessor,
      eventConsumer: mockEventConsumer,
    };
  });

  describe('checkPendingInvoices', () => {
    it('should enqueue InvoiceEnqueued events for new invoices', async () => {
      const invoices: Invoice[] = [
        {
          intent_id: 'invoice-1',
          amount: '1000',
          owner: '0x123',
          entry_epoch: 1,
          origin: '1',
          destinations: ['2'],
          ticker_hash: '0xabc',
          discountBps: 0,
          hub_status: 'INVOICED',
          hub_invoice_enqueued_timestamp: Date.now(),
        },
        {
          intent_id: 'invoice-2',
          amount: '2000',
          owner: '0x456',
          entry_epoch: 2,
          origin: '1',
          destinations: ['2'],
          ticker_hash: '0xdef',
          discountBps: 0,
          hub_status: 'INVOICED',
          hub_invoice_enqueued_timestamp: Date.now(),
        },
      ];

      mockEverclear.fetchInvoicesByTxNonce.mockResolvedValue({
        invoices,
        nextCursor: 'cursor-123',
      });
      mockEventQueue.hasEvent.mockResolvedValue(false);

      await checkPendingInvoices(mockAdapters);

      // Verify cursor was fetched from Redis
      expect(mockEventQueue.getBackfillCursor).toHaveBeenCalled();
      expect(mockEverclear.fetchInvoicesByTxNonce).toHaveBeenCalledWith(null, 100);
      expect(mockEventQueue.hasEvent).toHaveBeenCalledTimes(2);
      expect(mockEventConsumer.addEvent).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Found InvoiceEnqueued event missed by webhook',
        { invoiceId: 'invoice-1' },
      );
      // Verify cursor was persisted to Redis
      expect(mockEventQueue.setBackfillCursor).toHaveBeenCalledWith('cursor-123');
    });

    it('should skip invoices that already exist in queue', async () => {
      const invoices: Invoice[] = [
        {
          intent_id: 'invoice-1',
          amount: '1000',
          owner: '0x123',
          entry_epoch: 1,
          origin: '1',
          destinations: ['2'],
          ticker_hash: '0xabc',
          discountBps: 0,
          hub_status: 'INVOICED',
          hub_invoice_enqueued_timestamp: Date.now(),
        },
      ];

      mockEverclear.fetchInvoicesByTxNonce.mockResolvedValue({
        invoices,
        nextCursor: 'cursor-123',
      });
      mockEventQueue.hasEvent.mockResolvedValue(true);

      await checkPendingInvoices(mockAdapters);

      expect(mockEventQueue.hasEvent).toHaveBeenCalled();
      expect(mockEventConsumer.addEvent).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('Invoice event already in queue', {
        invoiceId: 'invoice-1',
      });
    });

    it('should handle API errors gracefully', async () => {
      mockEverclear.fetchInvoicesByTxNonce.mockRejectedValue(new Error('API error'));

      await checkPendingInvoices(mockAdapters);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error fetching invoices for backfill',
        expect.any(Object),
      );
      expect(mockEventConsumer.addEvent).not.toHaveBeenCalled();
    });

    it('should return early if no invoices', async () => {
      mockEverclear.fetchInvoicesByTxNonce.mockResolvedValue({
        invoices: [],
        nextCursor: null,
      });

      await checkPendingInvoices(mockAdapters);

      expect(mockEventQueue.hasEvent).not.toHaveBeenCalled();
      expect(mockEventConsumer.addEvent).not.toHaveBeenCalled();
    });
  });

  describe('checkSettledInvoices', () => {
    it('should enqueue SettlementEnqueued events for settled invoices', async () => {
      const purchases = [
        {
          target: {
            intent_id: 'invoice-1',
            hub_invoice_enqueued_timestamp: Date.now(),
          },
        },
        {
          target: {
            intent_id: 'invoice-2',
            hub_invoice_enqueued_timestamp: Date.now(),
          },
        },
      ];

      mockPurchaseCache.getAllPurchases.mockResolvedValue(purchases);
      mockEverclear.fetchInvoiceById
        .mockRejectedValueOnce(
          new AxiosQueryError('Not found', { status: 404, message: 'Not found' }),
        )
        .mockResolvedValueOnce({
          intent_id: 'invoice-2',
          amount: '2000',
          owner: '0x456',
          entry_epoch: 2,
          origin: '1',
          destinations: ['2'],
          ticker_hash: '0xdef',
          discountBps: 0,
          hub_status: 'INVOICED',
          hub_invoice_enqueued_timestamp: Date.now(),
        });

      await checkSettledInvoices(mockAdapters);

      expect(mockPurchaseCache.getAllPurchases).toHaveBeenCalled();
      expect(mockEverclear.fetchInvoiceById).toHaveBeenCalledTimes(2);
      expect(mockEventConsumer.addEvent).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Found settled invoice that was missed by webhook',
        { invoiceId: 'invoice-1' },
      );
    });

    it('should skip invoices that still exist', async () => {
      const purchases = [
        {
          target: {
            intent_id: 'invoice-1',
            hub_invoice_enqueued_timestamp: Date.now(),
          },
        },
      ];

      mockPurchaseCache.getAllPurchases.mockResolvedValue(purchases);
      mockEverclear.fetchInvoiceById.mockResolvedValue({
        intent_id: 'invoice-1',
        amount: '1000',
        owner: '0x123',
        entry_epoch: 1,
        origin: '1',
        destinations: ['2'],
        ticker_hash: '0xabc',
        discountBps: 0,
        hub_status: 'INVOICED',
        hub_invoice_enqueued_timestamp: Date.now(),
      });

      await checkSettledInvoices(mockAdapters);

      expect(mockEventConsumer.addEvent).not.toHaveBeenCalled();
    });

    it('should handle non-404 errors gracefully', async () => {
      const purchases = [
        {
          target: {
            intent_id: 'invoice-1',
            hub_invoice_enqueued_timestamp: Date.now(),
          },
        },
      ];

      mockPurchaseCache.getAllPurchases.mockResolvedValue(purchases);
      mockEverclear.fetchInvoiceById.mockRejectedValue(new Error('Network error'));

      await checkSettledInvoices(mockAdapters);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error checking invoice status',
        expect.objectContaining({
          invoiceId: 'invoice-1',
        }),
      );
      expect(mockEventConsumer.addEvent).not.toHaveBeenCalled();
    });

    it('should return early if no purchases', async () => {
      mockPurchaseCache.getAllPurchases.mockResolvedValue([]);

      await checkSettledInvoices(mockAdapters);

      expect(mockEverclear.fetchInvoiceById).not.toHaveBeenCalled();
      expect(mockEventConsumer.addEvent).not.toHaveBeenCalled();
    });
  });
});
