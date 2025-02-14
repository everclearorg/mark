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

export interface MarkConfiguration {
  pushGatewayUrl: string;
  web3SignerUrl: string;
  everclearApiUrl: string;
  relayer?: {
    url: string;
    key: string;
  };
  redis: {
    host: string;
    port: number;
  };
  ownAddress: string;
  stage: Stage;
  environment: Environment;
  logLevel: LogLevel;
  supportedSettlementDomains: number[];
  supportedAssets: string[];
  chains: Record<string, ChainConfiguration>; // keyed on chain id
  hub: Omit<HubConfig, 'confirmations' | 'subgraphUrls'>;
}
