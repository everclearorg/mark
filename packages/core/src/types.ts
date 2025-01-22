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
  web3SignerUrl: string;
  everclear: {
    url: string;
    key?: string;
  };
  relayer?: {
    url: string;
    key: string;
  };
  ownAddress: string;
  stage: 'development' | 'staging' | 'mainnet';
  environment: 'mainnet' | 'testnet' | 'local';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  supportedAssets: string[]; // symbol array
  supportedSettlementDomains: number[];
  chains: Record<string, ChainConfiguration>; // keyed on chain id
}

export interface NewIntentParams {
  origin: string;
  destinations: string[];
  to: string;
  inputAsset: string;
  amount: string | number;
  callData: string;
  maxFee: string | number;
}

export interface TransactionRequest {
  to: string | null;
  from?: string | null;
  nonce?: string;
  gasLimit?: string;
  gasPrice?: string;
  data: string;
  value?: string;
  chainId: number;
  type?: number | null;
  accessList?:
    | {
        address?: string;
        storageKeys?: string[];
      }[]
    | null;
  maxPriorityFeePerGas?: string | null;
  maxFeePerGas?: string | null;
  customData?: {
    [key: string]: unknown;
  } | null;
  ccipReadEnabled?: boolean | null;
}
