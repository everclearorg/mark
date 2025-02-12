import { InvalidPurchaseReasons, InvalidPurchaseReasonConcise, InvalidPurchaseReasonVerbose } from '@mark/core';
import { Gauge, Counter, Histogram, Registry } from 'prom-client';
import { formatUnits } from 'viem';

const InvoiceLabelKeys = ['origin', 'ticker', 'id', 'destination', 'reason'] as const;
export type InvoiceLabels = Omit<Record<(typeof InvoiceLabelKeys)[number], string>, 'destination' | 'reason'> & {
  destination?: string;
  reason?: InvalidPurchaseReasonConcise;
};

const RewardLabelKeys = ['chain', 'asset', 'id', 'ticker'] as const;
export type RewardLabels = Record<(typeof RewardLabelKeys)[number], string>;

export class PrometheusAdapter {
  private registry: Registry;

  // Balance metrics
  private chainBalance: Gauge<string>;
  private gasBalance: Gauge<string>;

  // Invoice metrics
  private possibleInvoices: Counter<string>;
  private successfulPurchases: Counter<string>;
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
      labelNames: InvoiceLabelKeys,
      registers: [this.registry],
    });

    this.successfulPurchases = new Counter({
      name: 'mark_success_purchases_total',
      help: 'Total number of successfully filled invoices',
      labelNames: InvoiceLabelKeys,
      registers: [this.registry],
    });

    this.invalidInvoices = new Counter({
      name: 'mark_invoices_invalid_total',
      help: 'Total number of invalid invoices',
      labelNames: InvoiceLabelKeys,
      registers: [this.registry],
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
      labelNames: RewardLabelKeys,
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
    this.successfulPurchases.labels(labels).inc();
  }

  // Record invalid invoice
  public recordInvalidPurchase(reason: InvalidPurchaseReasonVerbose, labels: InvoiceLabels): void {
    // Convert reason string to key
    const idx = (Object.values(InvalidPurchaseReasons) as InvalidPurchaseReasonVerbose[]).findIndex(
      (value) => value === reason,
    );
    this.invalidInvoices.labels({ ...labels, reason: Object.keys(InvalidPurchaseReasons)[idx] }).inc();
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
