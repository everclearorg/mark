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
  //   price: PriceConfiguration;
}

export interface ChainConfiguration {
  providers: string[];
  assets: AssetConfiguration[];
}

export interface HubConfig {
  domain: string;
  providers: string[];
  subgraphUrls: string[];
  confirmations: number;
  assets?: AssetConfiguration;
}

export type EverclearConfig = {
  chains: Record<string, ChainConfiguration>;
  hub: HubConfig;
};

export type Environment = 'mainnet' | 'testnet' | 'devnet';
export type Stage = 'development' | 'staging' | 'production';
export interface MarkConfiguration {
  invoiceAge: number;
  signer: string;
  everclear: {
    url: string;
    key?: string;
  };
  relayer?: {
    url: string;
    key: string;
  };
  ownAddress: string;
  stage: Stage;
  environment: Environment;
  logLevel: LogLevel;
  supportedSettlementDomains: number[];
  chains: Record<string, ChainConfiguration>; // keyed on chain id
}
