import { InvalidPurchaseReasons } from '@mark/core';
import { PrometheusAdapter, RewardLabels, InvoiceLabels } from '../src';
import { Logger } from '@mark/logger';

// mock logger
jest.mock('@mark/logger', () => {
  return {
    jsonifyError: jest.fn(),
    Logger: jest.fn().mockImplementation(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      logger: {}
    }))
  };
});

describe('PrometheusAdapter', () => {
  let adapter: PrometheusAdapter;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = new Logger({ service: 'test-service' });
    adapter = new PrometheusAdapter(
      mockLogger,
      'test-job',
      'http://localhost:9091'
    );
  });

  describe('chain balance metrics', () => {
    it('should update chain balance', async () => {
      adapter.updateChainBalance('ethereum', 'ETH', BigInt('1500000000000000000'));
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_chain_balance{chain="ethereum",token="ETH"} 1.5');
    });

    it('should update gas balance', async () => {
      adapter.updateGasBalance('ethereum', BigInt('2000000000000000000'));
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_gas_balance{chain="ethereum"} 2');
    });
  });

  describe('invoice metrics', () => {
    const invoiceLabels: InvoiceLabels = {
      origin: 'ethereum',
      ticker: '0xtickerhash',
      id: '123',
      destination: undefined,
    };

    it('should record possible invoice', async () => {
      adapter.recordPossibleInvoice(invoiceLabels);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_invoices_possible_total{origin="ethereum",ticker="0xtickerhash",id="123",destination="undefined"} 1');
    });

    it('should record successful invoice', async () => {
      adapter.recordSuccessfulPurchase(invoiceLabels);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_success_purchases_total{origin="ethereum",ticker="0xtickerhash",id="123",destination="undefined"} 1');
    });

    it('should record invalid invoice', async () => {
      adapter.recordInvalidPurchase(InvalidPurchaseReasons.InvalidOwner, invoiceLabels);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_invoices_invalid_total{origin="ethereum",ticker="0xtickerhash",id="123",destination="undefined",reason="InvalidOwner"} 1');
    });
  });

  describe('timing metrics', () => {
    it('should record invoice purchase time', async () => {
      adapter.recordInvoicePurchaseDuration(5);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_invoice_purchase_duration_seconds_bucket{le="10"} 1');
    });

    it('should record invoice clearance time', async () => {
      adapter.recordPurchaseClearanceDuration(5);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_clearance_duration_seconds_bucket{le="10"} 1');
    });
  });

  describe('rewards metrics', () => {
    it('should update rewards', async () => {
      const rewardLabels: RewardLabels = {
        chain: 'ethereum',
        asset: '0xtoken',
        id: '123',
        ticker: 'ETH'
      };
      adapter.updateRewards(rewardLabels, 0.1);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_rewards_total{chain="ethereum",asset="0xtoken",id="123",ticker="ETH"} 0.1');
    });
  });
});
