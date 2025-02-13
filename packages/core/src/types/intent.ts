export interface NewIntentParams {
  origin: string;
  destinations: string[];
  to: string;
  inputAsset: string;
  amount: string | number;
  callData: string;
  maxFee: string | number;
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

export interface PurchaseAction {
  target: Invoice;
  purchase: NewIntentParams;
  transactionHash: `0x${string}`;
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
