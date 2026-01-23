import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventConsumer } from '#/consumer';
import { EventQueue, QueuedEvent, EventPriority } from '#/queue';
import { EventProcessor } from '#/processor';
import { WebhookEventType, InvoiceEnqueuedEvent } from '@mark/core';
import { Logger } from '@mark/logger';

describe('EventConsumer', () => {
  let eventConsumer: EventConsumer;
  let mockQueue: jest.Mocked<EventQueue>;
  let mockProcessor: jest.Mocked<EventProcessor>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQueue = {
      enqueueEvent: jest.fn(),
      dequeueEvents: jest.fn(),
      moveProcessingToPending: jest.fn(),
      acknowledgeProcessedEvent: jest.fn(),
      moveToDeadLetterQueue: jest.fn(),
      hasEvent: jest.fn(),
    } as any;

    mockProcessor = {
      processInvoiceEnqueued: jest.fn() as jest.MockedFunction<any>,
      processSettlementEnqueued: jest.fn() as jest.MockedFunction<any>,
    } as any;

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    eventConsumer = new EventConsumer(mockQueue, mockProcessor, mockLogger, 5);
  });

  describe('start', () => {
    it('should start processing events', async () => {
      mockQueue.moveProcessingToPending.mockResolvedValue(undefined);
      mockQueue.dequeueEvents.mockResolvedValue([]);

      await eventConsumer.start();

      expect(mockQueue.moveProcessingToPending).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting event consumer',
        expect.objectContaining({
          maxConcurrentEvents: 5,
        }),
      );
    });

    it('should not start if already processing', async () => {
      mockQueue.moveProcessingToPending.mockResolvedValue(undefined);
      mockQueue.dequeueEvents.mockResolvedValue([]);

      await eventConsumer.start();
      await eventConsumer.start();

      expect(mockQueue.moveProcessingToPending).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('Consumer is already running');
    });
  });

  describe('stop', () => {
    it('should stop processing events', async () => {
      mockQueue.moveProcessingToPending.mockResolvedValue(undefined);
      mockQueue.dequeueEvents.mockResolvedValue([]);

      await eventConsumer.start();
      await eventConsumer.stop();

      expect(mockLogger.info).toHaveBeenCalledWith('Stopping event consumer');
    });

    it('should not stop if not running', async () => {
      await eventConsumer.stop();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Consumer is already being stopped or not running, skipping stop',
      );
    });
  });

  describe('addEvent', () => {
    beforeEach(async () => {
      mockQueue.moveProcessingToPending.mockResolvedValue(undefined);
      mockQueue.dequeueEvents.mockResolvedValue([]);
      await eventConsumer.start();
    });

    it('should enqueue and process event immediately if under limit', async () => {
      const event: QueuedEvent = {
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: Date.now(),
        metadata: { source: 'test' },
      };

      mockQueue.enqueueEvent.mockResolvedValue(false);
      (mockProcessor.processInvoiceEnqueued as jest.MockedFunction<any>).mockResolvedValue({
        success: true,
        eventId: 'event-1',
        processedAt: Date.now(),
        duration: 100,
      });

      await eventConsumer.addEvent(event);

      expect(mockQueue.enqueueEvent).toHaveBeenCalledWith(event, EventPriority.NORMAL);
    });

    it('should not process if event already exists in queue', async () => {
      const event: QueuedEvent = {
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: Date.now(),
        metadata: { source: 'test' },
      };

      mockQueue.enqueueEvent.mockResolvedValue(true);

      await eventConsumer.addEvent(event);

      expect(mockQueue.enqueueEvent).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Event already in queue, skipping processing',
        expect.objectContaining({
          event,
        }),
      );
    });

    it('should not process if consumer is not running', async () => {
      await eventConsumer.stop();

      const event: QueuedEvent = {
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: Date.now(),
        metadata: { source: 'test' },
      };

      mockQueue.enqueueEvent.mockResolvedValue(false);

      await eventConsumer.addEvent(event);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Consumer is not running, skipping event processing',
        { event },
      );
    });
  });
});
