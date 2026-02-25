import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventQueue, EventPriority, QueuedEvent } from '#/queue';
import { WebhookEventType, InvoiceEnqueuedEvent } from '@mark/core';
import { Logger } from '@mark/logger';
import Redis from 'ioredis';

// Mock ioredis
jest.mock('ioredis');

describe('EventQueue', () => {
  let eventQueue: EventQueue;
  let mockRedis: jest.Mocked<Redis>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock Redis instance
    mockRedis = {
      zscore: jest.fn(),
      zadd: jest.fn(),
      zrem: jest.fn(),
      hset: jest.fn(),
      hget: jest.fn(),
      hdel: jest.fn(),
      zrange: jest.fn(),
      hmget: (jest.fn() as jest.MockedFunction<any>).mockResolvedValue([]),
      multi: jest.fn(),
      exec: jest.fn(),
      set: (jest.fn() as jest.MockedFunction<any>).mockResolvedValue('OK'),
      setex: (jest.fn() as jest.MockedFunction<any>).mockResolvedValue('OK'),
      exists: (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(0),
    } as any;

    (Redis as jest.MockedClass<typeof Redis>).mockImplementation(() => mockRedis as any);

    // Create mock logger
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    eventQueue = new EventQueue('localhost', 6379, mockLogger);
  });

  describe('enqueueEvent', () => {
    it('should throw error for empty event id', async () => {
      const event: QueuedEvent = {
        id: '',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: Date.now(),
        metadata: { source: 'test' },
      };

      await expect(eventQueue.enqueueEvent(event)).rejects.toThrow('Event ID must be a non-empty string');
    });

    it('should throw error for invalid scheduledAt', async () => {
      const event: QueuedEvent = {
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: -100,
        metadata: { source: 'test' },
      };

      await expect(eventQueue.enqueueEvent(event)).rejects.toThrow('Event scheduledAt must be a non-negative finite number');
    });

    it('should throw error for NaN scheduledAt', async () => {
      const event: QueuedEvent = {
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: NaN,
        metadata: { source: 'test' },
      };

      await expect(eventQueue.enqueueEvent(event)).rejects.toThrow('Event scheduledAt must be a non-negative finite number');
    });

    it('should throw error for invalid priority', async () => {
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

      await expect(eventQueue.enqueueEvent(event, 'INVALID' as EventPriority)).rejects.toThrow('Invalid priority');
    });

    it('should enqueue a new event successfully', async () => {
      const event: QueuedEvent = {
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {
          id: 'event-1',
          invoice: {
            id: 'invoice-1',
            intent: {
              id: 'invoice-1',
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
      };

      mockRedis.zscore.mockResolvedValue(null);
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        hset: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.enqueueEvent(event);

      expect(result).toBe(false);
      expect(mockRedis.zscore).toHaveBeenCalledTimes(2);
      expect(mockMulti.zrem).toHaveBeenCalled();
      expect(mockMulti.hset).toHaveBeenCalled();
      expect(mockMulti.zadd).toHaveBeenCalled();
    });

    it('should return true and skip writes if event already exists in pending queue', async () => {
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

      mockRedis.zscore.mockResolvedValueOnce('123456').mockResolvedValueOnce(null);

      const result = await eventQueue.enqueueEvent(event);

      expect(result).toBe(true);
      // Should NOT call multi/hset/zadd — event data must not be overwritten
      expect(mockRedis.multi).not.toHaveBeenCalled();
    });

    it('should return true and skip writes if event already exists in processing queue', async () => {
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

      mockRedis.zscore.mockResolvedValueOnce(null).mockResolvedValueOnce('123456');

      const result = await eventQueue.enqueueEvent(event);

      expect(result).toBe(true);
      // Should NOT call multi/hset/zadd — event data must not be overwritten
      expect(mockRedis.multi).not.toHaveBeenCalled();
    });

    it('should update event data when forceUpdate is true even if event exists', async () => {
      const event: QueuedEvent = {
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 3,
        maxRetries: 10,
        scheduledAt: Date.now() + 60000,
        metadata: { source: 'test' },
      };

      // Event exists in processing queue (typical retry scenario)
      mockRedis.zscore.mockResolvedValueOnce(null).mockResolvedValueOnce('123456');
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        hset: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.enqueueEvent(event, EventPriority.NORMAL, true);

      expect(result).toBe(true);
      // With forceUpdate, should proceed with writes to update retryCount etc.
      expect(mockMulti.zrem).toHaveBeenCalled();
      expect(mockMulti.hset).toHaveBeenCalled();
      expect(mockMulti.zadd).toHaveBeenCalled();
    });
  });

  describe('hasEvent', () => {
    it('should return true if event exists in pending queue', async () => {
      mockRedis.zscore.mockResolvedValueOnce('123456').mockResolvedValueOnce(null);

      const result = await eventQueue.hasEvent(WebhookEventType.InvoiceEnqueued, 'event-1');

      expect(result).toBe(true);
      expect(mockRedis.zscore).toHaveBeenCalledTimes(2);
    });

    it('should return true if event exists in processing queue', async () => {
      mockRedis.zscore.mockResolvedValueOnce(null).mockResolvedValueOnce('123456');

      const result = await eventQueue.hasEvent(WebhookEventType.InvoiceEnqueued, 'event-1');

      expect(result).toBe(true);
    });

    it('should return false if event does not exist', async () => {
      mockRedis.zscore.mockResolvedValue(null);

      const result = await eventQueue.hasEvent(WebhookEventType.InvoiceEnqueued, 'event-1');

      expect(result).toBe(false);
    });
  });

  describe('dequeueEvents', () => {
    it('should dequeue events successfully', async () => {
      const eventIds = ['event-1', 'event-2'];
      const eventData = JSON.stringify({
        id: 'event-1',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: Date.now(),
        metadata: { source: 'test' },
      });

      mockRedis.zrange.mockResolvedValue(eventIds);
      mockRedis.hmget.mockResolvedValue([eventData, eventData]);
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1], [null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.dequeueEvents(WebhookEventType.InvoiceEnqueued, 10);

      expect(result).toHaveLength(2);
      expect(mockRedis.zrange).toHaveBeenCalled();
      expect(mockRedis.hmget).toHaveBeenCalled();
    });

    it('should remove events with missing data', async () => {
      const eventIds = ['event-1', 'event-2'];

      mockRedis.zrange.mockResolvedValue(eventIds);
      mockRedis.hmget.mockResolvedValue([null, null]);
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        hdel: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.dequeueEvents(WebhookEventType.InvoiceEnqueued, 10);

      expect(result).toHaveLength(0);
      expect(mockMulti.zrem).toHaveBeenCalledTimes(2);
      expect(mockMulti.hdel).toHaveBeenCalledTimes(2);
    });

    it('should return empty array for non-positive count', async () => {
      const result = await eventQueue.dequeueEvents(WebhookEventType.InvoiceEnqueued, 0);
      expect(result).toHaveLength(0);
      expect(mockRedis.zrange).not.toHaveBeenCalled();
    });

    it('should return empty array for negative count', async () => {
      const result = await eventQueue.dequeueEvents(WebhookEventType.InvoiceEnqueued, -5);
      expect(result).toHaveLength(0);
      expect(mockRedis.zrange).not.toHaveBeenCalled();
    });

    it('should cap count at 1000 when exceeded', async () => {
      mockRedis.zrange.mockResolvedValue([]);

      await eventQueue.dequeueEvents(WebhookEventType.InvoiceEnqueued, 5000);

      expect(mockLogger.warn).toHaveBeenCalledWith('Dequeue count exceeds maximum, capping at 1000', { requestedCount: 5000 });
      // Verify zrange was called with the capped count (0 to 999 = 1000 items)
      expect(mockRedis.zrange).toHaveBeenCalled();
      const zrangeCall = (mockRedis.zrange as jest.Mock).mock.calls[0];
      expect(zrangeCall[1]).toBe(0);
      expect(zrangeCall[2]).toBe(999);
    });

    it('should handle corrupted JSON data gracefully', async () => {
      const eventIds = ['event-1', 'event-2'];
      const validEventData = JSON.stringify({
        id: 'event-2',
        type: WebhookEventType.InvoiceEnqueued,
        data: {} as InvoiceEnqueuedEvent,
        priority: EventPriority.NORMAL,
        retryCount: 0,
        maxRetries: -1,
        scheduledAt: Date.now() - 1000,
        metadata: { source: 'test' },
      });

      mockRedis.zrange.mockResolvedValue(eventIds);
      mockRedis.hmget.mockResolvedValue(['invalid-json{', validEventData]);
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        hdel: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.dequeueEvents(WebhookEventType.InvoiceEnqueued, 10);

      expect(result).toHaveLength(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to parse event data during dequeue, marking as orphaned',
        expect.objectContaining({ eventId: 'event-1' })
      );
      // Verify corrupted data is cleaned up
      expect(mockMulti.hdel).toHaveBeenCalledTimes(1);
    });
  });

  describe('acknowledgeProcessedEvent', () => {
    it('should acknowledge and remove event successfully', async () => {
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

      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1], [null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        hdel: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      await eventQueue.acknowledgeProcessedEvent(event);

      expect(mockMulti.zrem).toHaveBeenCalled();
      expect(mockMulti.hdel).toHaveBeenCalled();
    });
  });

  describe('moveToDeadLetterQueue', () => {
    it('should move event to dead letter queue', async () => {
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

      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1], [null, 1], [null, 1], [null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        hset: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        hdel: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      await eventQueue.moveToDeadLetterQueue(event, 'Test error');

      expect(mockMulti.zrem).toHaveBeenCalled();
      expect(mockMulti.hset).toHaveBeenCalled();
      expect(mockMulti.zadd).toHaveBeenCalled();
    });
  });

  describe('getBackfillCursor', () => {
    it('should return cursor from Redis', async () => {
      mockRedis.get = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue('cursor-123');

      const result = await eventQueue.getBackfillCursor();

      expect(result).toBe('cursor-123');
      expect(mockRedis.get).toHaveBeenCalledWith('event-queue:backfill-cursor');
    });

    it('should return null when cursor is not set', async () => {
      mockRedis.get = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(null);

      const result = await eventQueue.getBackfillCursor();

      expect(result).toBeNull();
    });
  });

  describe('setBackfillCursor', () => {
    it('should set cursor in Redis', async () => {
      mockRedis.set = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue('OK');

      await eventQueue.setBackfillCursor('cursor-123');

      expect(mockRedis.set).toHaveBeenCalled();
      // Verify the key and value were passed correctly
      const setCall = (mockRedis.set as jest.Mock).mock.calls[0];
      expect(setCall[0]).toBe('event-queue:backfill-cursor');
      expect(setCall[1]).toBe('cursor-123');
    });

    it('should delete cursor when null is passed', async () => {
      mockRedis.del = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(1);

      await eventQueue.setBackfillCursor(null);

      expect(mockRedis.del).toHaveBeenCalled();
      // Verify the key was passed correctly
      const delCall = (mockRedis.del as jest.Mock).mock.calls[0];
      expect(delCall[0]).toBe('event-queue:backfill-cursor');
    });
  });

  describe('invalid invoice store', () => {
    it('should add invalid invoice with default TTL', async () => {
      await eventQueue.addInvalidInvoice('invoice-123');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'event-queue:invalid-invoice:invoice-123',
        7 * 24 * 60 * 60,
        '1',
      );
      expect(mockLogger.debug).toHaveBeenCalledWith('Added invalid invoice to store', {
        invoiceId: 'invoice-123',
        ttl: 7 * 24 * 60 * 60,
      });
    });

    it('should add invalid invoice with custom TTL', async () => {
      await eventQueue.addInvalidInvoice('invoice-456', 3600);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'event-queue:invalid-invoice:invoice-456',
        3600,
        '1',
      );
    });

    it('should return true when invoice is invalid', async () => {
      (mockRedis.exists as jest.Mock<() => Promise<number>>).mockResolvedValue(1);

      const result = await eventQueue.isInvalidInvoice('invoice-789');

      expect(result).toBe(true);
      expect(mockRedis.exists).toHaveBeenCalledWith('event-queue:invalid-invoice:invoice-789');
    });

    it('should return false when invoice is not invalid', async () => {
      (mockRedis.exists as jest.Mock<() => Promise<number>>).mockResolvedValue(0);

      const result = await eventQueue.isInvalidInvoice('invoice-999');

      expect(result).toBe(false);
    });
  });

  describe('getQueueDepths', () => {
    it('should return queue depths for all event types', async () => {
      mockRedis.zcard = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(5);

      const result = await eventQueue.getQueueDepths();

      expect(result).toBeDefined();
      expect(mockRedis.zcard).toHaveBeenCalled();
      // Each event type should have pending and processing counts
      for (const eventType of Object.values(WebhookEventType)) {
        expect(result[eventType]).toBeDefined();
        expect(result[eventType].pending).toBe(5);
        expect(result[eventType].processing).toBe(5);
      }
    });
  });

  describe('resetQueues', () => {
    it('should delete all queue keys and return counts', async () => {
      mockRedis.zcard = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(3);
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1]]);
      const mockMulti: any = {
        del: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.resetQueues();

      // Should return counts for each event type
      for (const eventType of Object.values(WebhookEventType)) {
        expect(result[eventType]).toEqual({ pending: 3, processing: 3 });
      }

      // 2 del calls per event type (pending + processing) + data hash + cursor key
      const eventTypeCount = Object.values(WebhookEventType).length;
      expect(mockMulti.del).toHaveBeenCalledTimes(eventTypeCount * 2 + 2);
      expect(mockMulti.exec).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Reset all queues', expect.objectContaining({ counts: result }));
    });

    it('should handle empty queues gracefully', async () => {
      mockRedis.zcard = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(0);
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1]]);
      const mockMulti: any = {
        del: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.resetQueues();

      for (const eventType of Object.values(WebhookEventType)) {
        expect(result[eventType]).toEqual({ pending: 0, processing: 0 });
      }

      // Still deletes all keys even if empty
      expect(mockMulti.del).toHaveBeenCalled();
      expect(mockMulti.exec).toHaveBeenCalled();
    });
  });

  describe('isPaused / setPaused', () => {
    it('should return false when not paused', async () => {
      mockRedis.get = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(null);

      const result = await eventQueue.isPaused();

      expect(result).toBe(false);
      expect(mockRedis.get).toHaveBeenCalledWith('event-queue:paused');
    });

    it('should return true when paused', async () => {
      mockRedis.get = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue('1');

      const result = await eventQueue.isPaused();

      expect(result).toBe(true);
    });

    it('should set paused state in Redis', async () => {
      mockRedis.set = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue('OK');

      await eventQueue.setPaused(true);

      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = (mockRedis.set as jest.Mock).mock.calls[0];
      expect(setCall[0]).toBe('event-queue:paused');
      expect(setCall[1]).toBe('1');
    });

    it('should delete paused key when unpausing', async () => {
      mockRedis.del = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(1);

      await eventQueue.setPaused(false);

      expect(mockRedis.del).toHaveBeenCalledWith('event-queue:paused');
    });
  });

  describe('cleanupExpiredDeadLetterEntries', () => {
    it('should remove expired entries from dead letter queue', async () => {
      const expiredEventIds = ['event-1', 'event-2'];
      mockRedis.zrangebyscore = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue(expiredEventIds);
      const mockExec = jest.fn() as jest.MockedFunction<any>;
      mockExec.mockResolvedValue([[null, 1], [null, 1], [null, 1], [null, 1]]);
      const mockMulti: any = {
        zrem: jest.fn().mockReturnThis(),
        hdel: jest.fn().mockReturnThis(),
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.cleanupExpiredDeadLetterEntries();

      expect(result).toBe(2);
      expect(mockMulti.zrem).toHaveBeenCalledTimes(2);
      expect(mockMulti.hdel).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleaned up expired dead letter queue entries',
        expect.objectContaining({ count: 2 })
      );
    });

    it('should return 0 if no expired entries found', async () => {
      mockRedis.zrangebyscore = (jest.fn() as jest.MockedFunction<any>).mockResolvedValue([]);

      const result = await eventQueue.cleanupExpiredDeadLetterEntries();

      expect(result).toBe(0);
      expect(mockRedis.multi).not.toHaveBeenCalled();
    });
  });
});
