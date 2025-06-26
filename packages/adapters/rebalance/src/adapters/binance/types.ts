export const BINANCE_BASE_URL = 'https://api.binance.com';

// Binance API response interfaces
export interface DepositAddress {
  address: string;
  coin: string;
  tag: string;
  url: string;
}

export interface DepositRecord {
  amount: string;
  coin: string;
  network: string;
  status: number; // 0-pending, 1-success
  address: string;
  txId: string;
  insertTime: number;
  transferType: number;
  confirmTimes: string;
}

export interface WithdrawParams {
  coin: string;
  withdrawOrderId?: string;
  network?: string;
  address: string;
  addressTag?: string;
  amount: string;
  transactionFeeFlag?: boolean;
}

export interface WithdrawResponse {
  id: string;
}

export interface WithdrawRecord {
  id: string;
  amount: string;
  transactionFee: string;
  coin: string;
  status: number; // 0-Email Sent, 1-Cancelled, 2-Awaiting Approval, 3-Rejected, 4-Processing, 5-Failure, 6-Completed
  address: string;
  txId: string;
  applyTime: string;
  network: string;
  transferType: number;
  confirmNo: number;
  info: string;
  txKey: string;
  withdrawOrderId?: string; // Custom order ID we provided when creating withdrawal
}

// Configuration interfaces
export interface BinanceAssetMapping {
  chainId: number;
  onChainAddress: string;
  binanceSymbol: string;
  network: string; // e.g., "ETH", "BSC", "MATIC"
  minWithdrawalAmount: string;
  withdrawalFee: string;
  depositConfirmations: number;
}

// Internal status tracking
export interface WithdrawalStatus {
  status: 'completed' | 'pending' | 'failed';
  onChainConfirmed: boolean;
  txId?: string;
}

export interface WithdrawQuotaResponse {
  wdQuota: string; // Total withdrawal quota in USD (24hr)
  usedWdQuota: string; // Used withdrawal quota in USD (24hr)
}

export interface TickerPrice {
  symbol: string;
  price: string;
}

export interface NetworkConfig {
  network: string;
  name: string;
  isDefault: boolean;
  depositEnable: boolean;
  withdrawEnable: boolean;
  withdrawFee: string;
  withdrawMin: string;
  withdrawMax: string;
  minConfirm: number;
  unLockConfirm?: number;
  addressRegex?: string;
  memoRegex?: string;
  specialTips?: string;
  specialWithdrawTips?: string;
  depositDust?: string;
  withdrawIntegerMultiple?: string;
  sameAddress?: boolean;
  estimatedArrivalTime?: number;
  busy?: boolean;
  contractAddressUrl?: string;
  contractAddress?: string;
}

export interface CoinConfig {
  coin: string;
  name: string;
  networkList: NetworkConfig[];
  free: string;
  locked: string;
  freeze: string;
  withdrawing: string;
  ipoing: string;
  ipoable: string;
  storage: string;
  isLegalMoney: boolean;
  trading: boolean;
  depositAllEnable: boolean;
  withdrawAllEnable: boolean;
}
