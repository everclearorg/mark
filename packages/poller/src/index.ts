import { Logger } from '@mark/logger';
import { Context, ScheduledEvent } from 'aws-lambda';
import { initPoller } from './init';

export async function handler(event: ScheduledEvent, context: Context) {
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
}
