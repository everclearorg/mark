import { Logger } from '../../adapters/logger/src';
import { MarkConfiguration, loadConfiguration } from '@mark/core';
import { pollAndProcess } from './invoice/processInvoices';
import { EverclearAdapter } from '../../adapters/everclear/src';
import { TransactionServiceAdapter } from '../../adapters/txservice/src';
import { Web3SignerAdapter } from '../../adapters/web3signer/src';

async function initializeAdapters(config: MarkConfiguration, logger: Logger) {
  // Initialize adapters in the correct order
  const web3Signer = new Web3SignerAdapter(
    {
      url: config.signer,
      publicKey: config.signer,
    },
    logger,
  );

  const txService = new TransactionServiceAdapter(
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
    txService,
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

    const result = await pollAndProcess(
      {
        batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
      },
      {
        ...adapters,
        logger,
      },
    );

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
