import { GetExecutionStatusResponse } from '@defuse-protocol/one-click-sdk-typescript';

export const NEAR_BASE_URL = 'https://1click.chaindefuser.com';

// Configuration interfaces
export interface NearAssetMapping {
  chainId: number;
  onChainAddress: string;
  nearSymbol: string;
  network: string; // e.g., "ETH", "BSC", "MATIC"
  minDepositAmount: string;
  withdrawalFee: string;
}

export interface DepositStatusResponse {
  status: GetExecutionStatusResponse.status;
  originChainId: number;
  depositId: string;
  depositTxHash: string;
  fillTx?: string;
  destinationChainId: number;
  depositRefundTxHash?: string;
}
