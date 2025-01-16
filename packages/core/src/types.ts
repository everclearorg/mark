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
  stage: 'development' | 'staging' | 'mainnet';
  environment: 'mainnet' | 'testnet' | 'local';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  supportedSettlementDomains: number[];
  chains: Record<string, ChainConfiguration>; // keyed on chain id
}
