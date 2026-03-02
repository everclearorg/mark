import Redis from 'ioredis';
import { Logger } from '@mark/logger';
import { WebhookEvent, WebhookEventType } from '@mark/core';

// Default TTL for dead letter queue entries (7 days in milliseconds)
const DEFAULT_DEAD_LETTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Default TTL for dead letter queue entries (7 days in milliseconds)
const DEFAULT_INVALID_INVOICE_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  private readonly cursorKey = `${this.prefix}:backfill-cursor`;
  private readonly metricsKey = `${this.prefix}:metrics`;
  private readonly invalidInvoiceKeyPrefix = `${this.prefix}:invalid-invoice`;
  private readonly settledInvoiceKeyPrefix = `${this.prefix}:settled-invoice`;
  private readonly pausedKey = `${this.prefix}:paused`;
  private readonly store: Redis;

  constructor(
    host: string,
    port: number,
    private readonly logger: Logger,
    private readonly deadLetterTtlMs: number = DEFAULT_DEAD_LETTER_TTL_MS,
    private readonly invalidInvoiceTtlSeconds: number = DEFAULT_INVALID_INVOICE_TTL_SECONDS,
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
   * @throws Error if event validation fails
   */
  async enqueueEvent(
    event: QueuedEvent,
    priority: EventPriority = EventPriority.NORMAL,
    forceUpdate = false,
  ): Promise<boolean> {
    // Input validation
    if (!event.id || typeof event.id !== 'string' || event.id.trim() === '') {
      throw new Error('Event ID must be a non-empty string');
    }
    if (typeof event.scheduledAt !== 'number' || !Number.isFinite(event.scheduledAt) || event.scheduledAt < 0) {
      throw new Error('Event scheduledAt must be a non-negative finite number');
    }
    if (!Object.values(EventPriority).includes(priority)) {
      throw new Error(`Invalid priority: ${priority}. Must be one of: ${Object.values(EventPriority).join(', ')}`);
    }
    if (!Object.values(WebhookEventType).includes(event.type)) {
      throw new Error(`Invalid event type: ${event.type}`);
    }

    const eventWithPriority = { ...event, priority };
    const pendingQueueKey = this.pendingQueueKeys[event.type];
    const processingQueueKey = this.processingQueueKeys[event.type];

    // Check if the event already exists in the pending or processing queue
    const [isInPending, isInProcessing] = await Promise.all([
      this.store.zscore(pendingQueueKey, event.id),
      this.store.zscore(processingQueueKey, event.id),
    ]);

    const alreadyExists = isInPending !== null || isInProcessing !== null;

    // If the event already exists and this is not a forced update (e.g. from retry logic),
    // skip to avoid overwriting event data (notably retryCount) with fresh values.
    if (alreadyExists && !forceUpdate) {
      this.logger.debug('Event already in queue, skipping enqueue', {
        eventId: event.id,
        eventType: event.type,
        isInPending: isInPending !== null,
        isInProcessing: isInProcessing !== null,
      });
      return true;
    }

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
          try {
            // Parse event to get scheduledAt for proper ordering
            const event: QueuedEvent = JSON.parse(eventData);
            const score = event.scheduledAt;
            // Remove from the processing queue and add to the pending queue
            multi.zrem(processingQueueKey, eventId);
            multi.zadd(pendingQueueKey, score, eventId);
          } catch (parseError) {
            // Corrupted event data - remove from processing queue and delete data
            this.logger.error('Failed to parse event data during moveProcessingToPending, removing corrupted event', {
              eventId,
              eventType,
              error: parseError instanceof Error ? parseError.message : String(parseError),
            });
            multi.zrem(processingQueueKey, eventId);
            multi.hdel(this.dataKey, eventId);
          }
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
   * @param eventType - The type of events to dequeue
   * @param count - Maximum number of events to dequeue (must be between 1 and 1000)
   */
  async dequeueEvents(eventType: WebhookEventType, count: number): Promise<QueuedEvent[]> {
    // Input validation
    if (!Number.isInteger(count) || count <= 0) {
      return [];
    }
    if (count > 1000) {
      this.logger.warn('Dequeue count exceeds maximum, capping at 1000', { requestedCount: count });
      count = 1000;
    }
    if (!Object.values(WebhookEventType).includes(eventType)) {
      this.logger.error('Invalid event type for dequeue', { eventType });
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
        try {
          const event: QueuedEvent = JSON.parse(eventData);
          // Skip events scheduled for future processing (scheduledAt > now)
          if (event.scheduledAt <= Date.now()) {
            events.push(event);
            validEventIds.push(eventId);
          }
        } catch (parseError) {
          // Corrupted event data - mark for removal
          this.logger.error('Failed to parse event data during dequeue, marking as orphaned', {
            eventId,
            eventType,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          });
          orphanedEventIds.push(eventId);
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

    // Remove orphaned event IDs from the queue and clean up any corrupted data
    if (orphanedEventIds.length > 0) {
      for (const eventId of orphanedEventIds) {
        multi.zrem(pendingQueueKey, eventId);
        multi.hdel(this.dataKey, eventId);
      }
      this.logger.warn('Removed orphaned event IDs', {
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
   * Clean up expired entries from the dead letter queue.
   * Removes entries older than the configured TTL and their associated data.
   * @returns Number of expired entries removed
   */
  async cleanupExpiredDeadLetterEntries(): Promise<number> {
    const cutoffTimestamp = Date.now() - this.deadLetterTtlMs;

    // Get all event IDs with scores (timestamps) older than the cutoff
    // Score range: 0 to cutoffTimestamp (entries added before the cutoff)
    const expiredEventIds = await this.store.zrangebyscore(this.deadLetterQueueKey, 0, cutoffTimestamp);

    if (expiredEventIds.length === 0) {
      return 0;
    }

    // Remove expired entries from the sorted set and their data from the hash
    const multi = this.store.multi();
    for (const eventId of expiredEventIds) {
      multi.zrem(this.deadLetterQueueKey, eventId);
      multi.hdel(this.dataKey, eventId);
    }
    await multi.exec();

    this.logger.info('Cleaned up expired dead letter queue entries', {
      count: expiredEventIds.length,
      cutoffTimestamp,
      ttlMs: this.deadLetterTtlMs,
    });

    return expiredEventIds.length;
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
    let status: { lastProcessedAt?: number } = {};
    if (statusData) {
      try {
        status = JSON.parse(statusData);
      } catch (parseError) {
        this.logger.error('Failed to parse queue status data', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
      }
    }

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

  /**
   * Get the backfill cursor from Redis for persistent pagination across restarts
   * @returns The cursor string or null if not set
   */
  async getBackfillCursor(): Promise<string | null> {
    const cursor = await this.store.get(this.cursorKey);
    return cursor || null;
  }

  /**
   * Set the backfill cursor in Redis for persistent pagination across restarts
   * @param cursor The cursor value to persist (or null to clear)
   */
  async setBackfillCursor(cursor: string | null): Promise<void> {
    if (cursor) {
      await this.store.set(this.cursorKey, cursor);
    } else {
      await this.store.del(this.cursorKey);
    }
  }

  /**
   * Check if queue ingestion is paused
   */
  async isPaused(): Promise<boolean> {
    const val = await this.store.get(this.pausedKey);
    return val === '1';
  }

  /**
   * Set the paused state for queue ingestion
   */
  async setPaused(paused: boolean): Promise<void> {
    if (paused) {
      await this.store.set(this.pausedKey, '1');
    } else {
      await this.store.del(this.pausedKey);
    }
  }

  /**
   * Increment a metric counter in Redis
   * @param metricName The name of the metric
   * @param labels Optional labels for the metric
   */
  async incrementMetric(metricName: string, labels: Record<string, string> = {}): Promise<void> {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const key = labelStr ? `${this.metricsKey}:${metricName}:${labelStr}` : `${this.metricsKey}:${metricName}`;
    await this.store.incr(key);
  }

  /**
   * Record an invoice as invalid so it won't be reprocessed (e.g. by backfill).
   * @param invoiceId - The invoice ID to mark as invalid
   * @param ttlSeconds - Optional TTL in seconds (default: 7 days)
   */
  async addInvalidInvoice(invoiceId: string, ttlSeconds?: number): Promise<void> {
    const key = `${this.invalidInvoiceKeyPrefix}:${invoiceId}`;
    const ttl = ttlSeconds ?? this.invalidInvoiceTtlSeconds;
    await this.store.setex(key, ttl, '1');
    this.logger.debug('Added invalid invoice to store', { invoiceId, ttl });
  }

  /**
   * Check if an invoice has been marked as invalid.
   * @param invoiceId - The invoice ID to check
   * @returns true if the invoice is in the invalid store
   */
  async isInvalidInvoice(invoiceId: string): Promise<boolean> {
    const key = `${this.invalidInvoiceKeyPrefix}:${invoiceId}`;
    const result = await this.store.exists(key);
    return result === 1;
  }

  /**
   * Record an invoice as settled so it won't be reprocessed (e.g. by backfill).
   * Settled invoices are stored separately from invalid invoices for clarity.
   * @param invoiceId - The invoice ID to mark as settled
   * @param ttlSeconds - Optional TTL in seconds (default: 7 days)
   */
  async addSettledInvoice(invoiceId: string, ttlSeconds?: number): Promise<void> {
    const key = `${this.settledInvoiceKeyPrefix}:${invoiceId}`;
    const ttl = ttlSeconds ?? this.invalidInvoiceTtlSeconds;
    await this.store.setex(key, ttl, '1');
    this.logger.debug('Added settled invoice to store', { invoiceId, ttl });
  }

  /**
   * Check if an invoice has been marked as settled.
   * @param invoiceId - The invoice ID to check
   * @returns true if the invoice is in the settled store
   */
  async isSettledInvoice(invoiceId: string): Promise<boolean> {
    const key = `${this.settledInvoiceKeyPrefix}:${invoiceId}`;
    const result = await this.store.exists(key);
    return result === 1;
  }

  /**
   * Reset all queues: atomically delete all pending/processing sorted sets,
   * the data hash, and the backfill cursor key.
   * @returns Counts of reset events per type (pending + processing)
   */
  async resetQueues(): Promise<Record<string, { pending: number; processing: number }>> {
    // First, gather counts so we can report what was reset
    const counts: Record<string, { pending: number; processing: number }> = {};

    for (const eventType of Object.values(WebhookEventType) as WebhookEventType[]) {
      const [pending, processing] = await Promise.all([
        this.store.zcard(this.pendingQueueKeys[eventType]),
        this.store.zcard(this.processingQueueKeys[eventType]),
      ]);
      counts[eventType] = { pending, processing };
    }

    // Delete everything in a single transaction
    const multi = this.store.multi();

    for (const eventType of Object.values(WebhookEventType) as WebhookEventType[]) {
      multi.del(this.pendingQueueKeys[eventType]);
      multi.del(this.processingQueueKeys[eventType]);
    }

    multi.del(this.dataKey);
    multi.del(this.cursorKey);

    await multi.exec();

    this.logger.info('Reset all queues', { counts });

    return counts;
  }

  /**
   * Peek at the scheduledAt time of the earliest pending event for a given type.
   * Returns the score (scheduledAt timestamp) or null if the queue is empty.
   */
  async peekNextScheduledTime(eventType: WebhookEventType): Promise<number | null> {
    const pendingQueueKey = this.pendingQueueKeys[eventType];
    const result = await this.store.zrange(pendingQueueKey, 0, 0);
    if (result.length === 0) return null;
    const score = await this.store.zscore(pendingQueueKey, result[0]);
    return score !== null ? parseFloat(score) : null;
  }

  /**
   * Get queue depths for each event type (for metrics/monitoring)
   * @returns Map of event type to queue depth
   */
  async getQueueDepths(): Promise<Record<WebhookEventType, { pending: number; processing: number }>> {
    const depths: Record<WebhookEventType, { pending: number; processing: number }> = {} as Record<
      WebhookEventType,
      { pending: number; processing: number }
    >;

    for (const eventType of Object.values(WebhookEventType) as WebhookEventType[]) {
      const [pending, processing] = await Promise.all([
        this.store.zcard(this.pendingQueueKeys[eventType]),
        this.store.zcard(this.processingQueueKeys[eventType]),
      ]);
      depths[eventType] = { pending, processing };
    }

    return depths;
  }
}
