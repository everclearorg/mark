import { Logger } from '@mark/logger';
import { Context, ScheduledEvent } from 'aws-lambda';
import { initPoller } from './init';
import { datadog } from 'datadog-lambda-js';
import tracer from 'dd-trace';

tracer.init({
  logInjection: true,
  runtimeMetrics: true,
});

const _handler = async (event: ScheduledEvent, context: Context) => {
  const logger = new Logger({
    service: 'poller-lambda',
    level: 'info',
  });

  logger.info('Initializing poller', {
    event,
    context,
  });
  const result = await initPoller();
  logger.info('Completed poller', {
    event,
    context,
    result,
  });
  return result;
};

export const handler = datadog(_handler);
