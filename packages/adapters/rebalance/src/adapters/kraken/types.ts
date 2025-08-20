export const KRAKEN_BASE_URL = 'https://api.kraken.com';

export interface KrakenDepositMethod {
  method: string;
  limit: boolean;
  minimum: string;
  'gen-address': boolean;
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
  method_id: string;
  method: string;
  network_id: string;
  network: string;
  minimum: string;
  limits: {
    limit_type: 'equiv_amount' | 'amount';
    description: string;
    limits: Record<
      string,
      {
        remaining: string;
        maximum: string;
        used: string;
      }
    >;
  }[];
  fee: {
    aclass: string;
    asset: string;
    fee: string;
  };
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

// sample:
// {
//   method: 'Ether',
//   aclass: 'currency',
//   asset: 'XETH',
//   refid: 'FTcKzfZ-dhGXkAnj7RIPePzuzei2LH',
//   txid: '0x861bd84f59da66d935420e0638300076c404bfc9335c9278a069f2d7ca938b3d',
//   info: '0xade09131c6f43fe22c2cbabb759636c43cfc181e',
//   amount: '0.0048800000',
//   fee: '0.0001200000',
//   time: 1755637661,
//   status: 'Success',
//   key: '0xade09131C6f43fe22C2CbABb759636C43cFc181e',
//   network: 'Ethereum'
// }
export interface KrakenWithdrawRecord {
  method: string;
  aclass: string;
  asset: string;
  refid: string;
  txid: string;
  info: string;
  amount: string;
  fee: string;
  time: number;
  status: string; // "Initial", "Pending", "Settled", "Success", "Failure"
  'status-prop'?: string;
  network: string;
}

export interface KrakenAssetMapping {
  chainId: number;
  krakenAsset: string;
  krakenSymbol: string;
  depositMethod: KrakenDepositMethod;
  withdrawMethod: KrakenWithdrawMethod;
  network: string;
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
