import { Logger } from '@mark/logger';
import { logFileDescriptorUsage, shouldExitForFileDescriptors } from '@mark/core';
import { initPoller } from './init';
import { ScheduledEvent, Context } from 'aws-lambda';

const logger = new Logger({ service: 'mark-poller-handler', level: 'debug' });

export const handler = async (event: ScheduledEvent, context: Context) => {
  const requestId = context.awsRequestId;

  // Log file descriptors at start of invocation
  if (process.env.DEBUG_FD) {
    logFileDescriptorUsage(logger);
  }

  logger.info('Poller handler invoked', { requestId, event });

  try {
    // Check if we should exit due to file descriptor issues
    if (shouldExitForFileDescriptors()) {
      logger.error('Exiting due to file descriptor limit concerns');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'File descriptor limit exceeded' }),
      };
    }

    // Log FDs after config load
    if (process.env.DEBUG_FD) {
      logFileDescriptorUsage(logger);
    }

    const result = await initPoller();

    logger.info('Poller execution completed successfully', { requestId, result });

    return result;
  } catch (_error: unknown) {
    const error = _error as Error;
    logger.error('Poller execution failed', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Poller execution failed',
        message: error.message,
        requestId,
      }),
    };
  } finally {
    // Log file descriptors at end of invocation
    if (process.env.DEBUG_FD) {
      logFileDescriptorUsage(logger);
    }
  }
};
