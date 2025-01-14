import { Logger } from '../../adapters/logger/src';
import { EverclearAdapter, EverclearConfig } from '../../adapters/everclear/src';
import { TransactionServiceAdapter, TransactionServiceConfig } from '../../adapters/txservice/src';
import { Web3SignerAdapter, Web3SignerConfig } from '../../adapters/web3signer/src';
import { ProcessInvoicesConfig, ProcessInvoicesDependencies, startPolling } from './invoice/processInvoices';
import { ethers } from 'ethers';

export interface PollerConfig {
  everclear: EverclearConfig;
  txService: {
    rpcUrl: string;
    contractAddress: string;
    maxRetries?: number;
    retryDelay?: number;
    logLevel?: string;
  };
  web3Signer: Web3SignerConfig;
  processor: ProcessInvoicesConfig;
}

// Initialize all adapters with proper lifecycle management
async function initializeAdapters(config: PollerConfig, logger: Logger) {
  // Initialize adapters in the correct order
  const web3Signer = new Web3SignerAdapter(config.web3Signer, logger);
  const txService = new TransactionServiceAdapter(
    {
      rpcUrl: config.txService.rpcUrl,
      contractAddress: config.txService.contractAddress,
      maxRetries: config.txService.maxRetries || 3,
      retryDelay: config.txService.retryDelay || 15000,
      logLevel: 'info',
    },
    web3Signer,
    logger,
  );

  const everclear = new EverclearAdapter(config.everclear, logger);

  return {
    txService,
    web3Signer,
    everclear,
  };
}

export async function startPoller(config: PollerConfig) {
  const logger = new Logger({ service: 'mark-poller' });

  try {
    // Initialize all adapters
    const adapters = await initializeAdapters(config, logger);

    // Create dependencies object for pure functions
    const deps: ProcessInvoicesDependencies = {
      ...adapters,
      logger,
    };

    // Start the polling process
    logger.info('Starting Mark poller service');
    await startPolling(config.processor, deps);
  } catch (error) {
    logger.error('Failed to start poller', { error });
    throw error;
  }
}

// For AWS Lambda handler
export async function handler(event: any) {
  const config: PollerConfig = {
    everclear: {
      apiUrl: process.env.EVERCLEAR_API_URL!,
      apiKey: process.env.EVERCLEAR_API_KEY!,
    },
    txService: {
      rpcUrl: process.env.RPC_URL!,
      contractAddress: process.env.CONTRACT_ADDRESS!,
    },
    web3Signer: {
      url: process.env.WEB3_SIGNER_URL!,
      publicKey: process.env.WEB3_SIGNER_PUBLIC_KEY!,
    },
    processor: {
      batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
      pollingInterval: parseInt(process.env.POLLING_INTERVAL || '60000', 10),
    },
  };

  await startPoller(config);
  return { statusCode: 200, body: 'Poller started successfully' };
}
