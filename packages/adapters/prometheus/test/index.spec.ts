import { PrometheusAdapter } from '../src';

describe('PrometheusAdapter', () => {
  let adapter: PrometheusAdapter;

  beforeEach(() => {
    adapter = new PrometheusAdapter();
  });

  describe('chain balance metrics', () => {
    it('should update chain balance', async () => {
      adapter.updateChainBalance('ethereum', 'ETH', BigInt('1500000000000000000'), 18);
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
    const invoiceLabels = {
      origin: 'ethereum',
      asset: 'ETH',
      id: '123'
    };

    it('should record possible invoice', async () => {
      adapter.recordPossibleInvoice(invoiceLabels);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_invoices_possible_total{origin="ethereum",asset="ETH",id="123"} 1');
    });

    it('should record successful invoice', async () => {
      adapter.recordSuccessfulInvoice(invoiceLabels);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_invoices_success_total{origin="ethereum",asset="ETH",id="123"} 1');
    });

    it('should record invalid invoice', async () => {
      adapter.recordInvalidInvoice('insufficient_balance', invoiceLabels);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_invoices_invalid_total{origin="ethereum",asset="ETH",id="123",reason="insufficient_balance"} 1');
    });
  });

  describe('timing metrics', () => {
    it('should record settlement time', async () => {
      adapter.recordSettlementTime(10);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_settlement_duration_seconds_bucket{le="30"} 1');
    });

    it('should record invoice fill time', async () => {
      adapter.recordInvoiceFillTime(5);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_invoice_fill_duration_seconds_bucket{le="10"} 1');
    });
  });

  describe('rewards metrics', () => {
    it('should update rewards', async () => {
      const rewardLabels = {
        origin: 'ethereum',
        asset: 'ETH',
        id: '123',
        ticker: 'ETH'
      };
      adapter.updateRewards(rewardLabels, 0.1);
      const metrics = await adapter.getMetrics();
      expect(metrics).toContain('mark_rewards_total{origin="ethereum",asset="ETH",id="123",ticker="ETH"} 0.1');
    });
  });
});
