import { Logger } from '../../adapters/logger/src';
import { EverclearAdapter, EverclearConfig } from '../../adapters/everclear/src';
import { ChainServiceAdapter, ChainServiceConfig } from '../../adapters/chainservice/src';
import { Web3SignerAdapter, Web3SignerConfig } from '../../adapters/web3signer/src';
import { TransactionAdapter, TransactionConfig } from '../../adapters/transaction/src';
import { ProcessInvoicesConfig, ProcessInvoicesDependencies, startPolling } from './invoice/processInvoices';

export interface PollerConfig {
  everclear: EverclearConfig;
  chainService: ChainServiceConfig;
  web3Signer: Web3SignerConfig;
  transaction: TransactionConfig;
  processor: ProcessInvoicesConfig;
}

// Initialize all adapters with proper lifecycle management
async function initializeAdapters(config: PollerConfig, logger: Logger) {
  // Initialize adapters in the correct order
  const chainService = new ChainServiceAdapter(config.chainService, logger);
  await chainService.initialize();

  const web3Signer = new Web3SignerAdapter(config.web3Signer, logger);
  const everclear = new EverclearAdapter(config.everclear, logger);
  const transaction = new TransactionAdapter(config.transaction, chainService, web3Signer, logger);

  return {
    chainService,
    web3Signer,
    everclear,
    transaction,
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
    chainService: {
      rpcUrl: process.env.RPC_URL!,
      contractAddress: process.env.CONTRACT_ADDRESS!,
    },
    web3Signer: {
      url: process.env.WEB3_SIGNER_URL!,
      publicKey: process.env.WEB3_SIGNER_PUBLIC_KEY!,
    },
    transaction: {
      maxRetries: parseInt(process.env.TX_MAX_RETRIES || '3', 10),
      retryDelay: parseInt(process.env.TX_RETRY_DELAY || '15000', 10),
    },
    processor: {
      batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
      pollingInterval: parseInt(process.env.POLLING_INTERVAL || '60000', 10),
    },
  };

  await startPoller(config);
  return { statusCode: 200, body: 'Poller started successfully' };
}
