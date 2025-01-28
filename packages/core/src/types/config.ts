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
  assets?: AssetConfiguration[];
}

export type EverclearConfig = {
  chains: Record<string, ChainConfiguration>;
  hub: HubConfig;
};

export type Environment = 'mainnet' | 'testnet' | 'devnet';
export type Stage = 'development' | 'staging' | 'production';

export interface MarkConfiguration {
  invoiceAge: number;
  web3SignerUrl: string;
  everclearApiUrl: string;
  relayer?: {
    url: string;
    key: string;
  };
  ownAddress: string;
  stage: Stage;
  environment: Environment;
  logLevel: LogLevel;
  supportedSettlementDomains: number[];
  supportedAssets: string[];
  chains: Record<string, ChainConfiguration>; // keyed on chain id
  hub: Omit<HubConfig, 'confirmations' | 'subgraphUrls'>;
  dd_api_key: string;
}

export const USDC_TICKER = '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa';
