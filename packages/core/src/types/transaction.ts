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

export enum TransactionSubmissionType {
  Onchain = 'Onchain',
}
