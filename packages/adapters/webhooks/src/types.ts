import { InvoiceEnqueuedEvent, SettlementEnqueuedEvent } from '@mark/core';

// Goldsky webhook event structure
export interface WebhookPayload<T = unknown> {
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  data_source: string;
  data: { old: T | null; new: T | null; op: 'INSERT' | 'UPDATE' | 'DELETE' };
  webhook_name: string;
  webhook_id: string;
  id: string; // event id
  delivery_info: { max_retries: number; current_retry: number };
  entity: string;
}

// InvoiceEnqueued webhook payload
export interface InvoiceEnqueuedWebhookPayload extends WebhookPayload<InvoiceEnqueuedEvent> {
  webhook_name: 'invoice-enqueued';
  entity: 'InvoiceEnqueuedEvent';
}

// SettlementEnqueued webhook payload
export interface SettlementEnqueuedWebhookPayload extends WebhookPayload<SettlementEnqueuedEvent> {
  webhook_name: 'settlement-enqueued';
  entity: 'SettlementEnqueuedEvent';
}
