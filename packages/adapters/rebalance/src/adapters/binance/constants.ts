export const BINANCE_NETWORK_TO_CHAIN_ID = {
  ETH: 1,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  MATIC: 137,
  POLYGON: 137, // Keep for backward compatibility
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
    POLYGON: 6,
    BASE: 6,
    SCROLL: 6,
    ZKSYNCERA: 6,
  },
  USDC: {
    ETH: 6,
    BSC: 6,
    ARBITRUM: 6,
    OPTIMISM: 6,
    POLYGON: 6,
    BASE: 6,
    SCROLL: 6,
    AVAXC: 6,
  },
  ETH: {
    ETH: 6,
    BSC: 6,
    ARBITRUM: 6,
    OPTIMISM: 6,
    POLYGON: 6,
    BASE: 6,
    SCROLL: 6,
  },
  BTC: {
    BTC: 8,
  },
};

// Deposit confirmation requirements
// These values were fetched from the API; since they don't change much we use static values here
export const DEPOSIT_CONFIRMATION_MAP: Record<string, Record<string, { minConfirm: number; unLockConfirm: number }>> = {
  BTC: {
    BSC: { minConfirm: 5, unLockConfirm: 0 },
    ETH: { minConfirm: 6, unLockConfirm: 64 },
  },
  USDT: {
    BSC: { minConfirm: 5, unLockConfirm: 0 },
    AVAXC: { minConfirm: 12, unLockConfirm: 0 },
    ARBITRUM: { minConfirm: 120, unLockConfirm: 120 },
    ETH: { minConfirm: 6, unLockConfirm: 64 },
    OPTIMISM: { minConfirm: 25, unLockConfirm: 100 },
    SCROLL: { minConfirm: 1, unLockConfirm: 0 },
  },
  USDC: {
    BSC: { minConfirm: 5, unLockConfirm: 0 },
    AVAXC: { minConfirm: 12, unLockConfirm: 0 },
    ARBITRUM: { minConfirm: 120, unLockConfirm: 120 },
    BASE: { minConfirm: 1, unLockConfirm: 100 },
    ETH: { minConfirm: 6, unLockConfirm: 64 },
    OPTIMISM: { minConfirm: 25, unLockConfirm: 100 },
    ZKSYNCERA: { minConfirm: 1, unLockConfirm: 100 },
  },
  ETH: {
    BSC: { minConfirm: 5, unLockConfirm: 0 },
    ETH: { minConfirm: 6, unLockConfirm: 64 },
    ARBITRUM: { minConfirm: 120, unLockConfirm: 120 },
    BASE: { minConfirm: 1, unLockConfirm: 100 },
    OPTIMISM: { minConfirm: 25, unLockConfirm: 100 },
    SCROLL: { minConfirm: 1, unLockConfirm: 0 },
    ZKSYNCERA: { minConfirm: 1, unLockConfirm: 100 },
  },
};
