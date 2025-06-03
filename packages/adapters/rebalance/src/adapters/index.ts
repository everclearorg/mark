import { BridgeAdapter } from '../types';
import { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';
import { BinanceBridgeAdapter, BINANCE_BASE_URL } from './binance';
import { Environment, ChainConfiguration, SupportedBridge } from '@mark/core';
import { Logger } from '@mark/logger';

export { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';
export { BinanceBridgeAdapter, BINANCE_BASE_URL } from './binance';

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
      case SupportedBridge.Binance:
        return new BinanceBridgeAdapter(
          process.env.BINANCE_API_KEY!,
          process.env.BINANCE_API_SECRET!,
          process.env.BINANCE_BASE_URL || BINANCE_BASE_URL,
          this.chains,
          this.logger,
        );
      default:
        throw new Error(`Unsupported adapter type: ${type}`);
    }
  }
}
