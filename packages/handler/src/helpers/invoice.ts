/* eslint-disable @typescript-eslint/no-explicit-any */
import { AxiosQueryError, SettlementEnqueuedEvent, WebhookEventType, InvoiceEnqueuedEvent, Invoice } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import { InvoiceHandlerAdapters } from '#/init';
import { EventPriority, QueuedEvent } from '#/queue';

// Store the cursor (hub_invoice_enqueued_tx_nonce) in memory (no cursor on start)
let lastCursor: string | null = null;

/**
 * Check for pending invoices and enqueue InvoiceEnqueued events for missed webhooks
 */
export async function checkPendingInvoices(adapters: InvoiceHandlerAdapters): Promise<void> {
  try {
    const { everclear, logger } = adapters.processingContext;
    const { eventQueue } = adapters;

    // Query invoices from API with cursor-based pagination
    let result: { invoices: Invoice[]; nextCursor: string | null };
    try {
      result = await everclear.fetchInvoicesByTxNonce(lastCursor, 100);
    } catch (error) {
      logger.warn('Error fetching invoices for backfill', {
        error: jsonifyError(error),
      });
      return;
    }

    const { invoices, nextCursor } = result;

    if (invoices.length === 0) {
      return;
    }

    logger.debug('Checking for pending invoices', {
      invoicesCount: invoices.length,
      lastCursor,
      nextCursor,
    });

    // Process each invoice
    for (const invoice of invoices) {
      const invoiceId = invoice.intent_id;

      // Check if the event already exists in redis (pending or processing queue)
      const alreadyExists = await eventQueue.hasEvent(WebhookEventType.InvoiceEnqueued, invoiceId);
      if (alreadyExists) {
        // Event already exists, skip
        logger.debug('Invoice event already in queue', {
          invoiceId,
        });
        continue;
      }

      // Create a minimal InvoiceEnqueuedEvent with only invoiceId
      const invoiceEvent: InvoiceEnqueuedEvent = {
        id: invoiceId, // Use invoiceId as event id
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
      };

      const queuedEvent: QueuedEvent = {
        id: invoiceId, // Use invoiceId as event ID
        type: WebhookEventType.InvoiceEnqueued,
        data: invoiceEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: Date.now(),
        metadata: {
          source: 'backfill-check',
        },
      };

      await adapters.eventConsumer.addEvent(queuedEvent);
      logger.info('Found InvoiceEnqueued event missed by webhook', {
        invoiceId,
      });
    }

    // Update cursor to nextCursor for the next call
    lastCursor = nextCursor;
    logger.debug('Updated cursor', {
      lastCursor,
    });
  } catch (error) {
    adapters.processingContext.logger.error('Error checking for pending invoices', {
      error: jsonifyError(error),
    });
  }
}

/**
 * Check for settled purchases and enqueue SettlementEnqueued events for missed webhooks
 */
export async function checkSettledInvoices(adapters: InvoiceHandlerAdapters): Promise<void> {
  try {
    const { purchaseCache, everclear, logger } = adapters.processingContext;

    // Get all pending purchases from the cache
    const purchases = await purchaseCache.getAllPurchases();
    if (purchases.length === 0) {
      return;
    }

    logger.debug('Checking for settled purchases', {
      purchaseCount: purchases.length,
    });

    const settledInvoiceIds: string[] = [];

    // Check each purchase to see if the invoice was settled
    for (const purchase of purchases) {
      const invoiceId = purchase.target.intent_id;
      try {
        // Try to fetch the invoice - if it returns NotFound, it means it was settled
        await everclear.fetchInvoiceById(invoiceId);
        // Invoice still exists and is not settled, skip it
      } catch (error) {
        // axiosGet() throws AxiosQueryError with context.status containing the HTTP status code
        // If we get a 404/NotFound error, the invoice was settled
        // (API filters out SETTLED invoices, so 404 means it's settled or doesn't exist)
        // Since the invoice is in our purchase cache, it must have existed, so 404 = settled
        const isNotFound =
          (error instanceof AxiosQueryError && error.context?.status === 404) ||
          (error as any).context?.status === 404 ||
          (error as any).response?.status === 404 ||
          (error as any).status === 404 ||
          (error as any).message?.includes('404') ||
          (error as any).message?.includes('NotFound');

        if (isNotFound) {
          settledInvoiceIds.push(invoiceId);
          logger.info('Found settled invoice that was missed by webhook', {
            invoiceId,
          });
        } else {
          // Other errors (network, etc.) - log but don't treat as settled
          logger.warn('Error checking invoice status', {
            invoiceId,
            error: jsonifyError(error),
          });
        }
      }
    }

    // Enqueue SettlementEnqueued events for settled invoices
    if (settledInvoiceIds.length > 0) {
      logger.info('Enqueueing SettlementEnqueued events for missed webhooks', {
        count: settledInvoiceIds.length,
        invoiceIds: settledInvoiceIds,
      });

      for (const invoiceId of settledInvoiceIds) {
        // Create minimal SettlementEnqueuedEvent with only invoiceId
        const settlementEvent: SettlementEnqueuedEvent = {
          id: invoiceId, // Use invoiceId as event id
          intentId: invoiceId,
          domain: '0',
          entryEpoch: '0',
          asset: '0x',
          amount: '0',
          updateVirtualBalance: false, // Default value
          owner: '0x',
          transactionHash: '0x',
          timestamp: '0',
          gasPrice: '0',
          gasLimit: '0',
          blockNumber: '0',
          txOrigin: '0x',
          txNonce: '0',
        };

        const queuedEvent: QueuedEvent = {
          id: invoiceId,
          type: WebhookEventType.SettlementEnqueued,
          data: settlementEvent,
          priority: EventPriority.NORMAL,
          retryCount: 0,
          maxRetries: -1,
          scheduledAt: Date.now(),
          metadata: {
            source: 'backfill-check',
          },
        };

        await adapters.eventConsumer.addEvent(queuedEvent);
      }
    }
  } catch (error) {
    adapters.processingContext.logger.error('Error checking for settled purchases', {
      error: jsonifyError(error),
    });
  }
}
