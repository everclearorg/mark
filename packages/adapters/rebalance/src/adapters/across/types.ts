// WETH withdrawal event
export const WETH_WITHDRAWAL_EVENT = 'Withdrawal(address,uint256)';
export const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

export const MAINNET_ACROSS_URL = 'https://app.across.to/api';
export const TESTNET_ACROSS_URL = 'https://testnet.across.to/api';

export interface SuggestedFeesResponse {
  totalRelayFee: {
    pct: string;
    total: string;
  };
  relayerCapitalFee: {
    pct: string;
    total: string;
  };
  relayerGasFee: {
    pct: string;
    total: string;
  };
  lpFee: {
    pct: string;
    total: string;
  };
  isAmountTooLow: boolean;
  spokePoolAddress: `0x${string}`;
  outputAmount: bigint;
  timestamp: number;
  fillDeadline: number;
  exclusiveRelayer: `0x${string}`;
  exclusivityDeadline: `0x${string}`;
}

export interface DepositStatusResponse {
  status: 'filled' | 'pending' | 'unfilled';
  originChainId: number;
  depositId: string;
  depositTxHash: string;
  fillTx?: string;
  destinationChainId: number;
  depositRefundTxHash?: string;
}
