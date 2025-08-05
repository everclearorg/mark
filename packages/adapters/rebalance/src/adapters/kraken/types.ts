export const KRAKEN_BASE_URL = 'https://api.kraken.com';

export interface KrakenDepositMethod {
  method: string;
  fields: string[];
  gen?: boolean;
}

export interface KrakenDepositAddress {
  address: string;
  expiretm?: number;
  new?: boolean;
}

export interface KrakenDepositRecord {
  method: string;
  aclass: string;
  asset: string;
  refid: string;
  txid: string;
  info: string;
  amount: string;
  fee: string;
  time: number;
  status: string; // "Success", "Settled", "Pending", "Failure"
  'status-prop'?: string;
}

export interface KrakenWithdrawMethod {
  asset: string;
  method: string;
  network?: string;
  minimum: string;
}

export interface KrakenWithdrawInfo {
  method: string;
  limit: string;
  amount: string;
  fee: string;
}

export interface KrakenWithdrawResponse {
  refid: string;
}

export interface KrakenWithdrawRecord {
  asset: string;
  refid: string;
  txid: string;
  info: string;
  amount: string;
  fee: string;
  time: number;
  status: string; // "Initial", "Pending", "Settled", "Success", "Failure"
  'status-prop'?: string;
  key?: string;
}

export interface KrakenAssetMapping {
  chainId: number;
  krakenAsset: string;
  krakenSymbol: string;
  method: string;
  minWithdrawalAmount: string;
  withdrawalFee: string;
  depositConfirmations: number;
  network?: string;
}

export interface WithdrawalStatus {
  status: 'completed' | 'pending' | 'failed';
  onChainConfirmed: boolean;
  txId?: string;
}

export interface KrakenSystemStatus {
  status: string; // "online", "maintenance", "cancel_only", "post_only"
  timestamp: string;
}

export interface KrakenAssetInfo {
  aclass: string;
  altname: string;
  decimals: number;
  display_decimals: number;
  collateral_value?: number;
  status?: string;
}

export interface KrakenBalance {
  [asset: string]: string;
}

export const KRAKEN_DEPOSIT_STATUS = {
  SUCCESS: 'Success',
  SETTLED: 'Settled',
  PENDING: 'Pending',
  FAILURE: 'Failure',
} as const;

export const KRAKEN_WITHDRAWAL_STATUS = {
  INITIAL: 'Initial',
  PENDING: 'Pending',
  SETTLED: 'Settled',
  SUCCESS: 'Success',
  FAILURE: 'Failure',
} as const;

export const KRAKEN_SYSTEM_STATUS = {
  ONLINE: 'online',
  MAINTENANCE: 'maintenance',
  CANCEL_ONLY: 'cancel_only',
  POST_ONLY: 'post_only',
} as const;