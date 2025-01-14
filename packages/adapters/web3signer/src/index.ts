import { Logger } from '../../../adapters/logger/src';
import { ethers } from 'ethers';

export interface Web3SignerConfig {
  url: string;
  publicKey: string;
}

export class Web3SignerAdapter {
  private readonly logger: Logger;
  private readonly config: Web3SignerConfig;

  constructor(config: Web3SignerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async signTransaction(transaction: ethers.providers.TransactionRequest): Promise<string> {
    // Implementation will go here
    throw new Error('Not implemented');
  }

  async signMessage(message: string): Promise<string> {
    // Implementation will go here
    throw new Error('Not implemented');
  }
}
