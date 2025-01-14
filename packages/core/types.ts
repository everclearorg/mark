export type RequestContext = {
  id: string;
  timestamp?: number;
};

export type MethodContext = {
  method: string;
};

export type ChainConfig = {
  providers: string[];
  confirmations: number;
  deployments: {
    everclear: string;
  };
};

export type PriceConfiguration = {
  isStable?: boolean;
  priceFeed?: string;
  coingeckoId?: string;
};

export type AssetConfiguration = {
  symbol: string;
  address: string;
  decimals: number;
  tickerHash: string;
  isNative: boolean;
};

export type ChainConfiguration = {
  providers: string[];
  assets: AssetConfiguration[];
};

export type MarkConfiguration = {
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
  supportedSettlementDomains: number[];
  chains: Record<string, ChainConfiguration>;
};
