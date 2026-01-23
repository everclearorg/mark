import Redis from 'ioredis';
import { Logger } from '@mark/logger';
import { WebhookEvent, WebhookEventType } from '@mark/core';

export enum EventPriority {
  HIGH = 'HIGH',
  NORMAL = 'NORMAL',
  LOW = 'LOW',
}

export interface EventMetadata {
  source: string;
  correlationId?: string;
  userId?: string;
  chainId?: number;
  tokenAddress?: string;
  originalWebhookId?: string;
}

export interface QueuedEvent {
  id: string;
  type: WebhookEventType;
  data: WebhookEvent;
  priority: EventPriority;
  retryCount: number;
  maxRetries: number;
  scheduledAt: number;
  metadata: EventMetadata;
}

export interface QueueStatus {
  queueLength: number;
  processingRate: number;
  errorRate: number;
  consumerCount: number;
  deadLetterQueueLength: number;
  lastProcessedAt?: number;
}

export class EventQueue {
  private readonly prefix = 'event-queue';
  private readonly pendingQueueKeys: Record<WebhookEventType, string> = {} as Record<WebhookEventType, string>;
  private readonly processingQueueKeys: Record<WebhookEventType, string> = {} as Record<WebhookEventType, string>;
  private readonly deadLetterQueueKey = `${this.prefix}:dead-letter`;
  private readonly dataKey = `${this.prefix}:data`;
  private readonly statusKey = `${this.prefix}:status`;
  private readonly store: Redis;

  constructor(
    host: string,
    port: number,
    private readonly logger: Logger,
  ) {
    this.store = new Redis({
      host,
      port,
      connectTimeout: 17000,
      maxRetriesPerRequest: 4,
      retryStrategy: (times) => Math.min(times * 30, 1000),
    });

    for (const eventType of Object.values(WebhookEventType)) {
      this.pendingQueueKeys[eventType] = `${this.prefix}:pending:${eventType}`;
      this.processingQueueKeys[eventType] = `${this.prefix}:processing:${eventType}`;
    }
  }

  /**
   * Enqueue an event for processing.
   * Events are stored in type-specific pending queues and sorted by arrival time (FIFO).
   * Event ID is stored in a sorted set, full event data is stored separately.
   * If the event exists in the processing queue, it will be removed first (for retries).
   * @returns true if the event was already in the pending or processing queue, false otherwise
   */
  async enqueueEvent(event: QueuedEvent, priority: EventPriority = EventPriority.NORMAL): Promise<boolean> {
    const eventWithPriority = { ...event, priority };
    const pendingQueueKey = this.pendingQueueKeys[event.type];
    const processingQueueKey = this.processingQueueKeys[event.type];

    // Check if the event already exists in the pending or processing queue
    const [isInPending, isInProcessing] = await Promise.all([
      this.store.zscore(pendingQueueKey, event.id),
      this.store.zscore(processingQueueKey, event.id),
    ]);

    const alreadyExists = isInPending !== null || isInProcessing !== null;

    // Use scheduledAt for FIFO ordering
    // Lower score = older event = processed first
    const score = event.scheduledAt;
    const eventData = JSON.stringify(eventWithPriority);

    // Check if event exists in processing queue and remove it, then add to the pending queue (atomic operation)
    const multi = this.store.multi();

    // Remove from processing queue if it exists (no-op if not present)
    multi.zrem(processingQueueKey, event.id);

    // Update event data and add to the pending queue
    multi.hset(this.dataKey, event.id, eventData);
    multi.zadd(pendingQueueKey, score, event.id);

    await multi.exec();

    this.logger.debug('Event enqueued', {
      event,
      priority,
      pendingQueueKey,
      score,
      alreadyExists,
    });

    return alreadyExists;
  }

  /**
   * Check if an event already exists in the pending or processing queue
   */
  async hasEvent(eventType: WebhookEventType, eventId: string): Promise<boolean> {
    const pendingQueueKey = this.pendingQueueKeys[eventType];
    const processingQueueKey = this.processingQueueKeys[eventType];

    const [isInPending, isInProcessing] = await Promise.all([
      this.store.zscore(pendingQueueKey, eventId),
      this.store.zscore(processingQueueKey, eventId),
    ]);

    return isInPending !== null || isInProcessing !== null;
  }

  /**
   * Move all events from processing queues back to pending queues.
   * This is required after restart to reprocess events processing of which was not completed during the previous run.
   */
  async moveProcessingToPending(): Promise<void> {
    for (const eventType of Object.values(WebhookEventType) as WebhookEventType[]) {
      const processingQueueKey = this.processingQueueKeys[eventType];
      const pendingQueueKey = this.pendingQueueKeys[eventType];

      // Get all event IDs from the processing queue
      const eventIds = await this.store.zrange(processingQueueKey, 0, -1);

      if (!eventIds || eventIds.length === 0) {
        continue; // No events in this processing queue
      }

      // Fetch event data to get timestamps for proper FIFO ordering
      const eventDataArray = await this.store.hmget(this.dataKey, ...eventIds);

      // Use Redis transaction for atomic batch operations
      const multi = this.store.multi();

      for (let i = 0; i < eventIds.length; i++) {
        const eventId = eventIds[i];
        const eventData = eventDataArray[i];
        if (eventData) {
          // Parse event to get scheduledAt for proper ordering
          const event: QueuedEvent = JSON.parse(eventData);
          const score = event.scheduledAt;
          // Remove from the processing queue and add to the pending queue
          multi.zrem(processingQueueKey, eventId);
          multi.zadd(pendingQueueKey, score, eventId);
        } else {
          // Event data is missing, just remove from the processing queue
          multi.zrem(processingQueueKey, eventId);
          multi.hdel(this.dataKey, eventId);
        }
      }

      await multi.exec();

      if (eventIds.length > 0) {
        this.logger.info('Moved events from processing to pending queue', {
          eventType,
          count: eventIds.length,
        });
      }
    }
  }

  /**
   * Dequeue multiple events for processing (FIFO)
   * Checks the specified event type pending queue and returns up to count ready events
   * Uses a Redis transaction for atomic batch operations
   */
  async dequeueEvents(eventType: WebhookEventType, count: number): Promise<QueuedEvent[]> {
    if (count <= 0) {
      return [];
    }

    const pendingQueueKey = this.pendingQueueKeys[eventType];

    // Get up to count event IDs from this queue (oldest first)
    const eventIds = await this.store.zrange(pendingQueueKey, 0, count - 1);

    if (!eventIds || eventIds.length === 0) {
      return []; // No events in this queue
    }

    // Fetch event data for all IDs in parallel
    const eventDataArray = await this.store.hmget(this.dataKey, ...eventIds);

    // Parse events and identify valid events and orphaned IDs (missing data)
    const events: QueuedEvent[] = [];
    const validEventIds: string[] = [];
    const orphanedEventIds: string[] = [];

    for (let i = 0; i < eventIds.length; i++) {
      const eventId = eventIds[i];
      const eventData = eventDataArray[i];
      if (eventData) {
        const event: QueuedEvent = JSON.parse(eventData);
        // Skip events scheduled for future processing (scheduledAt > now)
        if (event.scheduledAt <= Date.now()) {
          events.push(event);
          validEventIds.push(eventId);
        }
      } else {
        // Event data is missing, mark for removal
        orphanedEventIds.push(eventId);
      }
    }

    const multi = this.store.multi();
    const timestamp = Date.now();
    const processingQueueKey = this.processingQueueKeys[eventType];

    // Batch remove valid event IDs from the queue and add to the processing queue
    for (const eventId of validEventIds) {
      multi.zrem(pendingQueueKey, eventId);
      multi.zadd(processingQueueKey, timestamp, eventId);
    }

    // Remove orphaned event IDs from the queue (missing data)
    if (orphanedEventIds.length > 0) {
      for (const eventId of orphanedEventIds) {
        multi.zrem(pendingQueueKey, eventId);
      }
      this.logger.warn('Removed orphaned event IDs (missing data)', {
        eventType,
        orphanedCount: orphanedEventIds.length,
        orphanedIds: orphanedEventIds,
        pendingQueueKey,
      });
    }

    // Execute all operations atomically in one round trip
    await multi.exec();

    this.logger.debug('Events dequeued', {
      count: events.length,
      pendingQueueKey,
    });

    return events;
  }

  /**
   * Acknowledge event processing completion
   */
  async acknowledgeProcessedEvent(event: QueuedEvent): Promise<void> {
    // Remove event ID from processing queue and delete event data (atomic operation)
    const processingQueueKey = this.processingQueueKeys[event.type];
    await this.store.multi().zrem(processingQueueKey, event.id).hdel(this.dataKey, event.id).exec();
    await this.updateStatus('processed');
    this.logger.debug('Event acknowledged', { eventId: event.id });
  }

  /**
   * Move event to the dead letter queue
   */
  async moveToDeadLetterQueue(event: QueuedEvent, error: string): Promise<void> {
    const processingQueueKey = this.processingQueueKeys[event.type];

    const deadLetterEvent = { ...event, error, movedAt: Date.now() };
    await this.store
      .multi()
      .zrem(processingQueueKey, event.id)
      .zadd(this.deadLetterQueueKey, Date.now(), event.id)
      .hset(this.dataKey, event.id, JSON.stringify(deadLetterEvent))
      .exec();

    await this.updateStatus('deadLetter');
    this.logger.warn('Event moved to dead letter queue', { eventId: event.id, error });
  }

  /**
   * Get queue status
   */
  async getQueueStatus(): Promise<QueueStatus> {
    // Sum up lengths from all type-specific queues
    let totalQueueLength = 0;
    for (const pendingQueueKey of Object.values(this.pendingQueueKeys)) {
      totalQueueLength += await this.store.zcard(pendingQueueKey);
    }

    // Sum up lengths from all type-specific processing queues
    let totalProcessingLength = 0;
    for (const processingQueueKey of Object.values(this.processingQueueKeys)) {
      totalProcessingLength += await this.store.zcard(processingQueueKey);
    }

    const deadLetterLength = await this.store.zcard(this.deadLetterQueueKey);

    // Get the last processed timestamp from status
    const statusData = await this.store.get(this.statusKey);
    const status = statusData ? JSON.parse(statusData) : {};

    return {
      queueLength: totalQueueLength,
      processingRate: 0, // TODO: Calculate from metrics
      errorRate: 0, // TODO: Calculate from metrics
      consumerCount: totalProcessingLength,
      deadLetterQueueLength: deadLetterLength,
      lastProcessedAt: status.lastProcessedAt,
    };
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    await this.store.quit();
  }

  /**
   * Update processing status
   */
  private async updateStatus(action: 'processed' | 'deadLetter'): Promise<void> {
    const status = {
      lastProcessedAt: Date.now(),
      lastAction: action,
    };
    await this.store.set(this.statusKey, JSON.stringify(status));
  }
}
