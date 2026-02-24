import { timingSafeEqual } from 'crypto';
import { Logger, jsonifyError } from '@mark/logger';
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

/**
 * Convert base64-encoded bytes to 0x-prefixed hex string.
 * Mirror pipeline payloads encode byte fields (IDs, hashes) in base64.
 */
function base64ToHex(b64: string): string {
  return '0x' + Buffer.from(b64, 'base64').toString('hex');
}

export class WebhookHandler {
  constructor(
    private readonly webhookSecret: string,
    private readonly logger: Logger,
    private readonly processor: WebhookEventProcessor,
    private readonly minBlockNumber: number = 0,
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
      this.logger.info('Webhook request received', {
        rawBody,
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

      const payload = JSON.parse(rawBody);
      const result = await this.routeWebhook(payload, webhookName);

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
   * Route Mirror pipeline webhook payload to the appropriate handler.
   * Mirror sends flat subgraph entity data with base64-encoded byte fields.
   * Only the entity ID is needed — full data is fetched from the Everclear API during processing.
   */
  private async routeWebhook(payload: Record<string, unknown>, webhookName?: string): Promise<WebhookResponse> {
    const webhookId = (payload._gs_gid as string) || `mirror-${Date.now()}`;

    let webhookType: WebhookEventType;
    switch (webhookName) {
      case 'invoice-enqueued': {
        webhookType = WebhookEventType.InvoiceEnqueued;
        break;
      }
      case 'settlement-enqueued': {
        webhookType = WebhookEventType.SettlementEnqueued;
        break;
      }
      default:
        return { message: `Unknown webhook type: ${webhookName}`, processed: false, webhookId };
    }

    if (!payload.intent) {
      return { message: 'Missing intent field in payload', processed: false, webhookId };
    }

    const invoiceId = base64ToHex(payload.intent as string);
    const blockNumber = typeof payload.block_number === 'number' ? payload.block_number : 0;

    this.logger.info('Processing webhook', {
      webhookId,
      webhookType,
      invoiceId,
      blockNumber,
    });

    if (this.minBlockNumber > 0 && blockNumber < this.minBlockNumber) {
      this.logger.debug('Skipping stale webhook event', {
        webhookId,
        webhookType,
        invoiceId,
        blockNumber,
        minBlockNumber: this.minBlockNumber,
      });
      return { message: 'Skipped stale event', processed: false, webhookId };
    }

    await this.processor.processEvent(invoiceId, webhookType, { id: invoiceId });

    return { message: 'Webhook processed', processed: true, webhookId };
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
