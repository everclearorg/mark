import { ILogger } from '../../logger/src';
import { ethers } from 'ethers';

// TODO: proabably just copy the exact implementation from monorepo

export interface Web3SignerConfig {
  url: string;
  publicKey: string;
}

export class Web3SignerAdapter extends ethers.Signer {
  private readonly logger: ILogger;
  private readonly config: Web3SignerConfig;

  constructor(config: Web3SignerConfig, logger: ILogger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  async getAddress(): Promise<string> {
    return this.config.publicKey;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async signMessage(_message: string): Promise<string> {
    // Implementation will go here
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async signTransaction(_transaction: ethers.providers.TransactionRequest): Promise<string> {
    // Implementation will go here
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  connect(_provider: ethers.providers.Provider): ethers.Signer {
    return new Web3SignerAdapter(this.config, this.logger);
  }
}
