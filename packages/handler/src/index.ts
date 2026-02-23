import fastify, { FastifyInstance } from 'fastify';
import { jsonifyError, Logger } from '@mark/logger';
import { logFileDescriptorUsage, loadConfiguration, cleanupHttpConnections } from '@mark/core';
import { cleanupViemClients } from '@mark/poller/src/helpers';
import { initializeAdapters, InvoiceHandlerAdapters } from './init';
import { runMigration, validateTokenRebalanceConfig } from '@mark/agent';
import {
  cleanupExpiredEarmarks,
  cleanupExpiredRegularRebalanceOps,
  rebalanceInventory,
} from '@mark/poller/src/rebalance';
import { checkSettledInvoices, checkPendingInvoices } from './helpers';

const logger = new Logger({ service: 'invoice-handler', level: 'debug' });

// Server port (default: 3000)
const port = parseInt(process.env.PORT || '3000', 10);

// Server host (default: 0.0.0.0)
const host = process.env.HOST || '0.0.0.0';

// Polling interval in milliseconds (default: 60 seconds)
const pollingIntervalMs = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);

let server: FastifyInstance | null = null;
let adapters: InvoiceHandlerAdapters | null = null;
let isShuttingDown = false;
let pollingInterval: NodeJS.Timeout | null = null;

/**
 * Get Fastify instance
 */
function getFastifyInstance(): FastifyInstance {
  return fastify();
}

/**
 * Initialize and start the server
 */
async function startServer(): Promise<void> {
  logger.info('Starting invoice handler server', {
    port,
    host,
  });

  try {
    adapters = await initializeInvoiceHandler();

    validateTokenRebalanceConfig(adapters.processingContext.config, logger);

    await runMigration(logger);

    if (process.env.DEBUG_FD) {
      logFileDescriptorUsage(logger);
    }

    server = getFastifyInstance();

    registerRoutes(server);

    // Start HTTP server
    await server.listen({ port, host });
    logger.info('Invoice handler server started', {
      port,
      host,
    });

    // Start the polling loop for maintenance tasks
    startPollingLoop();

    // Handle a graceful shutdown
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
  } catch (error) {
    logger.error('Failed to start server', {
      error: jsonifyError(error),
    });
    process.exit(1);
  }
}

/**
 * Register routes on the invoice handler server
 */
function registerRoutes(server: FastifyInstance): void {
  // Health check endpoint
  server.get<{
    Reply: { status: string; mode: string };
  }>(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              mode: { type: 'string' },
            },
            required: ['status', 'mode'],
          },
        },
      },
    },
    async (_, res) => {
      return res.status(200).send({ status: 'ok', mode: 'invoice-handler' });
    },
  );

  // Webhook endpoints
  server.post<{
    Params: { webhookName: string };
    Body: unknown;
    Reply: { message?: string; processed?: boolean; webhookId?: string; error?: string };
  }>(
    '/webhooks/:webhookName',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            webhookName: { type: 'string' },
          },
          required: ['webhookName'],
        },
        body: {
          type: 'object',
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              processed: { type: 'boolean' },
              webhookId: { type: 'string' },
            },
          },
          500: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
            required: ['error'],
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
            required: ['error'],
          },
        },
      },
    },
    async (req, res) => {
      if (!adapters) {
        return res.status(503).send({ error: 'Handlers not initialized' });
      }

      const webhookName = req.params.webhookName;
      // Goldsky subgraph webhooks send the secret in the 'goldsky-webhook-secret' header
      const webhookSecretHeader =
        (req.headers['goldsky-webhook-secret'] as string) || (req.headers['Goldsky-Webhook-Secret'] as string);
      const rawBody = JSON.stringify(req.body);

      logger.info('Processing webhook request', {
        webhookName,
        path: req.url,
        hasSignature: !!webhookSecretHeader,
      });

      try {
        const result = await adapters.webhookHandler.handleWebhookRequest(rawBody, webhookSecretHeader, webhookName);
        return res.status(result.statusCode).send(JSON.parse(result.body));
      } catch (error) {
        logger.error('Failed to handle webhook request', {
          error: jsonifyError(error),
        });

        return res.status(500).send({
          error: 'Internal server error',
        });
      }
    },
  );
}

/**
 * Initialize invoice handler
 */
async function initializeInvoiceHandler(): Promise<InvoiceHandlerAdapters> {
  logger.info('Initializing invoice handler');

  const config = await loadConfiguration();

  // Initialize handler adapters
  const handlerAdapters = await initializeAdapters(config, logger);

  // Start event consumer
  await handlerAdapters.eventConsumer.start();

  logger.info('Invoice handler initialized successfully', {
    stage: config.stage,
    environment: config.environment,
  });

  return handlerAdapters;
}

/**
 * Start a polling loop for maintenance tasks
 */
function startPollingLoop(): void {
  logger.info('Starting polling loop', {
    intervalMs: pollingIntervalMs,
  });

  // Run immediately on startup
  runMaintenanceTasks().catch((error) => {
    logger.error('Error in initial maintenance tasks run', {
      error: jsonifyError(error),
    });
  });

  // Then run periodically
  pollingInterval = setInterval(() => {
    runMaintenanceTasks().catch((error) => {
      logger.error('Error in maintenance tasks loop', {
        error: jsonifyError(error),
      });
    });
  }, pollingIntervalMs);
}

/**
 * Run maintenance tasks
 */
async function runMaintenanceTasks(): Promise<void> {
  if (!adapters || isShuttingDown) {
    return;
  }

  try {
    const context = adapters.processingContext;

    // Log file descriptor usage
    logFileDescriptorUsage(context.logger);

    // Collect and push queue health metrics
    await collectQueueMetrics(adapters);

    // Check for pending invoices and enqueue missed InvoiceEnqueued events
    await checkPendingInvoices(adapters);

    // Check for settled invoices and enqueue missed SettlementEnqueued events
    await checkSettledInvoices(adapters);

    // Clean up expired earmarks
    await cleanupExpiredEarmarks(context);

    // Clean up expired dead letter queue entries
    await adapters.eventQueue.cleanupExpiredDeadLetterEntries();

    // Cleanup expired regular rebalance operations
    await cleanupExpiredRegularRebalanceOps(context);

    // Rebalance inventory
    const rebalanceOperations = await rebalanceInventory(context);

    if (rebalanceOperations.length === 0) {
      context.logger.debug('Rebalancing completed: no operations needed', {
        requestId: context.requestId,
      });
    } else {
      context.logger.info('Successfully completed rebalancing operations', {
        requestId: context.requestId,
        numOperations: rebalanceOperations.length,
        operations: rebalanceOperations,
      });
    }
  } catch (error) {
    logger.error('Error running maintenance tasks', {
      error: jsonifyError(error),
    });
  }
}

/**
 * Collect and push queue health metrics to Prometheus
 */
async function collectQueueMetrics(adapters: InvoiceHandlerAdapters): Promise<void> {
  try {
    const { eventQueue, processingContext } = adapters;
    const { prometheus, logger: contextLogger } = processingContext;

    // Get queue depths for each event type
    const queueDepths = await eventQueue.getQueueDepths();
    const queueStatus = await eventQueue.getQueueStatus();

    // Update Prometheus metrics for each event type
    for (const [eventType, depths] of Object.entries(queueDepths)) {
      await prometheus.updateEventQueueDepth(eventType, 'pending', depths.pending);
      await prometheus.updateEventQueueDepth(eventType, 'processing', depths.processing);
    }

    // Update dead letter queue metric
    await prometheus.updateDeadLetterQueueSize(queueStatus.deadLetterQueueLength);

    // Log queue status for visibility
    contextLogger.debug('Queue health metrics collected', {
      queueDepths,
      deadLetterQueueLength: queueStatus.deadLetterQueueLength,
      lastProcessedAt: queueStatus.lastProcessedAt,
    });
  } catch (error) {
    logger.warn('Failed to collect queue metrics', {
      error: jsonifyError(error),
    });
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info('Starting graceful shutdown');

  try {
    // Stop polling loop
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
      logger.info('Polling loop stopped');
    }

    // Close HTTP server
    if (server) {
      await server.close();
      logger.info('HTTP server closed');
    }

    // Cleanup adapters
    if (adapters) {
      await Promise.all([
        adapters.eventConsumer.stop(),
        adapters.eventQueue.disconnect(),
        adapters.processingContext.purchaseCache.disconnect(),
        adapters.processingContext.database.closeDatabase(),
      ]);
      cleanupHttpConnections();
      cleanupViemClients();
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Start the server
startServer().catch((error) => {
  logger.error('Failed to start server', {
    error: error instanceof Error ? error.message : 'Unknown error',
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
