import { jsonifyError, Logger } from '@mark/logger';
import { EventQueue, QueuedEvent } from '#/queue';
import { EventProcessingResult, EventProcessor } from '#/processor';
import { WebhookEventType } from '@mark/core';

// Debounce delay for scheduling pending work (prevents unbounded task spawning)
const PENDING_WORK_DEBOUNCE_MS = 100;

export class EventConsumer {
  private isProcessing = false;
  // The total number of events being processed across all event types
  private totalActive = 0;
  // The number of events being processed per event type
  private readonly activeCounts: Record<WebhookEventType, number> = {} as Record<WebhookEventType, number>;
  // Debounce timers for pending work per event type (prevents unbounded async spawning)
  private readonly pendingWorkTimers: Map<WebhookEventType, NodeJS.Timeout> = new Map();

  constructor(
    private readonly queue: EventQueue,
    private readonly processor: EventProcessor,
    private readonly logger: Logger,
    private readonly maxConcurrentEvents: number = 5,
  ) {
    // Initialize counts per queue for each event type
    for (const eventType of Object.values(WebhookEventType)) {
      this.activeCounts[eventType] = 0;
    }
  }

  /**
   * Start consuming events from the queue
   */
  async start(): Promise<void> {
    if (this.isProcessing) {
      this.logger.warn('Consumer is already running');
      return;
    }

    this.isProcessing = true;
    this.logger.info('Starting event consumer', {
      maxConcurrentEvents: this.maxConcurrentEvents,
      totalMaxConcurrent: this.maxConcurrentEvents * Object.values(WebhookEventType).length,
    });

    // Move all events from processing queues back to pending queues
    await this.queue.moveProcessingToPending();

    // Process any pending events from the queue on the start
    await this.processPendingEvents();
  }

  /**
   * Stop consuming events
   */
  async stop(): Promise<void> {
    if (!this.isProcessing) {
      this.logger.warn('Consumer is already being stopped or not running, skipping stop');
      return;
    }

    this.isProcessing = false;
    this.logger.info('Stopping event consumer');

    // Clear any pending work timers to prevent new processing
    this.clearPendingWorkTimers();

    // Wait for active processing to complete (with timeout)
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();
    while (this.totalActive > 0 && Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.totalActive > 0) {
      this.logger.warn('Some events are still processing after stop', {
        activeCount: this.totalActive,
        perQueue: this.activeCounts,
      });
    }
  }

  /**
   * Adds a new event (called when the event arrives)
   * Enqueues the event and processes it immediately if under concurrent
   * limit for this event type and the event was not in the queue previously.
   */
  async addEvent(event: QueuedEvent): Promise<void> {
    const alreadyExists = await this.queue.enqueueEvent(event, event.priority);

    if (!this.isProcessing) {
      this.logger.warn('Consumer is not running, skipping event processing', { event });
      return;
    }

    // Don't process if the event was already in the queue
    if (alreadyExists) {
      this.logger.debug('Event already in queue, skipping processing', {
        event,
      });
      return;
    }

    const activeCount = this.activeCounts[event.type];

    // If we're at the concurrent limit for this event type, skip immediate processing
    if (activeCount >= this.maxConcurrentEvents) {
      this.logger.debug('Concurrent limit reached for event type', {
        event,
        activeCount,
        maxConcurrent: this.maxConcurrentEvents,
      });
      return;
    }

    // Process immediately with proper error handling
    this.processEventSafely(event);
  }

  /**
   * Process an event with proper error handling for fire-and-forget scenarios.
   * Ensures that errors trigger retry logic instead of being silently logged.
   */
  private processEventSafely(event: QueuedEvent): void {
    this.processEvent(event).catch(async (e) => {
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger.error('Unhandled error processing event, scheduling retry', {
        eventId: event.id,
        eventType: event.type,
        retryCount: event.retryCount,
        error: jsonifyError(e),
      });

      // Trigger retry logic to ensure event is not lost
      try {
        await this.handleRetry(event, error, 60000);
      } catch (retryError) {
        this.logger.error('Failed to schedule retry for event', {
          eventId: event.id,
          eventType: event.type,
          error: jsonifyError(retryError),
        });
      }
    });
  }

  /**
   * Processes pending events from Redis queues
   * Processes events from each queue separately and in parallel, respecting per-queue concurrent limits
   */
  private async processPendingEvents(): Promise<void> {
    const eventTypes = Object.values(WebhookEventType) as WebhookEventType[];
    await Promise.all(eventTypes.map((eventType) => this.processPendingEventsForType(eventType)));
  }

  /**
   * Process pending events for a specific event type queue
   */
  private async processPendingEventsForType(eventType: WebhookEventType): Promise<void> {
    while (this.isProcessing) {
      try {
        const activeCount = this.activeCounts[eventType];
        const availableSlots = this.maxConcurrentEvents - activeCount;

        if (availableSlots <= 0) {
          break;
        }

        // Dequeue events from this specific queue
        const events = await this.queue.dequeueEvents(eventType, availableSlots);

        if (events.length === 0) {
          break; // No more events in this queue
        }

        for (const event of events) {
          this.processEventSafely(event);
        }
      } catch (e) {
        this.logger.error('Error processing pending events', {
          eventType,
          error: jsonifyError(e),
        });
        break;
      }
    }
  }

  /**
   * Process a single event
   */
  private async processEvent(event: QueuedEvent): Promise<EventProcessingResult> {
    this.totalActive++;
    this.activeCounts[event.type]++;

    try {
      this.logger.debug('Processing event', {
        event,
        retryCount: event.retryCount,
        activeCount: this.activeCounts[event.type],
        totalActive: this.totalActive,
      });

      return await this.processEventWithRetry(event);
    } finally {
      // Decrement active processing counters
      this.totalActive = Math.max(0, this.totalActive - 1);
      const updatedCount = this.activeCounts[event.type] - 1;
      this.activeCounts[event.type] = Math.max(0, updatedCount);

      // Schedule pending work with debouncing to prevent unbounded async spawning
      this.schedulePendingWork(event.type);
    }
  }

  /**
   * Process event with retry logic
   */
  private async processEventWithRetry(event: QueuedEvent): Promise<EventProcessingResult> {
    let result: EventProcessingResult;
    switch (event.type) {
      case WebhookEventType.InvoiceEnqueued:
        result = await this.processor.processInvoiceEnqueued(event);
        break;
      case WebhookEventType.SettlementEnqueued:
        result = await this.processor.processSettlementEnqueued(event);
        break;
      default:
        throw new Error(`Unknown event type: ${event.type}`);
    }

    // Handle processing result
    await this.handleProcessingResult(event, result);

    return result;
  }

  /**
   * Handle the result of event processing
   */
  private async handleProcessingResult(event: QueuedEvent, result: EventProcessingResult): Promise<void> {
    if (result.success) {
      await this.queue.acknowledgeProcessedEvent(event);
      this.logger.info('Event processed successfully', {
        event,
        duration: result.duration,
      });
    } else {
      await this.handleRetry(event, new Error(result.error || 'Processing failed'), result.retryAfter);
    }
  }

  /**
   * Handle retry logic for failed events
   */
  async handleRetry(event: QueuedEvent, error: Error, retryAfter?: number): Promise<void> {
    const retryCount = event.retryCount + 1;
    if (event.maxRetries >= 0 && retryCount > event.maxRetries) {
      this.logger.error('Event exceeded max retries, moving to dead letter queue', {
        event,
        retryCount,
        maxRetries: event.maxRetries,
        error: jsonifyError(error),
      });

      await this.queue.moveToDeadLetterQueue(event, error.message);
      return;
    }

    this.logger.warn('Scheduling event retry', {
      eventId: event.id,
      eventType: event.type,
      retryCount,
      error: error.message,
    });

    event.retryCount = retryCount;
    event.scheduledAt = Date.now() + (retryAfter ?? 0);

    // Re-enqueue event
    await this.queue.enqueueEvent(event, event.priority);
  }

  /**
   * Schedule pending work for an event type with debouncing.
   * Prevents unbounded async task spawning by coalescing rapid calls.
   */
  private schedulePendingWork(eventType: WebhookEventType): void {
    // If there's already a pending timer for this event type, don't schedule another
    if (this.pendingWorkTimers.has(eventType)) {
      return;
    }

    // Schedule processing after a short debounce delay
    const timer = setTimeout(() => {
      this.pendingWorkTimers.delete(eventType);

      // Only process if we're still running
      if (!this.isProcessing) {
        return;
      }

      this.processPendingEventsForType(eventType).catch((e) => {
        this.logger.error('Error processing pending events after debounce', {
          eventType,
          error: jsonifyError(e),
        });
      });
    }, PENDING_WORK_DEBOUNCE_MS);

    this.pendingWorkTimers.set(eventType, timer);
  }

  /**
   * Clear all pending work timers (called during shutdown)
   */
  private clearPendingWorkTimers(): void {
    for (const timer of this.pendingWorkTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingWorkTimers.clear();
  }
}
