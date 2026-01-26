import { Logger } from '@mark/logger';
import { MarkConfiguration, WebhookEvent, WebhookEventType } from '@mark/core';
import { initializeBaseAdapters } from '@mark/agent';
import { bytesToHex } from 'viem';
import { randomBytes } from 'crypto';
import { WebhookHandler } from '@mark/webhooks';
import { EventQueue, EventPriority, type QueuedEvent } from './queue';
import { EventProcessor } from './processor';
import { EventConsumer } from './consumer';
import { ProcessingContext } from '@mark/poller/src/init';

export interface InvoiceHandlerAdapters {
  processingContext: ProcessingContext;
  webhookHandler: WebhookHandler;
  eventQueue: EventQueue;
  eventProcessor: EventProcessor;
  eventConsumer: EventConsumer;
}

export async function initializeAdapters(config: MarkConfiguration, logger: Logger): Promise<InvoiceHandlerAdapters> {
  // Use shared base adapter initialization
  const baseAdapters = initializeBaseAdapters(config, logger, {
    serviceName: 'mark-handler',
    includeSolanaSigner: false,
  });

  const webhookLogger = new Logger({
    service: 'mark-webhook-handler',
    level: config.logLevel,
  });

  // Initialize the pending queue service first
  const eventQueue = new EventQueue(config.redis.host, config.redis.port, logger);

  // Create processing context for the event processor
  const processingContext: ProcessingContext = {
    purchaseCache: baseAdapters.purchaseCache,
    chainService: baseAdapters.chainService,
    fillServiceChainService: baseAdapters.fillServiceChainService,
    everclear: baseAdapters.everclear,
    web3Signer: baseAdapters.web3Signer,
    logger,
    prometheus: baseAdapters.prometheus,
    rebalance: baseAdapters.rebalance,
    database: baseAdapters.database,
    config,
    requestId: bytesToHex(randomBytes(32)),
    startTime: Math.floor(Date.now() / 1000),
  };

  // Initialize event processor
  const eventProcessor = new EventProcessor(processingContext);

  // Initialize event consumer
  const eventConsumer = new EventConsumer(eventQueue, eventProcessor, logger);

  // Create the processEvent callback that calls eventConsumer.addEvent
  const processEvent = async (id: string, type: WebhookEventType, data: WebhookEvent) => {
    const queuedEvent: QueuedEvent = {
      id,
      type,
      data,
      priority: EventPriority.NORMAL,
      retryCount: 0,
      maxRetries: -1,
      scheduledAt: Date.now(),
      metadata: {
        source: 'goldsky-webhook',
      },
    };

    await eventConsumer.addEvent(queuedEvent);
    webhookLogger.info('Event received from webhook', {
      eventId: queuedEvent.id,
      eventType: queuedEvent.type,
    });
  };

  // Initialize webhook handler
  const webhookSecret = config.goldskyWebhookSecret || '';
  if (!webhookSecret) {
    logger.warn('Goldsky webhook secret not configured - webhook authentication will fail');
  }
  const webhookHandler = new WebhookHandler(webhookSecret, logger, { processEvent });

  return {
    processingContext,
    webhookHandler,
    eventQueue,
    eventProcessor,
    eventConsumer,
  };
}
