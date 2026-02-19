import { BridgeAdapter } from '../types';
import { AcrossBridgeAdapter, MAINNET_ACROSS_URL, TESTNET_ACROSS_URL } from './across';
import { BinanceBridgeAdapter, BINANCE_BASE_URL } from './binance';
import { CoinbaseBridgeAdapter } from './coinbase';
import { CowSwapBridgeAdapter } from './cowswap';
import { KrakenBridgeAdapter, KRAKEN_BASE_URL } from './kraken';
import { NearBridgeAdapter, NEAR_BASE_URL } from './near';
import { SupportedBridge, MarkConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import { CctpBridgeAdapter } from './cctp/cctp';
import * as database from '@mark/database';
import { MantleBridgeAdapter } from './mantle';
import { StargateBridgeAdapter } from './stargate';
import { TacInnerBridgeAdapter, TacNetwork } from './tac';
import { PendleBridgeAdapter } from './pendle';
import { CCIPBridgeAdapter } from './ccip';
import { ZKSyncNativeBridgeAdapter } from './zksync';
import { LineaNativeBridgeAdapter } from './linea';
import { ZircuitNativeBridgeAdapter } from './zircuit';

export class RebalanceAdapter {
  constructor(
    protected readonly config: MarkConfiguration,
    protected readonly logger: Logger,
    protected readonly db: typeof database,
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
        if (!this.config.database?.connectionString) {
          throw new Error('Database is required for Binance adapter');
        }
        this.db.initializeDatabase(this.config.database);
        if (!this.config.binance.apiKey || !this.config.binance.apiSecret) {
          throw new Error(`Binance adapter requires API key and secret`);
        }
        return new BinanceBridgeAdapter(
          this.config.binance.apiKey,
          this.config.binance.apiSecret,
          process.env.BINANCE_BASE_URL || BINANCE_BASE_URL,
          this.config,
          this.logger,
          this.db,
        );
      case SupportedBridge.Kraken:
        if (!this.config.database?.connectionString) {
          throw new Error('Database is required for Binance adapter');
        }
        if (!this.config.kraken?.apiKey || !this.config.kraken?.apiSecret) {
          throw new Error(`Kraken adapter requires API key and secret`);
        }
        this.db.initializeDatabase(this.config.database);
        return new KrakenBridgeAdapter(
          this.config.kraken.apiKey,
          this.config.kraken.apiSecret,
          process.env.KRAKEN_BASE_URL || KRAKEN_BASE_URL,
          this.config,
          this.logger,
          this.db,
        );
      case SupportedBridge.Coinbase:
        if (!this.config.coinbase?.apiKey || !this.config.coinbase?.apiSecret) {
          throw new Error(`Coinbase adapter requires API key and secret`);
        }
        return new CoinbaseBridgeAdapter(this.config, this.logger, this.db);
      case SupportedBridge.CCTPV1:
        return new CctpBridgeAdapter('v1', this.config.chains, this.logger);
      case SupportedBridge.CCTPV2:
        return new CctpBridgeAdapter('v2', this.config.chains, this.logger);
      case SupportedBridge.CowSwap:
        return new CowSwapBridgeAdapter(this.config.chains, this.logger);
      case SupportedBridge.Near:
        return new NearBridgeAdapter(
          this.config.chains,
          this.config.near?.jwtToken,
          process.env.NEAR_BASE_URL || NEAR_BASE_URL,
          this.logger,
        );
      case SupportedBridge.Mantle:
        return new MantleBridgeAdapter(this.config.chains, this.logger);
      case SupportedBridge.Stargate:
        return new StargateBridgeAdapter(this.config.chains, this.logger);
      case SupportedBridge.TacInner:
        return new TacInnerBridgeAdapter(this.config.chains, this.logger, {
          network: this.config.tac?.network === 'testnet' ? TacNetwork.TESTNET : TacNetwork.MAINNET,
          tonMnemonic: this.config.ton?.mnemonic,
          tonRpcUrl: this.config.tac?.tonRpcUrl || this.config.ton?.rpcUrl,
        });
      case SupportedBridge.Pendle:
        return new PendleBridgeAdapter(this.config.chains, this.logger);
      case SupportedBridge.CCIP:
        return new CCIPBridgeAdapter(this.config.chains, this.logger);
      case SupportedBridge.Zksync:
        return new ZKSyncNativeBridgeAdapter(this.config.chains, this.logger);
      case SupportedBridge.Linea:
        return new LineaNativeBridgeAdapter(this.config.chains, this.logger);
      case SupportedBridge.Zircuit:
        return new ZircuitNativeBridgeAdapter(this.config.chains, this.logger);
      default:
        throw new Error(`Unsupported adapter type: ${type}`);
    }
  }

  public async isPaused(): Promise<boolean> {
    return this.db.isPaused('rebalance');
  }

  public async setPause(paused: boolean): Promise<void> {
    await this.db.setPause('rebalance', paused);
  }
}
