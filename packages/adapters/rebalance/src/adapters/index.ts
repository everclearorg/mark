import { BridgeAdapter } from '../types';
import { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';
import { BinanceBridgeAdapter, BINANCE_BASE_URL } from './binance';
import { SupportedBridge, MarkConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';

export { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';
export { BinanceBridgeAdapter, BINANCE_BASE_URL } from './binance';

export class RebalanceAdapter {
  constructor(
    protected readonly config: MarkConfiguration,
    protected readonly logger: Logger,
    protected readonly rebalanceCache?: RebalanceCache,
  ) {}

  public getAdapter(type: SupportedBridge): BridgeAdapter {
    switch (type) {
      case SupportedBridge.Across:
        return new AcrossBridgeAdapter(
          this.config.environment === 'mainnet' ? MAINNET_ACROSS_URL : TESTNET_ACROSS_URL,
          this.config.chains,
          this.logger,
        );
      case SupportedBridge.Binance:
        if (!this.rebalanceCache) {
          throw new Error('RebalanceCache is required for Binance adapter');
        }
        if (!this.config.binance.apiKey || !this.config.binance.apiSecret) {
          throw new Error(`Binance adapter requires API key and secret`);
        }
        return new BinanceBridgeAdapter(
          this.config.binance.apiKey,
          this.config.binance.apiSecret,
          process.env.BINANCE_BASE_URL || BINANCE_BASE_URL,
          this.config,
          this.logger,
          this.rebalanceCache,
        );
      default:
        throw new Error(`Unsupported adapter type: ${type}`);
    }
  }
}
