import { providers, Signer } from 'ethers';
import { TransactionService as NxtpTxService } from '@connext/nxtp-txservice';
import { ILogger } from '../../logger/src';
import { createLoggingContext } from '@mark/core';
import { ethers } from 'ethers';
import { ChainConfiguration } from '@mark/core';

export interface TransactionServiceConfig {
  chains: Record<string, ChainConfiguration>;
  maxRetries?: number;
  retryDelay?: number;
  logLevel?: string;
}

export class TransactionServiceAdapter {
  private readonly txService: NxtpTxService;
  private readonly logger: ILogger;
  private readonly config: TransactionServiceConfig;

  constructor(config: TransactionServiceConfig, signer: Signer, logger: ILogger) {
    this.config = config;
    this.logger = logger;

    // Convert chain configuration format to nxtp-txservice format
    const nxtpChainConfig = Object.entries(config.chains).reduce(
      (acc, [chainId, chainConfig]) => ({
        ...acc,
        [chainId]: {
          providers: chainConfig.providers.map((url) => ({ url })),
          confirmations: 1,
          confirmationTimeout: config.retryDelay || 15000,
        },
      }),
      {},
    );

    this.txService = new NxtpTxService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
      {
        chains: nxtpChainConfig,
        logLevel: config.logLevel || 'info',
      },
      signer,
    );

    this.logger.info('Transaction service initialized', {
      supportedChains: Object.keys(config.chains),
    });
  }

  async submitAndMonitor(chainId: string, transaction: providers.TransactionRequest): Promise<string> {
    const { requestContext } = createLoggingContext('submitAndMonitor');
    const context = { ...requestContext, origin: 'txservice' };

    if (!this.config.chains[chainId]) {
      throw new Error(`Chain ${chainId} not supported`);
    }

    try {
      const tx = await this.txService.sendTx(
        {
          to: transaction.to!,
          data: transaction.data ? ethers.utils.hexlify(transaction.data) : '0x',
          value: transaction.value || 0,
          domain: parseInt(chainId),
          from: transaction.from,
        },
        context,
      );

      this.logger.info('Transaction submitted', {
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
