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
