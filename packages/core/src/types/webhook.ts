// InvoiceEnqueued event from the hub contract
export interface InvoiceEnqueuedEvent {
  id: string; // transaction hash and log index
  invoice: {
    id: string; // invoice id (same as intent id)
    intent: {
      id: string; // intent id
      queueIdx: string;
      status: 'ADDED' | 'DISPATCHED' | 'SETTLED' | 'SETTLED_AND_MANUALLY_EXECUTED';
      initiator: string;
      receiver: string;
      inputAsset: string;
      outputAsset: string;
      maxFee: string;
      origin: string;
      nonce: string;
      timestamp: string;
      ttl: string;
      amount: string;
      destinations: string[];
      data: string;
    };
    tickerHash: string;
    amount: string;
    owner: string;
    entryEpoch: string;
  };
  transactionHash: string;
  timestamp: string;
  gasPrice: string;
  gasLimit: string;
  blockNumber: string;
  txOrigin: string;
  txNonce: string;
}

// SettlementEnqueued event from the hub contract
export interface SettlementEnqueuedEvent {
  id: string; // transaction hash and log index
  intentId: string; // intent id (bytes32)
  domain: string; // domain id (uint32)
  entryEpoch: string; // epoch when settlement was created (uint48)
  asset: string; // asset hash (bytes32)
  amount: string; // settlement amount (uint256)
  updateVirtualBalance: boolean; // flag to update virtual balance (bool)
  owner: string; // settlement owner (bytes32)
  transactionHash: string;
  timestamp: string;
  gasPrice: string;
  gasLimit: string;
  blockNumber: string;
  txOrigin: string;
  txNonce: string;
}

export enum WebhookEventType {
  InvoiceEnqueued = 'InvoiceEnqueued',
  SettlementEnqueued = 'SettlementEnqueued',
}

export type WebhookEvent = InvoiceEnqueuedEvent | SettlementEnqueuedEvent;

export type WebhookEventProcessor = {
  processEvent: (id: string, type: WebhookEventType, data: WebhookEvent) => Promise<void>;
};
