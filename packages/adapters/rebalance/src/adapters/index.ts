import { BridgeAdapter } from 'src/types';
import { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';
import { Environment, ChainConfiguration, SupportedBridge } from '@mark/core';
import { Logger } from '@mark/logger';

export { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';

export class RebalanceAdapter {
  constructor(
    protected readonly env: Environment,
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {}

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
