import { BinanceAssetMapping } from './types';

// Asset mappings based on live Binance API responses
// TODO: Fetch dynamically and cache
export const BINANCE_ASSET_MAPPINGS: BinanceAssetMapping[] = [
  // WETH on Ethereum - Min: 0.002 ETH, Fee: 0.0004 ETH
  {
    chainId: 1, // Ethereum mainnet
    onChainAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    binanceSymbol: 'ETH',
    network: 'ETH',
    minWithdrawalAmount: '2000000000000000', // 0.002 ETH in wei
    withdrawalFee: '400000000000000', // 0.0004 ETH in wei
    depositConfirmations: 6,
  },
  // USDC on Ethereum - Min: 15 USDC, Fee: 1.5 USDC
  {
    chainId: 1,
    onChainAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    binanceSymbol: 'USDC',
    network: 'ETH',
    minWithdrawalAmount: '15000000', // 15 USDC in smallest unit
    withdrawalFee: '1500000', // 1.5 USDC in smallest unit
    depositConfirmations: 6,
  },
  // USDT on Ethereum - Min: 15 USDT, Fee: 1.5 USDT
  {
    chainId: 1,
    onChainAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    binanceSymbol: 'USDT',
    network: 'ETH',
    minWithdrawalAmount: '15000000', // 15 USDT in smallest unit
    withdrawalFee: '1500000', // 1.5 USDT in smallest unit
    depositConfirmations: 6,
  },
  // WETH on Arbitrum - Min: 0.0003 ETH, Fee: 0.00004 ETH
  {
    chainId: 42161, // Arbitrum One
    onChainAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    binanceSymbol: 'ETH',
    network: 'ARBITRUM',
    minWithdrawalAmount: '300000000000000', // 0.0003 ETH in wei
    withdrawalFee: '40000000000000', // 0.00004 ETH in wei
    depositConfirmations: 120,
  },
  // USDC on Arbitrum - Min: 0.36 USDC, Fee: 0.18 USDC
  {
    chainId: 42161,
    onChainAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    binanceSymbol: 'USDC',
    network: 'ARBITRUM',
    minWithdrawalAmount: '360000', // 0.36 USDC in smallest unit
    withdrawalFee: '180000', // 0.18 USDC in smallest unit
    depositConfirmations: 120,
  },
  // USDT on Arbitrum - Min: 0.36 USDT, Fee: 0.18 USDT
  {
    chainId: 42161,
    onChainAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    binanceSymbol: 'USDT',
    network: 'ARBITRUM',
    minWithdrawalAmount: '360000', // 0.36 USDT in smallest unit
    withdrawalFee: '180000', // 0.18 USDT in smallest unit
    depositConfirmations: 120,
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
  WITHDRAW_QUOTA: '/sapi/v1/capital/withdraw/quota',
  SYSTEM_STATUS: '/sapi/v1/system/status',
  ASSET_CONFIG: '/sapi/v1/capital/config/getall',
  TICKER_PRICE: '/api/v3/ticker/price', // Public endpoint for price data
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
