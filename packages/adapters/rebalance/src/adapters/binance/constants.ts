export const BINANCE_NETWORK_TO_CHAIN_ID = {
  ETH: 1,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  MATIC: 137,
  BSC: 56,
  BASE: 8453,
  SCROLL: 534352,
  ZKSYNCERA: 324,
  AVAXC: 43114,
  RON: 2020,
  SONIC: 146,
} as const;

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
  TICKER_PRICE: '/api/v3/ticker/price',
  ACCOUNT_BALANCE: '/api/v3/account',
  CONVERT_EXCHANGE_INFO: '/sapi/v1/convert/exchangeInfo',
  CONVERT_GET_QUOTE: '/sapi/v1/convert/getQuote',
  CONVERT_ACCEPT_QUOTE: '/sapi/v1/convert/acceptQuote',
  CONVERT_ORDER_STATUS: '/sapi/v1/convert/orderStatus',
  CONVERT_TRADE_FLOW: '/sapi/v1/convert/tradeFlow',
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

// Withdrawal precision mappings
// These values were fetched from the API; since they don't change much we just use static value here
export const WITHDRAWAL_PRECISION_MAP: Record<string, Record<string, number>> = {
  USDT: {
    ETH: 6,
    BSC: 6,
    ARBITRUM: 6,
    OPTIMISM: 6,
    MATIC: 6,
    BASE: 6,
    SCROLL: 6,
    ZKSYNCERA: 6,
    AVAXC: 6,
    SONIC: 6,
  },
  USDC: {
    ETH: 6,
    BSC: 6,
    ARBITRUM: 6,
    OPTIMISM: 6,
    MATIC: 6,
    BASE: 6,
    SCROLL: 6,
    AVAXC: 6,
    ZKSYNCERA: 6,
    RON: 6,
    SONIC: 6,
  },
  ETH: {
    ETH: 6,
    BSC: 6,
    ARBITRUM: 6,
    OPTIMISM: 6,
    MATIC: 6,
    BASE: 6,
    SCROLL: 6,
    ZKSYNCERA: 6,
    AVAXC: 6,
    RON: 6,
    SONIC: 6,
  },
  BTC: {
    BTC: 8,
  },
};

/**
 * Binance Convert API Supported Pairs
 *
 * Focus: Similar-value asset swaps for rebalancing
 * - Stablecoins: USDT, USDC, FDUSD, DAI, TUSD, BUSD (legacy)
 * - BTC variants: BTC, WBTC, BTCB
 *
 * For the complete and up-to-date list, query the Convert API:
 * GET /sapi/v1/convert/exchangeInfo
 */
export const BINANCE_CONVERT_SUPPORTED_PAIRS = new Set([
  // Stablecoin conversions (1:1 or near-1:1 swaps)
  'USDT:USDC',
  'USDC:USDT',
  'USDT:FDUSD',
  'FDUSD:USDT',
  'USDC:FDUSD',
  'FDUSD:USDC',
  'USDT:DAI',
  'DAI:USDT',
  'USDC:DAI',
  'DAI:USDC',
  'USDT:TUSD',
  'TUSD:USDT',
  'USDC:TUSD',
  'TUSD:USDC',
  'FDUSD:DAI',
  'DAI:FDUSD',
  'FDUSD:TUSD',
  'TUSD:FDUSD',
  'DAI:TUSD',
  'TUSD:DAI',

  // Legacy BUSD pairs (being phased out, but may still be supported)
  'USDT:BUSD',
  'BUSD:USDT',
  'USDC:BUSD',
  'BUSD:USDC',
  'FDUSD:BUSD',
  'BUSD:FDUSD',
  'DAI:BUSD',
  'BUSD:DAI',
  'TUSD:BUSD',
  'BUSD:TUSD',

  // BTC variants (wrapped/native BTC conversions)
  'BTC:WBTC',
  'WBTC:BTC',
  'BTC:BTCB',
  'BTCB:BTC',
  'WBTC:BTCB',
  'BTCB:WBTC',
]);
