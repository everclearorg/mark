// Fill event and topic
export const FILLED_V3_RELAY_EVENT =
  'FilledV3Relay(address,address,uint256,uint256,uint256,uint256,uint32,uint32,uint32,address,address,address,address,bytes,(address,bytes,uint256,uint8))';
export const FILLED_V3_RELAY_TOPIC = '0x571749edf1d5c9599318cdbc4e28a6475d65e87fd3b2ddbe1e9a8d5e7a0f0ff7'; //keccak256(toHex(FILLED_V3_RELAY_EVENT));

// WETH withdrawal event
export const WETH_WITHDRAWAL_EVENT = 'Withdrawal(address,uint256)';
export const WETH_WITHDRAWAL_TOPIC = '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7';

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
  fillStatus: 'filled' | 'pending' | 'unfilled';
  fillTxHash?: string;
  destinationChainId: number;
}
