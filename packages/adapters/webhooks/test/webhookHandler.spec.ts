import { WebhookHandler } from '../src/webhookHandler';
import { Logger } from '@mark/logger';
import { WebhookEventProcessor, WebhookEventType } from '@mark/core';
import sinon, { createStubInstance, SinonStubbedInstance } from 'sinon';

describe('WebhookHandler', () => {
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockProcessor: WebhookEventProcessor;
  let webhookHandler: WebhookHandler;
  const webhookSecret = 'test-secret-key';

  // Helper to create base64-encoded hex value (mirrors what Goldsky Mirror sends)
  const hexToBase64 = (hex: string): string => {
    return Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('base64');
  };

  const invoiceEventIdHex = '0xacb1d84230a8658d2dd74cb7ea78d4f41b000596ce071c39d15bc504a1211a3517000000';
  const intentIdHex = '0x61fc09452a0b53b13ad6595ce4487fb0fac86c31e768e5ccd051f6664fc4281c';
  const txHashHex = '0xacb1d84230a8658d2dd74cb7ea78d4f41b000596ce071c39d15bc504a1211a35';
  const txOriginHex = '0x417b4adc279743fc49f047c323fc6689b9e600d8';

  const createInvoicePayload = () => ({
    vid: 218,
    block: 3356345,
    id: hexToBase64(invoiceEventIdHex),
    invoice: hexToBase64(invoiceEventIdHex),
    intent: hexToBase64(intentIdHex),
    transaction_hash: hexToBase64(txHashHex),
    timestamp: 1764763760,
    block_number: 3356345,
    tx_origin: hexToBase64(txOriginHex),
    tx_nonce: 17647637600023,
    _gs_chain: 'everclear',
    _gs_gid: '7f5a2cf51bca72aedbc7896455ab5dfb',
  });

  const createSettlementPayload = () => ({
    vid: 276,
    block: 2979629,
    id: hexToBase64(invoiceEventIdHex),
    settlement: hexToBase64(intentIdHex),
    intent: hexToBase64(intentIdHex),
    domain: 10,
    queue: 'Cg==',
    queue_idx: 88,
    transaction_hash: hexToBase64(txHashHex),
    timestamp: 1761834259,
    block_number: 2979629,
    tx_origin: hexToBase64(txOriginHex),
    tx_nonce: 17618342590000,
    _gs_chain: 'everclear',
    _gs_gid: '750810d0d862d3ca42ad7c130e734b9',
  });

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
    it('should handle invoice-enqueued webhook', async () => {
      const payload = createInvoicePayload();
      const rawBody = JSON.stringify(payload);

      const result = await webhookHandler.handleWebhookRequest(rawBody, webhookSecret, 'invoice-enqueued');

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.processed).toBe(true);
      // The intent field is the actual invoice/intent ID used by the Everclear API
      expect(mockProcessor.processEvent).toHaveBeenCalledWith(
        intentIdHex,
        WebhookEventType.InvoiceEnqueued,
        { id: intentIdHex },
      );
    });

    it('should handle settlement-enqueued webhook', async () => {
      const payload = createSettlementPayload();
      const rawBody = JSON.stringify(payload);

      const result = await webhookHandler.handleWebhookRequest(rawBody, webhookSecret, 'settlement-enqueued');

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.processed).toBe(true);
      expect(mockProcessor.processEvent).toHaveBeenCalledWith(
        intentIdHex,
        WebhookEventType.SettlementEnqueued,
        { id: intentIdHex },
      );
    });

    it('should reject webhook with invalid secret', async () => {
      const rawBody = JSON.stringify(createInvoicePayload());

      const result = await webhookHandler.handleWebhookRequest(rawBody, 'invalid-secret', 'invoice-enqueued');

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toBe('Invalid webhook secret');
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
    });

    it('should reject webhook without secret header', async () => {
      const rawBody = JSON.stringify(createInvoicePayload());

      const result = await webhookHandler.handleWebhookRequest(rawBody, undefined, 'invoice-enqueued');

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toBe('Invalid webhook secret');
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
    });

    it('should return not processed for missing intent field on invoice', async () => {
      const payload = createInvoicePayload();
      delete (payload as any).intent;
      const rawBody = JSON.stringify(payload);

      const result = await webhookHandler.handleWebhookRequest(rawBody, webhookSecret, 'invoice-enqueued');

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).processed).toBe(false);
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
    });

    it('should return not processed for missing intent field on settlement', async () => {
      const payload = createSettlementPayload();
      delete (payload as any).intent;
      const rawBody = JSON.stringify(payload);

      const result = await webhookHandler.handleWebhookRequest(rawBody, webhookSecret, 'settlement-enqueued');

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).processed).toBe(false);
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
    });

    it('should return not processed for unknown webhook type', async () => {
      const rawBody = JSON.stringify(createInvoicePayload());

      const result = await webhookHandler.handleWebhookRequest(rawBody, webhookSecret, 'unknown-type');

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.processed).toBe(false);
      expect(responseBody.message).toContain('Unknown webhook type');
      expect(mockProcessor.processEvent).not.toHaveBeenCalled();
    });

    it('should handle JSON parse errors', async () => {
      const result = await webhookHandler.handleWebhookRequest('{ invalid json }', webhookSecret, 'invoice-enqueued');

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toBe('Internal server error');
    });

    it('should handle processor errors gracefully', async () => {
      mockProcessor.processEvent = jest.fn().mockRejectedValue(new Error('Processor failed'));
      const rawBody = JSON.stringify(createInvoicePayload());

      const result = await webhookHandler.handleWebhookRequest(rawBody, webhookSecret, 'invoice-enqueued');

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toBe('Internal server error');
    });

    it('should log webhook request details', async () => {
      const rawBody = JSON.stringify(createInvoicePayload());

      await webhookHandler.handleWebhookRequest(rawBody, webhookSecret, 'invoice-enqueued');

      expect(mockLogger.info.calledWithMatch('Webhook request received')).toBe(true);
    });
  });
});
