import { Logger } from '../../../adapters/logger/src';
import { ChainServiceAdapter } from '../../../adapters/chainservice/src';
import { Web3SignerAdapter } from '../../../adapters/web3signer/src';
import { ethers } from 'ethers';

export interface TransactionConfig {
  maxRetries: number;
  retryDelay: number;
}

export class TransactionAdapter {
  private readonly logger: Logger;
  private readonly config: TransactionConfig;
  private readonly chainService: ChainServiceAdapter;
  private readonly signer: Web3SignerAdapter;

  constructor(config: TransactionConfig, chainService: ChainServiceAdapter, signer: Web3SignerAdapter, logger: Logger) {
    this.config = config;
    this.chainService = chainService;
    this.signer = signer;
    this.logger = logger;
  }

  async submitAndMonitor(transaction: ethers.providers.TransactionRequest): Promise<string> {
    // Implementation will go here
    throw new Error('Not implemented');
  }

  async waitForConfirmation(txHash: string): Promise<boolean> {
    // Implementation will go here
    throw new Error('Not implemented');
  }
}
