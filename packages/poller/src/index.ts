import { Context, APIGatewayEvent } from 'aws-lambda';
import { initPoller } from './init';

export async function handler(event: APIGatewayEvent, context: Context) {
  console.log(`Event: ${JSON.stringify(event, null, 2)}`);
  console.log(`Context: ${JSON.stringify(context, null, 2)}`);

  const result = await initPoller();

  return result;
}
