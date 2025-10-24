import { PurchaseCache } from '@mark/cache';
import { ConfigurationError, fromEnv, LogLevel, requireEnv, cleanupHttpConnections, loadConfiguration as loadMarkConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { AdminConfig, AdminAdapter, AdminContext } from './types';
import * as database from '@mark/database';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { handleApiRequest } from './api';
import { bytesToHex } from 'viem';
import { getRandomValues } from 'crypto';
import { ChainService, EthWallet } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';
import { RebalanceAdapter } from '@mark/rebalance';

function initializeAdapters(config: AdminConfig, logger: Logger): AdminAdapter {
  database.initializeDatabase(config.database);

  // Initialize web3signer and chainService
  const web3Signer = config.markConfig.web3SignerUrl.startsWith('http')
    ? new Web3Signer(config.markConfig.web3SignerUrl)
    : new EthWallet(config.markConfig.web3SignerUrl);

  const chainService = new ChainService(
    {
      chains: config.markConfig.chains,
      maxRetries: 3,
      retryDelay: 15000,
      logLevel: config.logLevel,
    },
    web3Signer as EthWallet,
    logger,
  );

  // Initialize rebalance adapter
  const rebalanceAdapter = new RebalanceAdapter(config.markConfig, logger, database);

  return {
    database,
    purchaseCache: new PurchaseCache(config.redis.host, config.redis.port),
    chainService,
    rebalanceAdapter,
  };
}

async function cleanupAdapters(adapters: AdminAdapter): Promise<void> {
  try {
    await Promise.all([adapters.purchaseCache.disconnect(), database.closeDatabase()]);
    cleanupHttpConnections();
  } catch (error) {
    console.warn('Error during adapter cleanup:', error);
  }
}

async function loadConfiguration(): Promise<AdminConfig> {
  try {
    // Load the full Mark configuration (for chainService)
    const markConfig = await loadMarkConfiguration();

    const whitelistedRecipientsRaw = await fromEnv('WHITELISTED_RECIPIENTS');
    const whitelistedRecipients = whitelistedRecipientsRaw
      ? whitelistedRecipientsRaw.split(',').map((addr) => addr.trim())
      : undefined;

    const config = {
      logLevel: markConfig.logLevel,
      adminToken: await requireEnv('ADMIN_TOKEN'),
      redis: markConfig.redis,
      database: markConfig.database,
      whitelistedRecipients,
      markConfig,
    };
    return config;
  } catch (e) {
    const error = e as Error;
    throw new ConfigurationError(`Failed to load admin api configuration: ${error.message}`, {
      error: jsonifyError(error),
    });
  }
}

export const initAdminApi = async (event: APIGatewayProxyEvent): Promise<{ statusCode: number; body: string }> => {
  // Get the config
  const config = await loadConfiguration();

  // Create the logger
  const logger = new Logger({
    service: 'mark-admin',
    level: config.logLevel,
  });

  const adapters = initializeAdapters(config, logger);

  try {
    const context: AdminContext = {
      ...adapters,
      event,
      // lambdaContext,
      logger,
      config,
      requestId: bytesToHex(getRandomValues(new Uint8Array(32))),
      startTime: Math.floor(Date.now() / 1000),
    };
    logger.info('Context initiatlized', { requestId: context.requestId, event, context });

    return await handleApiRequest(context);
  } finally {
    await cleanupAdapters(adapters);
  }
};
