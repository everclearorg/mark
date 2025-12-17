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
  },
};
