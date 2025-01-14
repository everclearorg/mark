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
