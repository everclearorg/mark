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

/**
 * TON asset configuration for non-EVM chain assets.
 * TON uses jetton contracts instead of ERC20-style addresses.
 */
export interface TonAssetConfiguration {
  symbol: string;
  jettonAddress: string; // TON jetton master address (e.g., EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs)
  decimals: number;
  tickerHash: string; // Same ticker hash as used on EVM chains for cross-chain asset matching
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
  zodiacRoleModuleAddress?: string;
  zodiacRoleKey?: string;
  gnosisSafeAddress?: string;
  squadsAddress?: string;
  privateKey?: string;
  bandwidthThreshold?: string;
  energyThreshold?: string;
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
  Coinbase = 'coinbase',
  CowSwap = 'cowswap',
  Kraken = 'kraken',
  Near = 'near',
  Mantle = 'mantle',
  Stargate = 'stargate',
  TacInner = 'tac-inner',
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
  swapOutputAsset?: string;
}
export interface RouteRebalancingConfig extends RebalanceRoute {
  maximum: string; // Rebalance triggered when balance > maximum
  slippagesDbps: number[]; // Slippage tolerance in decibasis points (1000 = 1%). Array indices match preferences
  preferences: SupportedBridge[]; // Priority ordered platforms
  reserve?: string; // Amount to keep on origin chain during rebalancing
}

export interface OnDemandRouteConfig extends RebalanceRoute {
  slippagesDbps?: number[]; // Slippage tolerance in decibasis points (1000 = 1%). Array indices match preferences (bridge adapters)
  preferences?: SupportedBridge[]; // Priority ordered platforms (bridge adapters)
  reserve?: string; // Amount to keep on origin chain during rebalancing
  swapPreferences?: SupportedBridge[]; // Adapter order for same-chain swap step
  swapSlippagesDbps?: number[]; // Slippage tolerance for swap adapters (1000 = 1%). Array indices match swapPreferences
  swapOutputAsset?: string; // Output asset address on origin chain after swap step (before bridge)
}

export interface RebalanceConfig {
  routes: RouteRebalancingConfig[];
  onDemandRoutes?: OnDemandRouteConfig[];
}

export interface TacRebalanceConfig {
  enabled: boolean;
  // Market Maker receiver configuration
  marketMaker: {
    address: string; // EVM address on TAC for MM
    onDemandEnabled: boolean; // Enable invoice-triggered rebalancing
    thresholdEnabled: boolean; // Enable balance-threshold rebalancing
    threshold?: string; // Min USDT balance (6 decimals)
    targetBalance?: string; // Target after threshold-triggered rebalance
  };
  // Fill Service receiver configuration
  fillService: {
    address: string; // EVM address on TAC for FS (destination) - also used as sender on ETH if senderAddress not set
    senderAddress?: string; // Optional: ETH sender address if different from 'address' (rare - same key = same address)
    thresholdEnabled: boolean; // Enable balance-threshold rebalancing
    threshold: string; // Min USDT balance (6 decimals)
    targetBalance: string; // Target after threshold-triggered rebalance
  };
  // Shared bridge configuration
  bridge: {
    slippageDbps: number; // Slippage for Stargate (default: 50 = 0.5%)
    minRebalanceAmount: string; // Min amount per operation (6 decimals)
    maxRebalanceAmount?: string; // Max amount per operation (optional cap)
  };
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
  fillServiceSignerUrl?: string; // Optional: separate web3signer for fill service sender
  everclearApiUrl: string;
  relayer: {
    url?: string;
    key?: string;
  };
  binance: {
    apiKey?: string;
    apiSecret?: string;
  };
  coinbase: {
    apiKey?: string;
    apiSecret?: string;
    allowedRecipients?: string[];
  };
  kraken: {
    apiKey?: string;
    apiSecret?: string;
  };
  near: {
    jwtToken?: string;
  };
  stargate: {
    apiUrl?: string;
  };
  tac: {
    tonRpcUrl?: string; // Optional: TON RPC endpoint for balance checks
    network?: 'mainnet' | 'testnet';
  };
  ton: {
    mnemonic?: string; // TON wallet mnemonic for TAC bridge operations
    rpcUrl?: string; // TON RPC endpoint
    apiKey?: string; // TON API key (for tonapi.io or DRPC)
    assets?: TonAssetConfiguration[]; // TON assets with jetton addresses
  };
  tacRebalance?: TacRebalanceConfig;
  redis: RedisConfig;
  database: DatabaseConfig;
  ownAddress: string;
  ownSolAddress: string;
  ownTonAddress?: string; // TON wallet address for TAC bridge operations
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
  earmarkTTLMinutes?: number;
  regularRebalanceOpTTLMinutes?: number;
  // Whitelisted recipient addresses for admin trigger/send endpoint
  whitelistedRecipients?: string[];
}
