export interface RequestContext {
  id: string;
}

export interface MethodContext {
  method: string;
}

export interface ChainProvider {
  url: string;
  weight?: number;
}

export interface ChainConfig {
  chainId: number;
  providers: ChainProvider[];
}

export interface MarkConfiguration {
  chain: ChainConfig;
  everclear: {
    apiUrl: string;
    apiKey: string;
  };
  web3Signer: {
    url: string;
    publicKey: string;
  };
}
