import { providers, Signer } from 'ethers';
import { TransactionService as NxtpTxService } from '@connext/nxtp-txservice';
import { ILogger } from '../../logger/src';
import { createLoggingContext } from '@mark/core';
import { ethers } from 'ethers';

export interface TransactionServiceConfig {
  rpcUrl: string;
  contractAddress: string;
  maxRetries: number;
  retryDelay: number;
  logLevel?: string;
}

export class TransactionServiceAdapter {
  private readonly txService: NxtpTxService;
  private readonly logger: ILogger;
  private readonly config: TransactionServiceConfig;

  constructor(config: TransactionServiceConfig, signer: Signer, logger: ILogger) {
    this.config = config;
    this.logger = logger;
    this.txService = new NxtpTxService(
      logger as any,
      {
        chains: {
          '1': {
            providers: [{ url: config.rpcUrl }],
            confirmations: 1,
            confirmationTimeout: config.retryDelay,
          },
        },
        logLevel: config.logLevel || 'info',
      },
      signer,
    );
    this.logger.info('Transaction service initialized');
  }

  async submitAndMonitor(transaction: providers.TransactionRequest): Promise<string> {
    const { requestContext } = createLoggingContext('submitAndMonitor');
    const context = { ...requestContext, origin: 'txservice' };

    try {
      const tx = await this.txService.sendTx(
        {
          to: transaction.to || this.config.contractAddress,
          data: transaction.data ? ethers.utils.hexlify(transaction.data) : '0x',
          value: transaction.value || 0,
          domain: 1, // Using default chain
          from: transaction.from,
        },
        context,
      );

      this.logger.info('Transaction submitted', { txHash: tx.transactionHash });
      return tx.transactionHash;
    } catch (error) {
      this.logger.error('Failed to submit transaction', { error });
      throw error;
    }
  }
}
