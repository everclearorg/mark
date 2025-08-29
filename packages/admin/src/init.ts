import { PurchaseCache } from '@mark/cache';
import { ConfigurationError, fromEnv, LogLevel, requireEnv, cleanupHttpConnections } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { AdminConfig, AdminAdapter, AdminContext } from './types';
import * as database from '@mark/database';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { handleApiRequest } from './api';
import { bytesToHex } from 'viem';
import { getRandomValues } from 'crypto';

function initializeAdapters(config: AdminConfig): AdminAdapter {
  database.initializeDatabase(config.database);
  return {
    database,
    purchaseCache: new PurchaseCache(config.redis.host, config.redis.port),
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
    const config = {
      logLevel: ((await fromEnv('LOG_LEVEL')) ?? 'debug') as LogLevel,
      adminToken: await requireEnv('ADMIN_TOKEN'),
      redis: {
        host: await requireEnv('REDIS_HOST'),
        port: parseInt(await requireEnv('REDIS_PORT')),
      },
      database: { connectionString: await requireEnv('DATABASE_URL') },
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

  const adapters = initializeAdapters(config);

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
