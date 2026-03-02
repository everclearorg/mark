import { NewIntentParams, Invoice, TransactionSubmissionType } from '@mark/core';
import Redis from 'ioredis';

export interface PurchaseAction {
  target: Invoice;
  purchase: { params: NewIntentParams; intentId: string };
  transactionHash: string;
  transactionType: TransactionSubmissionType;
  // Timestamp (seconds) of when this record was cached.
  // Backwards compatibility will use the default of Date.now()
  cachedAt: number;
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
    const purchases: PurchaseAction[] = [];

    for (const result of results) {
      if (result === null) continue;
      try {
        const parsed = JSON.parse(result) as PurchaseAction;
        purchases.push({
          ...parsed,
          transactionType: parsed.transactionType || TransactionSubmissionType.Onchain, // backwards compatability
        });
      } catch (parseError) {
        console.error('Failed to parse purchase data, skipping corrupted entry:', parseError);
      }
    }

    return purchases;
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
    const keysToDelete: string[] = [];
    if (await this.store.exists(this.dataKey)) {
      keysToDelete.push(this.dataKey);
    }
    if (await this.store.exists(this.pauseKey)) {
      keysToDelete.push(this.pauseKey);
    }

    if (keysToDelete.length > 0) {
      await this.store.del(...keysToDelete);
    }
    // DEL returns the number of keys deleted. No need to check 'OK'.
    // If DEL fails, it will propagate the error.
  }

  /**
   * Gets all stored purchase actions
   * @returns Array of all PurchaseActions in the cache
   */
  public async getAllPurchases(): Promise<PurchaseAction[]> {
    const all = await this.store.hgetall(this.dataKey);
    const purchases: PurchaseAction[] = [];

    for (const result of Object.values(all)) {
      try {
        const parsed = JSON.parse(result) as PurchaseAction;
        purchases.push({
          ...parsed,
          transactionType: parsed.transactionType || TransactionSubmissionType.Onchain, // backwards compatability
        });
      } catch (parseError) {
        console.error('Failed to parse purchase data in getAllPurchases, skipping corrupted entry:', parseError);
      }
    }

    return purchases;
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

  /** Disconnect from Redis to prevent file descriptor leaks */
  public async disconnect(): Promise<void> {
    try {
      await this.store.disconnect();
      console.log('PurchaseCache: Redis connection closed successfully');
    } catch (error) {
      console.warn('PurchaseCache: Error closing Redis connection:', error);
      throw error;
    }
  }
}
