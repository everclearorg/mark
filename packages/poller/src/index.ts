import { Logger } from '@mark/logger';
import { MarkConfiguration, loadConfiguration } from '@mark/core';
import { pollAndProcess } from './invoice/processInvoices';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';

async function initializeAdapters(config: MarkConfiguration, logger: Logger) {
  // Initialize adapters in the correct order
  const web3Signer = new Web3Signer(config.web3SignerUrl);

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function handler(_event: unknown) {
  const config = await loadConfiguration();

  const logger = new Logger({
    service: 'mark-poller',
    level: config.logLevel,
  });

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
}
