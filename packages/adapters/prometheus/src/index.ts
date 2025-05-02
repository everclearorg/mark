import { InvalidPurchaseReasons, InvalidPurchaseReasonConcise, InvalidPurchaseReasonVerbose } from '@mark/core';
import { Gauge, Counter, Histogram, Registry, Pushgateway, PrometheusContentType } from 'prom-client';
import { formatUnits } from 'viem';
import { jsonifyError, Logger } from '@mark/logger';

const InvoiceLabelKeys = ['origin', 'ticker', 'id', 'destination', 'reason', 'isSplit', 'splitCount'] as const;

export type InvoiceLabels = Omit<
  Record<(typeof InvoiceLabelKeys)[number], string>,
  'destination' | 'reason' | 'isSplit' | 'splitCount'
> & {
  destination?: string;
  reason?: InvalidPurchaseReasonConcise;
  isSplit?: string;
  splitCount?: string;
};

const InvoiceDurationLabelKeys = ['origin', 'destination', 'ticker'] as const;
export type InvoiceDurationLabels = Record<(typeof InvoiceDurationLabelKeys)[number], string>;

export enum TransactionReason {
  Approval = 'Approval',
  CreateIntent = 'CreateIntent',
}

const RewardLabelKeys = ['chain', 'asset', 'id', 'ticker'] as const;
export type RewardLabels = Record<(typeof RewardLabelKeys)[number], string>;

export class PrometheusAdapter {
  private registry: Registry;
  private pushGateway: Pushgateway<PrometheusContentType>;

  // Balance metrics
  private chainBalance: Gauge<string>;
  private gasBalance: Gauge<string>;
  private gasSpent: Counter<string>;

  // Invoice metrics
  private possibleInvoices: Counter<string>;
  private successfulPurchases: Counter<string>;
  private invalidInvoices: Counter<string>;

  // Timing metrics
  private clearanceDuration: Histogram<string>;
  private purchaseDuration: Histogram<string>;

  // Rewards metrics
  private rewards: Gauge<string>;

  constructor(
    private logger: Logger,
    private jobName: string,
    pushGatewayUri: string,
  ) {
    this.registry = new Registry();
    this.pushGateway = new Pushgateway(pushGatewayUri, undefined, this.registry);

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

    // Initialize gas spend tracker
    this.gasSpent = new Counter({
      name: 'mark_gas_spend',
      help: 'Marks gas spend across different chains',
      labelNames: ['chain', 'reason'],
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
    this.clearanceDuration = new Histogram({
      name: 'mark_clearance_duration_seconds',
      help: 'Time taken to clear targets from cache',
      labelNames: InvoiceDurationLabelKeys,
      buckets: [1, 5, 10, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    this.purchaseDuration = new Histogram({
      name: 'mark_invoice_purchase_duration_seconds',
      help: 'Time taken to purchase invoices from hub enqueued timestamps',
      labelNames: InvoiceDurationLabelKeys,
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
  public async updateChainBalance(chain: string, token: string, balance: bigint): Promise<void> {
    this.chainBalance.labels({ chain, token }).set(+formatUnits(balance, 18));
    await this.pushMetrics();
  }

  public async updateGasBalance(chain: string, balance: bigint): Promise<void> {
    this.gasBalance.labels({ chain }).set(+formatUnits(balance, 18));
    await this.pushMetrics();
  }

  public async updateGasSpent(chain: string, reason: TransactionReason, gas: bigint): Promise<void> {
    this.gasSpent.labels({ chain, reason }).inc(+formatUnits(gas, 18));
    await this.pushMetrics();
  }

  // Record possible invoice
  public async recordPossibleInvoice(labels: InvoiceLabels): Promise<void> {
    this.possibleInvoices.labels(labels).inc();
    await this.pushMetrics();
  }

  // Record successful invoice fill
  public async recordSuccessfulPurchase(labels: InvoiceLabels): Promise<void> {
    this.successfulPurchases.labels(labels).inc();
    await this.pushMetrics();
  }

  // Record invalid invoice
  public async recordInvalidPurchase(reason: InvalidPurchaseReasonVerbose, labels: InvoiceLabels): Promise<void> {
    // Convert reason string to key
    const idx = (Object.values(InvalidPurchaseReasons) as InvalidPurchaseReasonVerbose[]).findIndex(
      (value) => value === reason,
    );
    this.invalidInvoices.labels({ ...labels, reason: Object.keys(InvalidPurchaseReasons)[idx] }).inc();
    await this.pushMetrics();
  }

  // Record duration from invoice to go from seen -> purchased
  public async recordInvoicePurchaseDuration(labels: InvoiceDurationLabels, durationSeconds: number): Promise<void> {
    this.purchaseDuration.observe(labels, durationSeconds);
    await this.pushMetrics();
  }

  // Record time from invoice to go from seen -> removed from cache
  public async recordPurchaseClearanceDuration(labels: InvoiceDurationLabels, durationSeconds: number): Promise<void> {
    this.clearanceDuration.observe(labels, durationSeconds);
    await this.pushMetrics();
  }

  // Update rewards
  public async updateRewards(labels: RewardLabels, amount: number): Promise<void> {
    this.rewards.labels(labels).set(amount);
    await this.pushMetrics();
  }

  // Get metrics
  public async getMetrics(): Promise<string> {
    return await this.registry.metrics();
  }

  // Push metrics to Pushgateway
  private async pushMetrics(): Promise<void> {
    try {
      await this.pushGateway.pushAdd({ jobName: this.jobName });
    } catch (error) {
      this.logger.error('Failed to push metrics to Pushgateway:', { error: jsonifyError(error) });
    }
  }
}
