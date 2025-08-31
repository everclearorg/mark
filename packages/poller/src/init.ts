import { Logger } from '@mark/logger';
import {
  MarkConfiguration,
  loadConfiguration,
  cleanupHttpConnections,
  logFileDescriptorUsage,
  shouldExitForFileDescriptors,
  TRON_CHAINID,
} from '@mark/core';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService, EthWallet } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';
import { Wallet } from 'ethers';
import { pollAndProcessInvoices } from './invoice';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { rebalanceInventory } from './rebalance';
import { RebalanceAdapter } from '@mark/rebalance';
import { cleanupViemClients } from './helpers/contracts';
import * as database from '@mark/database';
import { bytesToHex } from 'viem';
import { execSync } from 'child_process';

export interface MarkAdapters {
  purchaseCache: PurchaseCache;
  chainService: ChainService;
  everclear: EverclearAdapter;
  web3Signer: Web3Signer | Wallet;
  logger: Logger;
  prometheus: PrometheusAdapter;
  rebalance: RebalanceAdapter;
  database: typeof database;
}
export interface ProcessingContext extends MarkAdapters {
  config: MarkConfiguration;
  requestId: string;
  startTime: number;
}

async function cleanupAdapters(adapters: MarkAdapters): Promise<void> {
  try {
    await Promise.all([adapters.purchaseCache.disconnect(), database.closeDatabase()]);
    cleanupHttpConnections();
    cleanupViemClients();
  } catch (error) {
    adapters.logger.warn('Error during adapter cleanup', { error });
  }
}

function initializeAdapters(config: MarkConfiguration, logger: Logger): MarkAdapters {
  // Initialize adapters in the correct order
  const web3Signer = config.web3SignerUrl.startsWith('http')
    ? new Web3Signer(config.web3SignerUrl)
    : new EthWallet(config.web3SignerUrl);

  // TODO: update chainservice to automatically get Tron private key from config.
  const tronPrivateKey = config.chains[TRON_CHAINID]?.privateKey;
  if (tronPrivateKey) {
    logger.info('Using Tron signer key from configuration');
    process.env.TRON_PRIVATE_KEY = tronPrivateKey;
  } else {
    logger.warn('Tron signer key is not in configuration');
  }

  const chainService = new ChainService(
    {
      chains: config.chains,
      maxRetries: 3,
      retryDelay: 15000,
      logLevel: config.logLevel,
    },
    web3Signer as EthWallet,
    logger,
  );

  const everclear = new EverclearAdapter(config.everclearApiUrl, logger);

  const purchaseCache = new PurchaseCache(config.redis.host, config.redis.port);

  const prometheus = new PrometheusAdapter(logger, 'mark-poller', config.pushGatewayUrl);

  const rebalance = new RebalanceAdapter(config, logger, database);

  database.initializeDatabase(config.database);

  return {
    logger,
    chainService,
    web3Signer: web3Signer as Web3Signer,
    everclear,
    purchaseCache,
    prometheus,
    rebalance,
    database,
  };
}

async function runMigration(logger: Logger): Promise<void> {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.warn('DATABASE_URL not found, skipping migrations');
      return;
    }

    logger.info('Running database migration...');
    const result = execSync(
      `dbmate --url "${databaseUrl}" --migrations-dir /var/task/db/migrations --no-dump-schema up`,
      { encoding: 'utf-8' },
    );
    logger.info('Database migration completed', { output: result });
  } catch (error) {
    logger.error('Failed to run database migration', { error });
    throw new Error('Database migration failed - cannot continue with out-of-sync schema');
  }
}

export const initPoller = async (): Promise<{ statusCode: number; body: string }> => {
  const config = await loadConfiguration();

  const logger = new Logger({
    service: 'mark-poller',
    level: config.logLevel,
  });

  // Run database migrations on cold start
  await runMigration(logger);

  // Check file descriptor usage at startup
  logFileDescriptorUsage(logger);

  // Exit early if file descriptor usage is too high
  if (shouldExitForFileDescriptors()) {
    logger.error('Exiting due to high file descriptor usage to prevent EMFILE errors');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'High file descriptor usage detected' }),
    };
  }

  // TODO: sanitize sensitive vars
  logger.debug('Created config', { config });

  let adapters: MarkAdapters | undefined;

  try {
    adapters = initializeAdapters(config, logger);
    const addresses = await adapters.chainService.getAddress();

    logger.info('Starting invoice polling', {
      stage: config.stage,
      environment: config.environment,
      addresses,
    });

    const context: ProcessingContext = {
      ...adapters,
      config,
      requestId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      startTime: Math.floor(Date.now() / 1000),
    };

    const invoiceResult = await pollAndProcessInvoices(context);
    logger.info('Successfully processed invoices', { requestId: context.requestId, invoiceResult });

    logFileDescriptorUsage(logger);

    const rebalanceOperations = await rebalanceInventory(context);

    if (rebalanceOperations.length === 0) {
      logger.info('Rebalancing completed: no operations needed', {
        requestId: context.requestId,
      });
    } else {
      logger.info('Successfully completed rebalancing operations', {
        requestId: context.requestId,
        numOperations: rebalanceOperations.length,
        operations: rebalanceOperations,
      });
    }

    logFileDescriptorUsage(logger);

    return {
      statusCode: 200,
      body: JSON.stringify({
        invoiceResult: invoiceResult ?? {},
        rebalanceOperations: rebalanceOperations ?? [],
      }),
    };
  } catch (_error: unknown) {
    const error = _error as Error;
    logger.error('Failed to poll invoices', { name: error.name, message: error.message, stack: error.stack });

    logFileDescriptorUsage(logger);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to poll invoices: ' + error.message }),
    };
  } finally {
    if (adapters) {
      await cleanupAdapters(adapters);
    }
  }
};
