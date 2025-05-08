import { Logger } from '@mark/logger';
import { MarkConfiguration, loadConfiguration } from '@mark/core';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';
import { Signer, Wallet } from 'ethers';
import { pollAndProcessInvoices } from './invoice';
import { PurchaseCache, RebalanceCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { hexlify, randomBytes } from 'ethers/lib/utils';
import { rebalanceInventory } from './rebalance';
import { RebalanceAdapter } from '@mark/adapters-rebalance';

export interface MarkAdapters {
  purchaseCache: PurchaseCache;
  rebalanceCache: RebalanceCache;
  chainService: ChainService;
  everclear: EverclearAdapter;
  web3Signer: Web3Signer | Wallet;
  logger: Logger;
  prometheus: PrometheusAdapter;
  rebalance: RebalanceAdapter;
}
export interface ProcessingContext extends MarkAdapters {
  config: MarkConfiguration;
  requestId: string;
  startTime: number;
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
    web3Signer as unknown as Signer,
    logger,
  );

  const everclear = new EverclearAdapter(config.everclearApiUrl, logger);

  const purchaseCache = new PurchaseCache(config.redis.host, config.redis.port);
  const rebalanceCache = new RebalanceCache(config.redis.host, config.redis.port);

  const prometheus = new PrometheusAdapter(logger, 'mark-poller', config.pushGatewayUrl);

  const rebalance = new RebalanceAdapter(config.environment, config.chains, logger);

  return {
    logger,
    chainService,
    web3Signer,
    everclear,
    purchaseCache,
    rebalanceCache,
    prometheus,
    rebalance,
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

    const context: ProcessingContext = {
      ...adapters,
      config,
      requestId: hexlify(randomBytes(32)),
      startTime: Math.floor(Date.now() / 1000),
    };

    const invoiceResult = await pollAndProcessInvoices(context);
    logger.info('Successfully processed invoices', { requestId: context.requestId, invoiceResult });

    const rebalanceResult = await rebalanceInventory(context);
    logger.info('Successfully rebalanced inventory', { requestId: context.requestId, rebalanceResult });

    return {
      statusCode: 200,
      body: JSON.stringify({
        invoiceResult: invoiceResult ?? {},
        rebalanceResult: rebalanceResult ?? {},
      }),
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
