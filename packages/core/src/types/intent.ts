export interface NewIntentParams {
  origin: string;
  destinations: string[];
  to: string;
  inputAsset: string;
  amount: string | number;
  callData: string;
  maxFee: string | number;
  // svm intents only
  user?: string;
}

export interface OrderParams {
  destinations: string[];
  receiver: string;
  inputAsset: string;
  outputAsset: string;
  amount: string | number;
  maxFee: string | number;
  ttl: string | number;
  data: string;
}

export interface NewOrderParams {
  fee: string | number;
  intents: OrderParams[];
}

export interface Permit2Params {
  nonce: string | number;
  deadline: string | number;
  signature: string;
}

export interface NewIntentWithPermit2Params {
  origin: string;
  destinations: string[];
  to: string;
  inputAsset: string;
  amount: string | number;
  callData: string;
  maxFee: string | number;
  permit2Params: Permit2Params;
}

export type IntentStatus = "NONE" | "ADDED" | "ADDED_SPOKE" | "ADDED_HUB" | "DEPOSIT_PROCESSED" | "FILLED" | "ADDED_AND_FILLED" | "INVOICED" | "SETTLED" | "SETTLED_AND_COMPLETED" | "SETTLED_AND_MANUALLY_EXECUTED" | "UNSUPPORTED" | "UNSUPPORTED_RETURNED" | "DISPATCHED_HUB" | "DISPATCHED_SPOKE" | "DISPATCHED_UNSUPPORTED";
export interface GetIntentsParams {
  statuses: IntentStatus[];
  destinations: string[];
  outputAsset: string;
  limit?: number;
  origins?: string[];
  txHash?: string;
  userAddress?: string;
  startDate?: number;
  endDate?: number;
  tickerHash?: string;
  isFastPath?: boolean;
}

export interface Invoice {
  amount: string;
  intent_id: string;
  owner: string;
  entry_epoch: number;
  origin: string;
  destinations: string[];
  ticker_hash: string;
  discountBps: number;
  hub_status: string; // TODO: opinionated type
  hub_invoice_enqueued_timestamp: number;
}

export interface Intent {
  intent_id: string;
  batch_id?: string | null;
  queue_idx: number;
  message_id: string;
  status: IntentStatus;
  receiver: string;
  input_asset: string;
  output_asset: string;
  origin_amount: string;
  destination_amount?: string | null;
  origin: string;
  destinations: string[];
  nonce: number;
  transaction_hash: string;
  receive_tx_hash?: string | null;
  intent_created_timestamp: number;
  settlement_timestamp?: number | null;
  intent_created_block_number: number;
  receive_blocknumber?: number | null;
  tx_origin: string;
  tx_nonce: number;
  auto_id: number;
  amount_out_min: string;
  call_data?: string | null;
  filled?: boolean | null;
  initiator?: string | null;
  native_fee?: string | null;
  token_fee?: string | null;
  fee_adapter_initiator?: string | null;
  origin_gas_fees: string;
  destination_gas_fees?: string | null;
  hub_settlement_domain?: string | null;
  ttl: number | null;
  is_fast_path?: boolean;
  fill_solver?: string | null;
  fill_domain?: string | null;
  fill_destinations?: string[] | null;
  fill_transaction_hash?: string | null;
  fill_timestamp?: number | null;
  fill_amount?: string | null;
  fill_fee_token?: string | null;
  fill_fee_dbps?: string | null;
  fill_input_asset?: string | null;
  fill_output_asset?: string | null;
  fill_sender?: string | null;
  fill_status?: string | null;
  fill_initiator?: string | null;
  fill_receiver?: string | null;
  max_fee?: string;
}

export const InvalidPurchaseReasons = {
  InvalidAmount: `Invalid amount, could not convert to BigInt.`,
  InvalidFormat: `Invalid invoice format in either amount, invoice presence, or id.`,
  InvalidOwner: `This is our invoice, will not settle.`,
  InvalidDestinations: `No matched destinations.`,
  InvalidTickers: `No matched tickers.`,
  InvalidAge: `Invoice not yet old enough.`,
  InsufficientBalance: `Insufficient balance to support purchase.`,
  InvalidTokenConfiguration: `Destination tokey not configured.`,
  DestinationXerc20: `Invoice destinations support xerc20.`,
  PendingPurchaseRecord: `Invoice has a cached purchase attempt.`,
  TransactionFailed: `Transaction to purchase intent failed.`,
} as const;
export type InvalidPurchaseReasonConcise = keyof typeof InvalidPurchaseReasons;
export type InvalidPurchaseReasonVerbose = (typeof InvalidPurchaseReasons)[InvalidPurchaseReasonConcise];
