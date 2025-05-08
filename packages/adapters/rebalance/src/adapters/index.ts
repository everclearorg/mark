import { BridgeAdapter } from 'src/types';
import { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';
import { Environment, ChainConfiguration, SupportedBridge } from '@mark/core';
import { Logger } from '@mark/logger';

export { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';

export class RebalanceAdapter {
  private env: Environment;
  private chains: Record<string, ChainConfiguration>;
  private logger: Logger;

  constructor(env: Environment, chains: Record<string, ChainConfiguration>, logger: Logger) {
    this.env = env;
    this.chains = chains;
    this.logger = logger;
  }

  public getAdapter(type: SupportedBridge): BridgeAdapter {
    switch (type) {
      case SupportedBridge.Across:
        return new AcrossBridgeAdapter(
          this.env === 'mainnet' ? MAINNET_ACROSS_URL : TESTNET_ACROSS_URL,
          this.chains,
          this.logger,
        );
      default:
        throw new Error(`Unsupported adapter type: ${type}`);
    }
  }
}
