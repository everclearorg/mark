import { LogLevel } from './logging';

// Don't need this until we have to support swaps
export interface PriceConfiguration {
  isStable?: boolean;
  priceFeed?: string; // chainlink price feed
  coingeckoId?: string;
  mainnetEquivalent?: string;
  univ2?: { pair: string };
  univ3?: { pool: string };
}

export interface AssetConfiguration {
  symbol: string;
  address: string;
  decimals: number;
  tickerHash: string;
  isNative: boolean;
  balanceThreshold: string;
  //   price: PriceConfiguration;
}

export interface ChainConfiguration {
  providers: string[];
  assets: AssetConfiguration[];
  invoiceAge: number;
  gasThreshold: string;
  deployments: {
    everclear: string;
    permit2: string;
    multicall3: string;
  };
  privateKey?: string;
  bandwidthThreshold?: string;
  energyThreshold?: string;
  gnosisSafeAddress?: string;
  walletType?: string;
}

export interface HubConfig {
  domain: string;
  providers: string[];
  subgraphUrls: string[];
  confirmations: number;
  assets?: AssetConfiguration[];
}

export type EverclearConfig = {
  chains: Record<string, ChainConfiguration>;
  hub: HubConfig;
};

export type Environment = 'mainnet' | 'testnet' | 'devnet';
export type Stage = 'development' | 'staging' | 'production';

export enum SupportedBridge {
  Across = 'across',
  Binance = 'binance',
  CCTPV1 = 'cctpv1',
  CCTPV2 = 'cctpv2',
  Kraken = 'kraken',
  Near = 'near',
}

export enum GasType {
  Gas = 'gas',
  Bandwidth = 'bandwidth',
  Energy = 'energy',
}

export interface RebalanceRoute {
  asset: string;
  origin: number;
  destination: number;
}
export interface RouteRebalancingConfig extends RebalanceRoute {
  maximum: string; // Rebalance triggered when balance > maximum
  slippagesDbps: number[]; // Slippage tolerance in decibasis points (1000 = 1%). Array indices match preferences
  preferences: SupportedBridge[]; // Priority ordered platforms
  reserve?: string; // Amount to keep on origin chain during rebalancing
}

export interface OnDemandRouteConfig extends RebalanceRoute {
  slippagesDbps: number[]; // Slippage tolerance in decibasis points (1000 = 1%). Array indices match preferences
  preferences: SupportedBridge[]; // Priority ordered platforms
  reserve?: string; // Amount to keep on origin chain during rebalancing
}

export interface RebalanceConfig {
  routes: RouteRebalancingConfig[];
  onDemandRoutes?: OnDemandRouteConfig[];
}
export interface RedisConfig {
  host: string;
  port: number;
}

export interface DatabaseConfig {
  connectionString: string;
}

export interface MarkConfiguration extends RebalanceConfig {
  pushGatewayUrl: string;
  web3SignerUrl: string;
  everclearApiUrl: string;
  relayer: {
    url?: string;
    key?: string;
  };
  binance: {
    apiKey?: string;
    apiSecret?: string;
  };
  kraken: {
    apiKey?: string;
    apiSecret?: string;
  };
  near: {
    jwtToken?: string;
  };
  redis: RedisConfig;
  database: DatabaseConfig;
  ownAddress: string;
  ownSolAddress: string;
  stage: Stage;
  environment: Environment;
  logLevel: LogLevel;
  supportedSettlementDomains: number[];
  forceOldestInvoice?: boolean;
  supportedAssets: string[];
  chains: Record<string, ChainConfiguration>; // keyed on chain id
  hub: Omit<HubConfig, 'confirmations' | 'subgraphUrls'>;
  // TTL (seconds) for cached purchases
  purchaseCacheTtlSeconds: number;
}
