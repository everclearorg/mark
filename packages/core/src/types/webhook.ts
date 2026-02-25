// InvoiceEnqueued event — only the ID is used at runtime.
// Full invoice data is fetched from the Everclear API during processing.
export interface InvoiceEnqueuedEvent {
  id: string; // intent/invoice ID
}

// SettlementEnqueued event — only the intent ID is used at runtime.
export interface SettlementEnqueuedEvent {
  id: string; // intent/invoice ID
}

export enum WebhookEventType {
  InvoiceEnqueued = 'InvoiceEnqueued',
  SettlementEnqueued = 'SettlementEnqueued',
}

export type WebhookEvent = InvoiceEnqueuedEvent | SettlementEnqueuedEvent;

export type WebhookEventProcessor = {
  processEvent: (id: string, type: WebhookEventType, data: WebhookEvent) => Promise<void>;
};
