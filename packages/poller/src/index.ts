import { Context, APIGatewayProxyResult, APIGatewayEvent } from 'aws-lambda';
import { MarkConfiguration, loadConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { Web3SignerAdapter } from '@mark/web3signer';
import { pollAndProcess } from './invoice/processInvoices';

async function initializeAdapters(config: MarkConfiguration, logger: Logger) {
  // Initialize adapters in the correct order
  const web3Signer = new Web3SignerAdapter(
    {
      url: config.signer,
      publicKey: config.signer,
    },
    logger,
  );

  const chainService = new ChainService(
    {
      chains: config.chains,
      maxRetries: 3,
      retryDelay: 15000,
      logLevel: config.logLevel,
    },
    web3Signer,
    logger,
  );

  const everclear = new EverclearAdapter(
    {
      apiUrl: config.everclear.url,
      apiKey: config.everclear.key ?? '',
    },
    logger,
  );

  return {
    chainService,
    web3Signer,
    everclear,
  };
}

export const handler = async (event: APIGatewayEvent, context: Context): Promise<APIGatewayProxyResult> => {
  const config = await loadConfiguration();

  const logger = new Logger({
    service: 'mark-poller',
    level: config.logLevel,
  });

  logger.info(`Event: ${JSON.stringify(event, null, 2)}`);
  logger.info(`Context: ${JSON.stringify(context, null, 2)}`);

  try {
    const adapters = await initializeAdapters(config, logger);

    logger.info('Starting invoice polling', {
      stage: config.stage,
      environment: config.environment,
    });

    const result = await pollAndProcess(config, {
      ...adapters,
      logger,
    });

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error) {
    logger.error('Failed to poll invoices', { error });

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to poll invoices' }),
    };
  }
};
