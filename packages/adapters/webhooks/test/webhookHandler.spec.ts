import { WebhookHandler } from '../src/webhookHandler';
import { Logger } from '@mark/logger';
import { WebhookEventProcessor, WebhookEventType, InvoiceEnqueuedEvent, SettlementEnqueuedEvent } from '@mark/core';
import {
  WebhookPayload,
  InvoiceEnqueuedWebhookPayload,
  SettlementEnqueuedWebhookPayload,
} from '../src/types';
import { createHmac } from 'crypto';
import sinon, { createStubInstance, SinonStubbedInstance } from 'sinon';

describe('WebhookHandler', () => {
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockProcessor: WebhookEventProcessor;
  let webhookHandler: WebhookHandler;
  const webhookSecret = 'test-secret-key';

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockProcessor = {
      processEvent: jest.fn().mockResolvedValue(undefined),
    };
    webhookHandler = new WebhookHandler(webhookSecret, mockLogger, mockProcessor);
  });

  afterEach(() => {
    sinon.restore();
    jest.clearAllMocks();
  });

  describe('handleWebhookRequest', () => {
    const createValidSignature = (body: string): string => {
      const hmac = createHmac('sha256', webhookSecret);
      hmac.update(body);
      return `sha256=${hmac.digest('hex')}`;
    };

    const createInvoiceEnqueuedPayload = (): InvoiceEnqueuedWebhookPayload => ({
      op: 'INSERT',
      data_source: 'test',
      data: {
        old: null,
        new: {
          id: '',
          invoice: {
            id: 'invoice-123',
            intent: {
              id: 'intent-123',
              queueIdx: '0',
              status: 'ADDED',
              initiator: '0xinitiator',
              receiver: '0xreceiver',
              inputAsset: '0xinput',
              outputAsset: '0xoutput',
              maxFee: '1000',
              origin: '1',
              nonce: '0',
              timestamp: '1234567890',
              ttl: '3600',
              amount: '1000000000000000000',
              destinations: ['8453'],
              data: '0x',
            },
            tickerHash: '0xticker',
            amount: '1000000000000000000',
            owner: '0xowner',
            entryEpoch: '1',
          },
          transactionHash: '0xtxhash',
          timestamp: '1234567890',
          gasPrice: '20000000000',
          gasLimit: '21000',
          blockNumber: '100',
          txOrigin: '0xorigin',
          txNonce: '0',
        },
        op: 'INSERT',
      },
      webhook_name: 'invoice-enqueued',
      webhook_id: 'webhook-123',
      id: 'event-123',
      delivery_info: {
        max_retries: 3,
        current_retry: 0,
      },
      entity: 'InvoiceEnqueuedEvent',
    });

    const createSettlementEnqueuedPayload = (): SettlementEnqueuedWebhookPayload => ({
      op: 'INSERT',
      data_source: 'test',
      data: {
        old: null,
        new: {
          id: '',
          intentId: 'intent-456',
          domain: '1',
          entryEpoch: '1',
          asset: '0xasset',
          amount: '1000000000000000000',
          updateVirtualBalance: false,
          owner: '0xowner',
          transactionHash: '0xtxhash',
          timestamp: '1234567890',
          gasPrice: '20000000000',
          gasLimit: '21000',
          blockNumber: '100',
          txOrigin: '0xorigin',
          txNonce: '0',
        },
        op: 'INSERT',
      },
      webhook_name: 'settlement-enqueued',
      webhook_id: 'webhook-456',
      id: 'event-456',
      delivery_info: {
        max_retries: 3,
        current_retry: 0,
      },
      entity: 'SettlementEnqueuedEvent',
    });

    it('should successfully handle invoice-enqueued webhook with valid signature', async () => {
      const payload = createInvoiceEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      const result = await webhookHandler.handleWebhookRequest(rawBody, signature, 'invoice-enqueued');

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.processed).toBe(true);
      expect(responseBody.webhookId).toBe('webhook-123');
      expect(mockProcessor.processEvent).toHaveBeenCalledWith(
        'webhook-123',
        WebhookEventType.InvoiceEnqueued,
        expect.objectContaining({
          id: 'invoice-123',
          invoice: expect.any(Object),
        }),
      );
    });

    it('should successfully handle settlement-enqueued webhook with valid signature', async () => {
      const payload = createSettlementEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      const result = await webhookHandler.handleWebhookRequest(rawBody, signature, 'settlement-enqueued');

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.processed).toBe(true);
      expect(responseBody.webhookId).toBe('webhook-456');
      expect(mockProcessor.processEvent).toHaveBeenCalledWith(
        'webhook-456',
        WebhookEventType.SettlementEnqueued,
        expect.objectContaining({
          id: 'intent-456',
          intentId: 'intent-456',
        }),
      );
    });

    it('should reject webhook with invalid signature', async () => {
      const payload = createInvoiceEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      const invalidSignature = 'sha256=invalid-signature';

      const result = await webhookHandler.handleWebhookRequest(rawBody, invalidSignature, 'invoice-enqueued');

      expect(result.statusCode).toBe(401);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.error).toBe('Invalid signature');
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
      expect(mockLogger.warn.calledWithMatch('Invalid webhook signature')).toBe(true);
    });

    it('should reject webhook without signature header', async () => {
      const payload = createInvoiceEnqueuedPayload();
      const rawBody = JSON.stringify(payload);

      const result = await webhookHandler.handleWebhookRequest(rawBody, undefined, 'invoice-enqueued');

      expect(result.statusCode).toBe(401);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.error).toBe('Invalid signature');
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
      expect(mockLogger.warn.calledWithMatch('No signature header provided')).toBe(true);
    });

    it('should handle webhook with no new data', async () => {
      const payload: InvoiceEnqueuedWebhookPayload = {
        ...createInvoiceEnqueuedPayload(),
        data: {
          old: null,
          new: null,
          op: 'DELETE',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      const result = await webhookHandler.handleWebhookRequest(rawBody, signature, 'invoice-enqueued');

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.processed).toBe(false);
      expect(responseBody.message).toBe('No new data in webhook payload');
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
    });

    it('should handle unknown webhook type', async () => {
      const payload: WebhookPayload = {
        op: 'INSERT',
        data_source: 'test',
        data: {
          old: null,
          new: { test: 'data' },
          op: 'INSERT',
        },
        webhook_name: 'unknown-webhook' as any,
        webhook_id: 'webhook-unknown',
        id: 'event-unknown',
        delivery_info: {
          max_retries: 3,
          current_retry: 0,
        },
        entity: 'UnknownEvent',
      };
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      const result = await webhookHandler.handleWebhookRequest(rawBody, signature, 'unknown-webhook');

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.processed).toBe(false);
      expect(responseBody.message).toContain('Unknown webhook type');
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
    });

    it('should handle JSON parse errors', async () => {
      const invalidJson = '{ invalid json }';
      const signature = createValidSignature(invalidJson);

      const result = await webhookHandler.handleWebhookRequest(invalidJson, signature, 'invoice-enqueued');

      expect(result.statusCode).toBe(500);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.error).toBe('Internal server error');
      expect(mockLogger.error.calledWithMatch('Error handling webhook request')).toBe(true);
    });

    it('should handle processor errors gracefully', async () => {
      const payload = createInvoiceEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      const processorError = new Error('Processor failed');
      mockProcessor.processEvent = jest.fn().mockRejectedValue(processorError);

      const result = await webhookHandler.handleWebhookRequest(rawBody, signature, 'invoice-enqueued');

      expect(result.statusCode).toBe(500);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.error).toBe('Internal server error');
      expect(mockLogger.error.calledWithMatch('Error handling webhook request')).toBe(true);
    });

    it('should set invoice event id from invoice.id', async () => {
      const payload = createInvoiceEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      await webhookHandler.handleWebhookRequest(rawBody, signature, 'invoice-enqueued');

      expect(mockProcessor.processEvent).toHaveBeenCalledWith(
        'webhook-123',
        WebhookEventType.InvoiceEnqueued,
        expect.objectContaining({
          id: 'invoice-123', // Should be set from invoice.id
        }),
      );
    });

    it('should set settlement event id from intentId', async () => {
      const payload = createSettlementEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      await webhookHandler.handleWebhookRequest(rawBody, signature, 'settlement-enqueued');

      expect(mockProcessor.processEvent).toHaveBeenCalledWith(
        'webhook-456',
        WebhookEventType.SettlementEnqueued,
        expect.objectContaining({
          id: 'intent-456', // Should be set from intentId
        }),
      );
    });

    it('should log webhook request details', async () => {
      const payload = createInvoiceEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      const signature = createValidSignature(rawBody);

      await webhookHandler.handleWebhookRequest(rawBody, signature, 'invoice-enqueued');

      expect(mockLogger.info.calledWithMatch('Webhook request received')).toBe(true);
    });

    it('should handle signature verification errors', async () => {
      const payload = createInvoiceEnqueuedPayload();
      const rawBody = JSON.stringify(payload);
      // Invalid hex signature that will cause an error in Buffer.from
      const invalidHexSignature = 'sha256=invalid-hex-signature-zzz';

      const result = await webhookHandler.handleWebhookRequest(rawBody, invalidHexSignature, 'invoice-enqueued');

      expect(result.statusCode).toBe(401);
      expect(mockLogger.error.calledWithMatch('Error verifying webhook signature')).toBe(true);
    });
  });
});
