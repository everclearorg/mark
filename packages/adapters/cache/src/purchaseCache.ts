import { NewIntentParams, Invoice } from '@mark/core';
import Redis from 'ioredis';

export interface PurchaseAction {
  target: Invoice;
  purchase: NewIntentParams;
  transactionHash: string;
}

export class PurchaseCache {
  private readonly prefix = 'purchases';

  constructor(private readonly store: Redis) {}

  /**
   * Stores purchase actions for given targets
   * @param actions - Array of purchase actions to store
   * @returns Number of stored items
   */
  public async addPurchases(actions: PurchaseAction[]): Promise<number> {
    const key = `${this.prefix}:data`;
    let stored = 0;

    for (const action of actions) {
      const targetId = action.target.intent_id;
      const result = await this.store.hset(key, targetId, JSON.stringify(action));
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
    const key = `${this.prefix}:data`;
    const results = await this.store.hmget(key, ...targetIds);

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
    const key = `${this.prefix}:data`;
    return await this.store.hdel(key, ...targetIds);
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
    const key = `${this.prefix}:data`;
    const all = await this.store.hgetall(key);

    return Object.values(all).map((result) => JSON.parse(result) as PurchaseAction);
  }

  /**
   * Checks if a purchase action exists for a target
   * @param targetId - Target ID to check
   * @returns boolean indicating if purchase exists
   */
  public async hasPurchase(targetId: string): Promise<boolean> {
    const key = `${this.prefix}:data`;
    return (await this.store.hexists(key, targetId)) === 1;
  }
}
