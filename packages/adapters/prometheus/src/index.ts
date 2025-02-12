import { Gauge, Counter, Histogram, Registry } from 'prom-client';
import { formatUnits } from 'viem';

type InvoiceLabels = Record<'origin' | 'asset' | 'id', string>;
type RewardLabels = Record<'origin' | 'asset' | 'id' | 'ticker', string>;

export class PrometheusAdapter {
  private registry: Registry;

  // Balance metrics
  private chainBalance: Gauge<string>;
  private gasBalance: Gauge<string>;

  // Invoice metrics
  private possibleInvoices: Counter<string>;
  private successfulInvoices: Counter<string>;
  private invalidInvoices: Counter<string>;

  // Timing metrics
  private settlementTime: Histogram<string>;
  private invoiceFillTime: Histogram<string>;

  // Rewards metrics
  private rewards: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Initialize chain balance gauge
    this.chainBalance = new Gauge({
      name: 'mark_chain_balance',
      help: 'Current balance of Mark across different chains',
      labelNames: ['chain', 'token'],
      registers: [this.registry],
    });

    // Initialize gas balance gauge
    this.gasBalance = new Gauge({
      name: 'mark_gas_balance',
      help: 'Current gas balance of Mark across different chains',
      labelNames: ['chain'],
      registers: [this.registry],
    });

    // Initialize invoice metrics
    this.possibleInvoices = new Counter({
      name: 'mark_invoices_possible_total',
      help: 'Total number of invoices Mark could potentially fill',
      labelNames: ['origin', 'asset', 'id'],
      registers: [this.registry],
    });

    this.successfulInvoices = new Counter({
      name: 'mark_invoices_success_total',
      help: 'Total number of successfully filled invoices',
      labelNames: ['origin', 'asset', 'id'],
      registers: [this.registry],
    });

    this.invalidInvoices = new Counter({
      name: 'mark_invoices_invalid_total',
      help: 'Total number of invalid invoices',
      registers: [this.registry],
      labelNames: ['reason', 'origin', 'asset', 'id'],
    });

    // Initialize timing metrics
    this.settlementTime = new Histogram({
      name: 'mark_settlement_duration_seconds',
      help: 'Time taken to settle targets',
      buckets: [1, 5, 10, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    this.invoiceFillTime = new Histogram({
      name: 'mark_invoice_fill_duration_seconds',
      help: 'Time taken to fill invoices',
      buckets: [1, 5, 10, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    // Initialize rewards gauge
    this.rewards = new Gauge({
      name: 'mark_rewards_total',
      help: 'Total rewards earned by Mark',
      labelNames: ['origin', 'asset', 'id', 'ticker'],
      registers: [this.registry],
    });
  }

  // Update chain balance
  public updateChainBalance(chain: string, token: string, balance: bigint, decimals: number): void {
    this.chainBalance.labels({ chain, token }).set(+formatUnits(balance, decimals));
  }

  public updateGasBalance(chain: string, balance: bigint): void {
    this.gasBalance.labels({ chain }).set(+formatUnits(balance, 18));
  }

  // Record possible invoice
  public recordPossibleInvoice(labels: InvoiceLabels): void {
    this.possibleInvoices.labels(labels).inc();
  }

  // Record successful invoice fill
  public recordSuccessfulInvoice(labels: InvoiceLabels): void {
    this.successfulInvoices.labels(labels).inc();
  }

  // Record invalid invoice
  public recordInvalidInvoice(reason: string, labels: InvoiceLabels): void {
    this.invalidInvoices.labels({ ...labels, reason }).inc();
  }

  // Record settlement time
  public recordSettlementTime(durationSeconds: number): void {
    this.settlementTime.observe(durationSeconds);
  }

  // Record invoice fill time
  public recordInvoiceFillTime(durationSeconds: number): void {
    this.invoiceFillTime.observe(durationSeconds);
  }

  // Update rewards
  public updateRewards(labels: RewardLabels, amount: number): void {
    this.rewards.labels(labels).set(amount);
  }

  // Get metrics
  public async getMetrics(): Promise<string> {
    return await this.registry.metrics();
  }
}
