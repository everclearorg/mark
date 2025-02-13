import { Logger } from '@mark/logger';
import { MarkConfiguration, loadConfiguration } from '@mark/core';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';
import { Wallet } from 'ethers';
import { pollAndProcess } from './invoice';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';

export interface MarkAdapters {
  cache: PurchaseCache;
  chainService: ChainService;
  everclear: EverclearAdapter;
  web3Signer: Web3Signer | Wallet;
  logger: Logger;
  prometheus: PrometheusAdapter;
}

function initializeAdapters(config: MarkConfiguration, logger: Logger): MarkAdapters {
  // Initialize adapters in the correct order
  const web3Signer = config.web3SignerUrl.startsWith('http')
    ? new Web3Signer(config.web3SignerUrl)
    : new Wallet(config.web3SignerUrl);

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

  const everclear = new EverclearAdapter(config.everclearApiUrl, logger);

  const cache = new PurchaseCache(config.redis.host, config.redis.port);

  const prometheus = new PrometheusAdapter(logger, 'mark-poller', config.pushGatewayUrl);

  return {
    logger,
    chainService,
    web3Signer,
    everclear,
    cache,
    prometheus,
  };
}

export const initPoller = async (): Promise<{ statusCode: number; body: string }> => {
  const config = await loadConfiguration();

  const logger = new Logger({
    service: 'mark-poller',
    level: config.logLevel,
  });

  // TODO: sanitize sensitive vars
  logger.debug('Created config', { config });

  try {
    const adapters = initializeAdapters(config, logger);

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
  } catch (_error: unknown) {
    const error = _error as Error;
    logger.error('Failed to poll invoices', { name: error.name, message: error.message, stack: error.stack });

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to poll invoices: ' + error.message }),
    };
  }
};
