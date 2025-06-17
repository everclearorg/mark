import { BinanceAssetMapping } from './types';

// Sample asset mappings - this would be expanded based on supported assets
export const BINANCE_ASSET_MAPPINGS: BinanceAssetMapping[] = [
  // WETH on Ethereum → WETH on Arbitrum
  {
    chainId: 1, // Ethereum mainnet
    onChainAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    binanceSymbol: 'ETH',
    network: 'ETH',
    minWithdrawalAmount: '10000000000000000', // 0.01 ETH in wei
    withdrawalFee: '3000000000000000', // 0.003 ETH in wei
    depositConfirmations: 12,
  },
  // USDC on Ethereum (6 decimals)
  {
    chainId: 1,
    onChainAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    binanceSymbol: 'USDC',
    network: 'ETH',
    minWithdrawalAmount: '10000000', // 10 USDC in smallest unit
    withdrawalFee: '5000000', // 5 USDC in smallest unit
    depositConfirmations: 12,
  },
  // WETH on Arbitrum
  {
    chainId: 42161, // Arbitrum One
    onChainAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    binanceSymbol: 'ETH',
    network: 'ARBITRUM',
    minWithdrawalAmount: '10000000000000000', // 0.01 ETH in wei
    withdrawalFee: '1000000000000000', // 0.001 ETH in wei
    depositConfirmations: 1,
  },
  // USDC on Arbitrum (6 decimals)
  {
    chainId: 42161,
    onChainAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    binanceSymbol: 'USDC',
    network: 'ARBITRUM',
    minWithdrawalAmount: '10000000', // 10 USDC in smallest unit
    withdrawalFee: '1000000', // 1 USDC in smallest unit
    depositConfirmations: 1,
  },
];

export const BINANCE_RATE_LIMITS = {
  SAPI_IP_WEIGHT_PER_MINUTE: 12000, // IP limited endpoints
  SAPI_IP_WARNING_THRESHOLD: 10000, // Warn at ~80% of limit
  SAPI_UID_WEIGHT_PER_MINUTE: 180000, // UID limited endpoints
  SAPI_UID_WARNING_THRESHOLD: 150000, // Warn at ~80% of limit
} as const;

// API endpoint paths
export const BINANCE_ENDPOINTS = {
  DEPOSIT_ADDRESS: '/sapi/v1/capital/deposit/address',
  DEPOSIT_HISTORY: '/sapi/v1/capital/deposit/hisrec',
  WITHDRAW_APPLY: '/sapi/v1/capital/withdraw/apply',
  WITHDRAW_HISTORY: '/sapi/v1/capital/withdraw/history',
  SYSTEM_STATUS: '/sapi/v1/system/status',
  ASSET_CONFIG: '/sapi/v1/capital/config/getall',
} as const;

// Withdrawal status mappings
export const WITHDRAWAL_STATUS = {
  EMAIL_SENT: 0,
  CANCELLED: 1,
  AWAITING_APPROVAL: 2,
  REJECTED: 3,
  PROCESSING: 4,
  FAILURE: 5,
  COMPLETED: 6,
} as const;

// Deposit status mappings
export const DEPOSIT_STATUS = {
  PENDING: 0,
  SUCCESS: 1,
} as const;
