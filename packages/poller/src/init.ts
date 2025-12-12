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
import { pollAndProcessInvoices } from './invoice';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { rebalanceInventory, cleanupExpiredEarmarks, cleanupExpiredRegularRebalanceOps } from './rebalance';
import { RebalanceAdapter } from '@mark/rebalance';
import { cleanupViemClients } from './helpers/contracts';
import * as database from '@mark/database';
import { execSync } from 'child_process';
import { bytesToHex, WalletClient } from 'viem';
import { rebalanceMantleEth } from './rebalance/mantleEth';
import { rebalanceTacUsdt } from './rebalance/tacUsdt';
import { randomBytes } from 'crypto';
import { resolve } from 'path';

export interface MarkAdapters {
  purchaseCache: PurchaseCache;
  chainService: ChainService;
  everclear: EverclearAdapter;
  web3Signer: Web3Signer | WalletClient;
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

/**
 * Validates TAC rebalance configuration for production readiness.
 * Throws if required fields are missing when TAC rebalancing is enabled.
 */
function validateTacRebalanceConfig(config: MarkConfiguration, logger: Logger): void {
  const tacConfig = config.tacRebalance;

  // Skip validation if TAC rebalancing is disabled
  if (!tacConfig?.enabled) {
    logger.debug('TAC rebalancing disabled, skipping config validation');
    return;
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate Market Maker config
  const mm = tacConfig.marketMaker;
  if (!mm?.address) {
    errors.push('tacRebalance.marketMaker.address is required when TAC rebalancing is enabled');
  }

  if (mm?.thresholdEnabled) {
    if (!mm.threshold) {
      errors.push('tacRebalance.marketMaker.threshold is required when thresholdEnabled=true');
    }
    if (!mm.targetBalance) {
      errors.push('tacRebalance.marketMaker.targetBalance is required when thresholdEnabled=true');
    }
  }

  // Validate Fill Service config
  const fs = tacConfig.fillService;
  if (!fs?.address) {
    errors.push('tacRebalance.fillService.address is required when TAC rebalancing is enabled');
  }

  if (fs?.thresholdEnabled) {
    if (!fs.threshold) {
      errors.push('tacRebalance.fillService.threshold is required when thresholdEnabled=true');
    }
    if (!fs.targetBalance) {
      errors.push('tacRebalance.fillService.targetBalance is required when thresholdEnabled=true');
    }
  }

  // Validate Bridge config
  const bridge = tacConfig.bridge;
  if (!bridge?.minRebalanceAmount) {
    errors.push('tacRebalance.bridge.minRebalanceAmount is required');
  }

  // Validate TON config (required for TAC bridging)
  if (!config.ownTonAddress) {
    errors.push('ownTonAddress (TON_SIGNER_ADDRESS) is required for TAC rebalancing');
  }

  if (!config.ton?.mnemonic) {
    errors.push('ton.mnemonic (TON_MNEMONIC) is required for TAC Leg 2 signing');
  }

  // Warnings for common misconfigurations
  if (mm?.address && config.ownAddress && mm.address.toLowerCase() !== config.ownAddress.toLowerCase()) {
    warnings.push(
      `MM address (${mm.address}) differs from ownAddress (${config.ownAddress}). ` +
        'Funds sent to MM may not be usable for intent filling by this Mark instance.',
    );
  }

  // Log warnings
  for (const warning of warnings) {
    logger.warn('TAC config warning', { warning });
  }

  // Throw if errors
  if (errors.length > 0) {
    const errorMessage = `TAC rebalance config validation failed:\n  - ${errors.join('\n  - ')}`;
    logger.error('TAC config validation failed', { errors });
    throw new Error(errorMessage);
  }

  logger.info('TAC rebalance config validated successfully', {
    mmAddress: mm?.address,
    fsAddress: fs?.address,
    mmOnDemand: mm?.onDemandEnabled,
    mmThreshold: mm?.thresholdEnabled,
    fsThreshold: fs?.thresholdEnabled,
    minRebalanceAmount: bridge?.minRebalanceAmount,
  });
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

    // default to aws lambda environment path
    const db_migration_path = process.env.DATABASE_MIGRATION_PATH ?? '/var/task/db/migrations';

    let cwdOption: { cwd?: string } = {};

    // if an explicit db migration path is provided, set the cwd on execSync so it can be used for migrations
    if (process.env.DATABASE_MIGRATION_PATH) {
      const workspaceRoot = resolve(process.cwd(), '../..');
      const databasePackageDir = resolve(workspaceRoot, 'packages/adapters/database');
      cwdOption.cwd = databasePackageDir;
    }

    logger.info(`Running database migrations from ${db_migration_path}...`);

    const result = execSync(`dbmate --url "${databaseUrl}" --migrations-dir ${db_migration_path} --no-dump-schema up`, {
      encoding: 'utf-8',
      ...cwdOption,
    });

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

  // Validate TAC rebalance config if enabled (fail fast on misconfiguration)
  validateTacRebalanceConfig(config, logger);

  let adapters: MarkAdapters | undefined;

  try {
    adapters = initializeAdapters(config, logger);
    const addresses = await adapters.chainService.getAddress();

    const context: ProcessingContext = {
      ...adapters,
      config,
      requestId: bytesToHex(randomBytes(32)),
      startTime: Math.floor(Date.now() / 1000),
    };

    await cleanupExpiredEarmarks(context);
    await cleanupExpiredRegularRebalanceOps(context);

    if (process.env.RUN_MODE === 'methOnly') {
      logger.info('Starting meth rebalancing', {
        stage: config.stage,
        environment: config.environment,
        addresses,
      });

      const rebalanceOperations = await rebalanceMantleEth(context);
      if (rebalanceOperations.length === 0) {
        logger.info('Meth Rebalancing completed: no operations needed', {
          requestId: context.requestId,
        });
      } else {
        logger.info('Successfully completed meth rebalancing operations', {
          requestId: context.requestId,
          numOperations: rebalanceOperations.length,
          operations: rebalanceOperations,
        });
      }

      logFileDescriptorUsage(logger);

      return {
        statusCode: 200,
        body: JSON.stringify({
          rebalanceOperations: rebalanceOperations ?? [],
        }),
      };
    }

    if (process.env.RUN_MODE === 'tacOnly') {
      logger.info('Starting TAC USDT rebalancing', {
        stage: config.stage,
        environment: config.environment,
        addresses,
      });

      const rebalanceOperations = await rebalanceTacUsdt(context);
      if (rebalanceOperations.length === 0) {
        logger.info('TAC USDT Rebalancing completed: no operations needed', {
          requestId: context.requestId,
        });
      } else {
        logger.info('Successfully completed TAC USDT rebalancing operations', {
          requestId: context.requestId,
          numOperations: rebalanceOperations.length,
          operations: rebalanceOperations,
        });
      }

      logFileDescriptorUsage(logger);

      return {
        statusCode: 200,
        body: JSON.stringify({
          rebalanceOperations: rebalanceOperations ?? [],
        }),
      };
    }

    let invoiceResult;

    if (process.env.RUN_MODE !== 'rebalanceOnly') {
      logger.info('Starting invoice polling', {
        stage: config.stage,
        environment: config.environment,
        addresses,
      });

      invoiceResult = await pollAndProcessInvoices(context);
      logger.info('Successfully processed invoices', { requestId: context.requestId, invoiceResult });

      logFileDescriptorUsage(logger);
    }

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
    logger.error('Failed to poll', { name: error.name, message: error.message, stack: error.stack });

    logFileDescriptorUsage(logger);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to poll: ' + error.message }),
    };
  } finally {
    if (adapters) {
      await cleanupAdapters(adapters);
    }
  }
};
