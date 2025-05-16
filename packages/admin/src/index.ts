import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { initAdminApi } from './init';
import { Logger } from '@mark/logger';

export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  const logger = new Logger({
    service: 'mark-admin',
    level: 'info',
  });
  logger.info('Handling api request', { event, context });

  const result = await initAdminApi(event);
  logger.info('Completed poller', {
    event,
    context,
    result,
  });
  return result;
};
