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
}

export interface DepositStatusResponse {
  fillStatus: 'filled' | 'pending' | 'unfilled';
  fillTxHash?: string;
  destinationChainId: number;
}
