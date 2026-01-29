import { timingSafeEqual } from 'crypto';
import { Logger, jsonifyError } from '@mark/logger';
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
    webhookSecretHeader?: string,
    webhookName?: string,
  ): Promise<WebhookHandlerResult> {
    try {
      // Log webhook receipt without sensitive data (secret header)
      // Only log body length to avoid potential PII in logs
      this.logger.info('Webhook request received', {
        bodyLength: rawBody.length,
        hasSecretHeader: !!webhookSecretHeader,
        webhookName,
      });

      if (!this.verifyWebhookSecret(webhookSecretHeader)) {
        this.logger.warn('Invalid webhook secret', {
          hasSecret: !!webhookSecretHeader,
          webhookName,
        });
        return {
          statusCode: 401,
          body: JSON.stringify({ error: 'Invalid webhook secret' }),
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
        webhookName,
        error: jsonifyError(error),
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
   * Verify webhook secret
   * Goldsky subgraph webhooks send the secret directly in the 'goldsky-webhook-secret' header.
   * We compare this header value directly with the configured webhook secret.
   */
  private verifyWebhookSecret(webhookSecretHeader?: string): boolean {
    if (!webhookSecretHeader) {
      this.logger.warn('No webhook secret header provided');
      return false;
    }

    try {
      // Goldsky subgraph webhooks send the secret directly in the header
      // Use timing-safe comparison to prevent timing attacks
      const providedSecret = Buffer.from(webhookSecretHeader);
      const expectedSecret = Buffer.from(this.webhookSecret);

      if (providedSecret.length !== expectedSecret.length) {
        return false;
      }

      return timingSafeEqual(providedSecret, expectedSecret);
    } catch (error) {
      this.logger.error('Error verifying webhook secret', {
        error: jsonifyError(error),
      });
      return false;
    }
  }
}
