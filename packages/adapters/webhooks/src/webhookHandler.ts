import { createHmac, timingSafeEqual } from 'crypto';
import { Logger } from '@mark/logger';
import { WebhookPayload, InvoiceEnqueuedWebhookPayload, SettlementEnqueuedWebhookPayload } from './types';
import { WebhookEventProcessor, WebhookEventType } from '@mark/core';

interface WebhookHandlerResult {
  statusCode: number;
  body: string;
}

interface WebhookResponse {
  message: string;
  processed: boolean;
  webhookId: string;
}

export class WebhookHandler {
  constructor(
    private readonly webhookSecret: string,
    private readonly logger: Logger,
    private readonly processor: WebhookEventProcessor,
  ) {}

  /**
   * Handle webhook request from Goldsky
   */
  async handleWebhookRequest(
    rawBody: string,
    signatureHeader?: string,
    webhookName?: string,
  ): Promise<WebhookHandlerResult> {
    try {
      this.logger.info('Webhook request received', {
        rawBody,
        signatureHeader,
        webhookName,
      });

      if (!this.verifySignature(rawBody, signatureHeader)) {
        this.logger.warn('Invalid webhook signature', {
          hasSignature: !!signatureHeader,
          webhookName,
        });
        return {
          statusCode: 401,
          body: JSON.stringify({ error: 'Invalid signature' }),
        };
      }

      const payload: WebhookPayload = JSON.parse(rawBody);
      const result = await this.routeWebhook(payload);

      return {
        statusCode: 200,
        body: JSON.stringify(result),
      };
    } catch (error) {
      this.logger.error('Error handling webhook request', {
        error: error instanceof Error ? error.message : 'Unknown error',
        webhookName,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal server error' }),
      };
    }
  }

  /**
   * Route webhook to the appropriate handler
   */
  private async routeWebhook(payload: WebhookPayload): Promise<WebhookResponse> {
    if (!payload.data.new) {
      return { message: 'No new data in webhook payload', processed: false, webhookId: payload.webhook_id };
    }

    switch (payload.webhook_name) {
      case 'invoice-enqueued':
        const invoiceEvent = (payload as InvoiceEnqueuedWebhookPayload).data.new!;
        invoiceEvent.id = invoiceEvent.invoice.id;
        await this.processor.processEvent(payload.webhook_id, WebhookEventType.InvoiceEnqueued, invoiceEvent);
        break;
      case 'settlement-enqueued':
        const settlementEvent = (payload as SettlementEnqueuedWebhookPayload).data.new!;
        settlementEvent.id = settlementEvent.intentId;
        await this.processor.processEvent(payload.webhook_id, WebhookEventType.SettlementEnqueued, settlementEvent);
        break;
      default:
        return {
          message: `Unknown webhook type ${payload.webhook_name}`,
          processed: false,
          webhookId: payload.webhook_id,
        };
    }

    return { message: 'Webhook payload processed', processed: true, webhookId: payload.webhook_id };
  }

  /**
   * Verify webhook signature
   */
  private verifySignature(rawBody: string, signatureHeader?: string): boolean {
    if (!signatureHeader) {
      this.logger.warn('No signature header provided');
      return false;
    }

    try {
      // Extract signature from the header (assuming format: "sha256=<signature>")
      const signature = signatureHeader.replace('sha256=', '');

      // Create HMAC signature
      const hmac = createHmac('sha256', this.webhookSecret);
      hmac.update(rawBody);
      const expectedSignature = hmac.digest('hex');

      // Compare signatures using timing-safe comparison
      const providedSignature = Buffer.from(signature, 'hex');
      const expectedSignatureBuffer = Buffer.from(expectedSignature, 'hex');

      return timingSafeEqual(providedSignature, expectedSignatureBuffer);
    } catch (error) {
      this.logger.error('Error verifying webhook signature', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }
}
