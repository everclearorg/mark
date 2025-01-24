import { providers, Signer } from 'ethers';
import { ChainService as ChimeraChainService } from '@chimera-monorepo/chainservice';
import { ILogger } from '@mark/logger';
import { createLoggingContext, ChainConfiguration } from '@mark/core';

export interface ChainServiceConfig {
  chains: Record<string, ChainConfiguration>;
  maxRetries?: number;
  retryDelay?: number;
  logLevel?: string;
}

export class ChainService {
  private readonly txService: ChimeraChainService;
  private readonly logger: ILogger;
  private readonly config: ChainServiceConfig;

  constructor(config: ChainServiceConfig, signer: Signer, logger: ILogger) {
    this.config = config;
    this.logger = logger;

    // Convert chain configuration format to nxtp-txservice format
    const nxtpChainConfig = Object.entries(config.chains).reduce(
      (acc, [chainId, chainConfig]) => ({
        ...acc,
        [chainId]: {
          providers: chainConfig.providers.map((url) => url),
          confirmations: 2,
          confirmationTimeout: config.retryDelay || 45000,
        },
      }),
      {},
    );

    this.txService = new ChimeraChainService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
      nxtpChainConfig,
      signer,
    );

    this.logger.info('Chain service initialized', {
      supportedChains: Object.keys(config.chains),
    });
  }

  async submitAndMonitor(chainId: string, transaction: providers.TransactionRequest): Promise<string> {
    const { requestContext } = createLoggingContext('submitAndMonitor');
    const context = { ...requestContext, origin: 'chainservice' };

    if (!this.config.chains[chainId]) {
      throw new Error(`Chain ${chainId} not supported`);
    }

    const writeTransaction = {
      to: transaction.to!,
      data: transaction.data! as `0x${string}`,
      value: transaction.value ? transaction.value.toString() : '0',
      domain: parseInt(chainId),
      from: transaction.from,
    };
    try {
      const tx = await this.txService.sendTx(writeTransaction, context);

      this.logger.info('Transaction mined', {
        chainId,
        txHash: tx.transactionHash,
      });

      return tx.transactionHash;
    } catch (error) {
      this.logger.error('Failed to submit transaction', {
        chainId,
        error,
      });
      throw error;
    }
  }

  isAssetSupported(chainId: string, assetAddress: string): boolean {
    const chainConfig = this.config.chains[chainId];
    if (!chainConfig) return false;

    return chainConfig.assets.some((asset) => asset.address.toLowerCase() === assetAddress.toLowerCase());
  }

  getAssetConfig(chainId: string, assetAddress: string) {
    const chainConfig = this.config.chains[chainId];
    if (!chainConfig) return undefined;

    return chainConfig.assets.find((asset) => asset.address.toLowerCase() === assetAddress.toLowerCase());
  }
}
