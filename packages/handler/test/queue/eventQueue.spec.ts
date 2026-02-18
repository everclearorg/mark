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

    it('should return true if event already exists in pending queue', async () => {
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

      expect(result).toBe(true);
    });

    it('should return true if event already exists in processing queue', async () => {
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

      expect(result).toBe(true);
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
        exec: mockExec,
      };
      mockRedis.multi.mockReturnValue(mockMulti);

      const result = await eventQueue.dequeueEvents(WebhookEventType.InvoiceEnqueued, 10);

      expect(result).toHaveLength(0);
      expect(mockMulti.zrem).toHaveBeenCalledTimes(2);
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
});
