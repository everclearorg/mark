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
import { cleanupViemClients } from './helpers/contracts';
import * as database from '@mark/database';
import { bytesToHex, WalletClient } from 'viem';
import { rebalanceMantleEth } from './rebalance/mantleEth';
import { rebalanceTacUsdt } from './rebalance/tacUsdt';
import { rebalanceSolanaUsdc } from './rebalance/solanaUsdc';
import { randomBytes } from 'crypto';

export interface MarkAdapters {
  purchaseCache: PurchaseCache;
  chainService: ChainService;
  fillServiceChainService?: ChainService; // Optional: separate chain service for fill service sender
  everclear: EverclearAdapter;
  web3Signer: Web3Signer | WalletClient;
  solanaSigner?: SolanaSigner; // Optional: only initialized when Solana config is present
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

export function initializeAdapters(config: MarkConfiguration, logger: Logger): MarkAdapters {
  // Use shared base adapter initialization from agent package
  const baseAdapters = initializeBaseAdapters(config, logger, {
    serviceName: 'mark-poller',
    includeSolanaSigner: true,
  });
}

/**
 * Validates token rebalance configuration for production readiness.
 * Throws if required fields are missing when token rebalancing is enabled.
 */
function validateTokenRebalanceConfig(config: MarkConfiguration, logger: Logger): void {
  validateSingleTokenRebalanceConfig(config.tacRebalance, 'tacRebalance', config, logger);
  validateSingleTokenRebalanceConfig(config.methRebalance, 'methRebalance', config, logger);
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

  // Initialize fill service chain service if FS signer URL is configured
  // This allows TAC rebalancing to use a separate sender address for FS
  // senderAddress defaults to fillService.address if not explicitly set (same key = same address)
  let fillServiceChainService: ChainService | undefined;
  const fsSenderAddress = config.tacRebalance?.fillService?.senderAddress ?? config.tacRebalance?.fillService?.address;
  if (config.fillServiceSignerUrl && fsSenderAddress) {
    logger.info('Initializing Fill Service chain service for TAC rebalancing', {
      signerUrl: config.fillServiceSignerUrl,
      senderAddress: fsSenderAddress,
    });

    const fillServiceSigner = config.fillServiceSignerUrl.startsWith('http')
      ? new Web3Signer(config.fillServiceSignerUrl)
      : new EthWallet(config.fillServiceSignerUrl);

    fillServiceChainService = new ChainService(
      {
        chains: config.chains,
        maxRetries: 3,
        retryDelay: 15000,
        logLevel: config.logLevel,
      },
      fillServiceSigner as EthWallet,
      logger,
    );
  }

  const everclear = new EverclearAdapter(config.everclearApiUrl, logger);

  const purchaseCache = new PurchaseCache(config.redis.host, config.redis.port);

  const prometheus = new PrometheusAdapter(logger, 'mark-poller', config.pushGatewayUrl);

  const rebalance = new RebalanceAdapter(config, logger, database);

  database.initializeDatabase(config.database);

  // Initialize Solana signer if configuration is present
  let solanaSigner: SolanaSigner | undefined;
  if (config.solana?.privateKey) {
    try {
      solanaSigner = createSolanaSigner({
        privateKey: config.solana.privateKey,
        rpcUrl: config.solana.rpcUrl,
        commitment: 'confirmed',
        maxRetries: 3,
      });
      logger.info('Solana signer initialized', {
        address: solanaSigner.getAddress(),
        rpcUrl: config.solana.rpcUrl || 'https://api.mainnet-beta.solana.com',
      });
    } catch (error) {
      logger.error('Failed to initialize Solana signer', {
        error: (error as Error).message,
        // Don't log the actual error which might contain key info
      });
      // Don't throw - allow other functionality to work
    }
  } else {
    logger.debug('Solana signer not configured - Solana USDC rebalancing will not be available');
  }

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

    if (process.env.RUN_MODE === 'methOnly') {
      logger.info('Starting meth rebalancing', {
        stage: config.stage,
        environment: config.environment,
        addresses,
        fillServiceAddresses,
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
        fillServiceAddresses,
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

    if (process.env.RUN_MODE === 'solanaUsdcOnly') {
      logger.info('Starting Solana USDC → ptUSDe rebalancing', {
        stage: config.stage,
        environment: config.environment,
        addresses,
        fillServiceAddresses,
      });

      const rebalanceOperations = await rebalanceSolanaUsdc(context);
      if (rebalanceOperations.length === 0) {
        logger.info('Solana USDC Rebalancing completed: no operations needed', {
          requestId: context.requestId,
        });
      } else {
        logger.info('Successfully completed Solana USDC rebalancing operations', {
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
