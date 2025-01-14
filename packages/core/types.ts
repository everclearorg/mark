export interface RequestContext {
  id: string;
}

export interface MethodContext {
  method: string;
}

// Don't need this until we have to support swaps
export interface PriceConfiguration {
  isStable?: boolean;
  priceFeed?: string; // uniswap pool address
  coingeckoId?: string;
}

export interface AssetConfiguration {
  symbol: string;
  address: string;
  decimals: number;
  tickerHash: string;
  isNative: boolean;
}

export interface ChainConfiguration {
  providers: string[];
  assets: AssetConfiguration[];
}

export interface MarkConfiguration {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  stage: 'testnet' | 'mainnet' | 'local';
  environment: 'staging' | 'production';
  invoiceAge: number;
  signer: string;
  everclear: {
    url: string;
    key?: string;
  };
  supportedSettlementDomains: number[];
  chains: Record<string, ChainConfiguration>; // keyed on chain id
}
