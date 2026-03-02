import { Logger } from '@mark/logger';
import { MarkConfiguration, TRON_CHAINID } from '@mark/core';
import { ChainService, EthWallet, SolanaSigner, createSolanaSigner } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';
import { EverclearAdapter } from '@mark/everclear';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { RebalanceAdapter } from '@mark/rebalance';
import * as database from '@mark/database';

/**
 * Base adapters that are common to both poller and handler
 */
export interface BaseAdapters {
  chainService: ChainService;
  fillServiceChainService?: ChainService;
  everclear: EverclearAdapter;
  purchaseCache: PurchaseCache;
  prometheus: PrometheusAdapter;
  rebalance: RebalanceAdapter;
  database: typeof database;
  web3Signer: Web3Signer;
}

/**
 * Options for initializing base adapters
 */
export interface BaseAdapterOptions {
  serviceName: string; // e.g., 'mark-poller' or 'mark-handler'
  includeSolanaSigner?: boolean; // Whether to initialize Solana signer (default: false)
}

/**
 * Initialize base adapters that are common to both poller and handler
 */
export function initializeBaseAdapters(
  config: MarkConfiguration,
  logger: Logger,
  options: BaseAdapterOptions,
): BaseAdapters & { solanaSigner?: SolanaSigner } {
  // Initialize web3signer
  const web3Signer = config.web3SignerUrl.startsWith('http')
    ? new Web3Signer(config.web3SignerUrl)
    : new EthWallet(config.web3SignerUrl);

  // Set Tron private key if configured
  const tronPrivateKey = config.chains[TRON_CHAINID]?.privateKey;
  if (tronPrivateKey) {
    logger.info('Using Tron signer key from configuration');
    process.env.TRON_PRIVATE_KEY = tronPrivateKey;
  } else {
    logger.warn('Tron signer key is not in configuration');
  }

  // Initialize chain service
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

  // Initialize fill service chain service if configured
  let fillServiceChainService: ChainService | undefined;
  const fsSenderAddress = config.tacRebalance?.fillService?.senderAddress ?? config.tacRebalance?.fillService?.address;
  if (config.fillServiceSignerUrl && fsSenderAddress) {
    logger.info('Initializing Fill Service chain service', {
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

  // Initialize other adapters
  const everclear = new EverclearAdapter(config.everclearApiUrl, logger);
  const purchaseCache = new PurchaseCache(config.redis.host, config.redis.port);
  const prometheus = new PrometheusAdapter(logger, options.serviceName, config.pushGatewayUrl);
  const rebalance = new RebalanceAdapter(config, logger, database);

  // Initialize database
  database.initializeDatabase(config.database);

  const baseAdapters: BaseAdapters & { solanaSigner?: SolanaSigner } = {
    chainService,
    fillServiceChainService,
    everclear,
    purchaseCache,
    prometheus,
    rebalance,
    database,
    web3Signer: web3Signer as Web3Signer,
  };

  // Initialize Solana signer if requested and configured
  if (options.includeSolanaSigner && config.solana?.privateKey) {
    try {
      const solanaSigner = createSolanaSigner({
        privateKey: config.solana.privateKey,
        rpcUrl: config.solana.rpcUrl,
        commitment: 'confirmed',
        maxRetries: 3,
      });
      logger.info('Solana signer initialized', {
        address: solanaSigner.getAddress(),
        rpcUrl: config.solana.rpcUrl || 'https://api.mainnet-beta.solana.com',
      });
      baseAdapters.solanaSigner = solanaSigner;
    } catch (error) {
      logger.error('Failed to initialize Solana signer', {
        error: (error as Error).message,
        // Don't log the actual error which might contain key info
      });
      // Don't throw - allow other functionality to work
    }
  } else if (options.includeSolanaSigner) {
    logger.debug('Solana signer not configured - Solana USDC rebalancing will not be available');
  }

  return baseAdapters;
}
