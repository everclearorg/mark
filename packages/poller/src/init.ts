import { Logger } from '@mark/logger';
import {
  MarkConfiguration,
  loadConfiguration,
  cleanupHttpConnections,
  logFileDescriptorUsage,
  shouldExitForFileDescriptors,
} from '@mark/core';
import { runMigration, validateTokenRebalanceConfig, initializeBaseAdapters } from '@mark/agent';
import { SolanaSigner, ChainService } from '@mark/chainservice';
import { EverclearAdapter } from '@mark/everclear';
import { Web3Signer } from '@mark/web3signer';
import { pollAndProcessInvoices } from './invoice';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { rebalanceInventory, cleanupExpiredEarmarks, cleanupExpiredRegularRebalanceOps } from './rebalance';
import { RebalanceAdapter } from '@mark/rebalance';
import { InventoryServiceClient } from '@mark/inventory';
import { cleanupViemClients } from './helpers/contracts';
import * as database from '@mark/database';
import { bytesToHex, WalletClient } from 'viem';
import './rebalance/registrations';
import { getRegisteredRebalancers } from './rebalance/registry';
import { randomBytes } from 'crypto';

export interface MarkAdapters {
  purchaseCache: PurchaseCache;
  chainService: ChainService;
  fillServiceChainService?: ChainService; // Deprecated: same as chainService with single EOA
  everclear: EverclearAdapter;
  web3Signer: Web3Signer | WalletClient;
  solanaSigner?: SolanaSigner; // Optional: only initialized when Solana config is present
  logger: Logger;
  prometheus: PrometheusAdapter;
  rebalance: RebalanceAdapter;
  database: typeof database;
  inventory: InventoryServiceClient; // Unified inventory service client (always initialized, non-blocking)
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

export function initializeAdapters(config: MarkConfiguration, logger: Logger): MarkAdapters {
  // Use shared base adapter initialization from agent package
  const baseAdapters = initializeBaseAdapters(config, logger, {
    serviceName: 'mark-poller',
    includeSolanaSigner: true,
  });

  // Return MarkAdapters with logger added
  return {
    logger,
    ...baseAdapters,
    solanaSigner: baseAdapters.solanaSigner,
  };
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

  // Validate token rebalance config if enabled (fail fast on misconfiguration)
  validateTokenRebalanceConfig(config, logger);

  let adapters: MarkAdapters | undefined;

  try {
    adapters = initializeAdapters(config, logger);
    const addresses = await adapters.chainService.getAddress();
    const fillServiceAddresses = adapters.fillServiceChainService
      ? await adapters.fillServiceChainService.getAddress()
      : undefined;

    const context: ProcessingContext = {
      ...adapters,
      config,
      requestId: bytesToHex(randomBytes(32)),
      startTime: Math.floor(Date.now() / 1000),
    };

    await cleanupExpiredEarmarks(context);
    await cleanupExpiredRegularRebalanceOps(context);

    logger.debug('Logging run mode of the instance', { runMode: process.env.RUN_MODE });

    const runMode = process.env.RUN_MODE;
    const rebalancer = runMode ? getRegisteredRebalancers().find((r) => r.runMode === runMode) : undefined;

    if (runMode && !rebalancer && runMode !== 'rebalanceOnly') {
      const validModes = getRegisteredRebalancers().map((r) => r.runMode);
      logger.error(`Unknown RUN_MODE "${runMode}". Valid modes: ${validModes.join(', ')}, rebalanceOnly`, {
        runMode,
        validModes,
      });
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Unknown RUN_MODE: ${runMode}` }),
      };
    }

    if (rebalancer) {
      logger.info(`Starting ${rebalancer.displayName} rebalancing`, {
        stage: config.stage,
        environment: config.environment,
        addresses,
        fillServiceAddresses,
      });

      const rebalanceOperations = await rebalancer.handler(context);
      if (rebalanceOperations.length === 0) {
        logger.info(`${rebalancer.displayName} Rebalancing completed: no operations needed`, {
          requestId: context.requestId,
        });
      } else {
        logger.info(`Successfully completed ${rebalancer.displayName} rebalancing operations`, {
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
        fillServiceAddresses,
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
