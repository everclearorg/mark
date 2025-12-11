export interface PendleQuoteResponse {
  data: {
    amountOut: string;
    priceImpact: string;
    swapFee: string;
    transactions: {
      to: string;
      data: string;
      value: string;
    }[];
  };
}


export const PENDLE_API_BASE_URL = 'https://api-v2.pendle.finance/core/v2/sdk';

export const PENDLE_SUPPORTED_CHAINS = {
  1: 'mainnet',
  42161: 'arbitrum',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon',
} as const;

export const USDC_PTUSDE_PAIRS: Record<number, { usdc: string; ptUSDe: string }> = {
  1: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    ptUSDe: '0xE8483517077afa11A9B07f849cee2552f040d7b2',
  }
};

// Chainlink CCIP Router addresses per chain
export const CCIP_ROUTER_ADDRESSES: Record<number, string> = {
  1: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D', // Ethereum
  42161: '0x141fa059441E0ca23ce184B6A78bafD2A517DdE8', // Arbitrum
  43114: '0xF4c7E640EdA248ef95972845a62bdC74237805dB', // Avalanche  
  8453: '0x881e3A65B4d4a04dD529061dd0071cf975F58bCD', // Base
  137: '0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe', // Polygon
};

// Solana Chain Selector for CCIP
export const SOLANA_CHAIN_SELECTOR = '4949039107694359620';

// CCIP Message structure
export interface CCIPMessage {
  receiver: string; // bytes - receiver address on destination chain
  data: string; // bytes - arbitrary data
  tokenAmounts: Array<{
    token: string; // token contract address
    amount: string; // amount in wei
  }>;
  extraArgs: string; // bytes - extra arguments for CCIP
  feeToken: string; // address - token to pay fees (address(0) for native)
}

// CCIP EVM2AnyMessage structure (from docs)
export interface EVM2AnyMessage {
  receiver: string; // abi.encode of receiver address
  data: string; // bytes
  tokenAmounts: Array<{
    token: string;
    amount: string;
  }>;
  extraArgs: string; // bytes
  feeToken: string; // address
}