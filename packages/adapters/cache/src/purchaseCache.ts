import { NewIntentParams, Invoice } from '@mark/core';
import Redis from 'ioredis';

export interface PurchaseAction {
  target: Invoice;
  purchase: { params: NewIntentParams; intentId: string };
  transactionHash: string;
}

export class PurchaseCache {
  private readonly prefix = 'purchases';
  private readonly dataKey = `${this.prefix}:data`;
  private readonly pauseKey = `${this.prefix}:paused`;
  private readonly store: Redis;

  constructor(host: string, port: number) {
    this.store = new Redis({
      host,
      port,
      connectTimeout: 17000,
      maxRetriesPerRequest: 4,
      retryStrategy: (times) => Math.min(times * 30, 1000),
    });
  }

  /**
   * Stores purchase actions for given targets
   * @param actions - Array of purchase actions to store
   * @returns Number of stored items
   */
  public async addPurchases(actions: PurchaseAction[]): Promise<number> {
    let stored = 0;

    for (const action of actions) {
      const targetId = action.target.intent_id;
      const result = await this.store.hset(this.dataKey, targetId, JSON.stringify(action));
      stored += result;
    }

    return stored;
  }

  /**
   * Retrieves purchase actions for given target IDs
   * @param targetIds - Array of target IDs to fetch
   * @returns Array of PurchaseActions found for the given targets
   */
  public async getPurchases(targetIds: string[]): Promise<PurchaseAction[]> {
    const results = await this.store.hmget(this.dataKey, ...targetIds);

    return results
      .filter((result): result is string => result !== null)
      .map((result) => JSON.parse(result) as PurchaseAction);
  }

  /**
   * Removes purchase actions for given target IDs
   * @param targetIds - Array of target IDs to remove
   * @returns Number of removed items
   */
  public async removePurchases(targetIds: string[]): Promise<number> {
    if (targetIds.length === 0) return 0;
    return await this.store.hdel(this.dataKey, ...targetIds);
  }

  /**
   * Flushes the entire cache.
   *
   * @returns void
   * @throws Error if flush fails
   */
  public async clear(): Promise<void> {
    const ret = await this.store.flushall();
    if (ret !== 'OK') {
      throw new Error(`Failed to clear store: ${JSON.stringify(ret)}`);
    }
    return;
  }

  /**
   * Gets all stored purchase actions
   * @returns Array of all PurchaseActions in the cache
   */
  public async getAllPurchases(): Promise<PurchaseAction[]> {
    const all = await this.store.hgetall(this.dataKey);

    return Object.values(all).map((result) => JSON.parse(result) as PurchaseAction);
  }

  /**
   * Checks if a purchase action exists for a target
   * @param targetId - Target ID to check
   * @returns boolean indicating if purchase exists
   */
  public async hasPurchase(targetId: string): Promise<boolean> {
    return (await this.store.hexists(this.dataKey, targetId)) === 1;
  }

  /** Pause / unpause the entire purchasing flow. */
  public async setPause(paused: boolean): Promise<void> {
    await this.store.set(this.pauseKey, paused ? '1' : '0');
  }

  /** Helper for callers that need to know the status. */
  public async isPaused(): Promise<boolean> {
    return (await this.store.get(this.pauseKey)) === '1';
  }
}
