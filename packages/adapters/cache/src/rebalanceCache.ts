import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { SupportedBridge } from '@mark/core';

export interface RouteRebalancingConfig {
  destination: number;
  origin: number;
  asset: string;
  maximum: string;
  slippage: number;
  preferences: string[];
}
export interface RebalancingConfig {
  routes: RouteRebalancingConfig[];
}

export interface RebalanceAction {
  bridge: SupportedBridge;
  amount: string;
  origin: number;
  destination: number;
  asset: string;
  transaction: string;
}

export class RebalanceCache {
  private readonly prefix = 'rebalances';
  private readonly dataKey = `${this.prefix}:data`;
  private readonly pauseKey = `${this.prefix}:paused`;
  private readonly store: Redis;

  constructor(host: string, port: number) {
    this.store = new Redis({
      host,
      port,
      connectTimeout: 17_000,
      maxRetriesPerRequest: 4,
      retryStrategy: (times) => Math.min(times * 30, 1_000),
    });
  }

  /** Compose the per‑route set name. */
  private routeKey(dest: number, orig: number, asset: string) {
    return `${this.prefix}:route:${dest}-${orig}-${asset.toLowerCase()}`;
  }

  /** Persist a batch of actions. Returns the number of *new* rows created. */
  public async addRebalances(actions: RebalanceAction[]): Promise<number> {
    if (actions.length === 0) return 0;

    const pipeline = this.store.pipeline();
    for (const action of actions) {
      // 1. deterministic but unique id
      const id = `${action.destination}-${action.origin}-${action.asset}-${randomUUID()}`;
      // 2. value in master hash
      pipeline.hset(this.dataKey, id, JSON.stringify(action));
      // 3. index in the per‑route set
      pipeline.sadd(this.routeKey(action.destination, action.origin, action.asset), id);
    }
    const results = await pipeline.exec();
    // HSET replies are [null, 0|1]. Count the "1"s from HSET operations only.
    if (!results) return 0;

    let newRowsCreated = 0;
    for (let i = 0; i < results.length; i += 2) {
      // Iterate over HSET results
      const hsetResult = results[i]; // This is the result for an HSET command
      // hsetResult is a tuple [Error | null, 0 | 1]
      if (hsetResult && hsetResult[1] === 1) {
        newRowsCreated++;
      }
    }
    return newRowsCreated;
  }

  /** Fetch every cached action that matches any route in `config`. */
  public async getRebalances(config: RebalancingConfig): Promise<(RebalanceAction & { id: string })[]> {
    if (config.routes.length === 0) return [];

    // 1. collect all ids across the selected routes
    const pipeline = this.store.pipeline();
    for (const r of config.routes) {
      pipeline.smembers(this.routeKey(r.destination, r.origin, r.asset));
    }
    const idGroups = ((await pipeline.exec()) ?? []).map(([, ids]) => ids as string[]);
    const ids = [...new Set(idGroups.flat())];
    if (ids.length === 0) return [];

    // 2. pull the actual objects in one HMGET
    const rows = await this.store.hmget(this.dataKey, ...ids);

    // Map over the retrieved rows, parse them, and importantly, add the 'id' back to each object.
    // The 'ids' array and 'rows' array are parallel, so ids[i] corresponds to rows[i].
    const actionsWithIds: (RebalanceAction & { id: string })[] = [];
    ids.forEach((id, index) => {
      const rawData = rows[index];
      if (rawData !== null) {
        // Ensure there's data for this ID
        const action = JSON.parse(rawData) as RebalanceAction;
        actionsWithIds.push({ ...action, id }); // Combine the parsed action with its id
      }
    });

    return actionsWithIds;
  }

  /** Delete the given action‑IDs from cache and index. */
  public async removeRebalances(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    // We need to know each action's tuple to clean its set entry.
    const actionsRaw = await this.store.hmget(this.dataKey, ...ids);
    const pipeline = this.store.pipeline();

    ids.forEach((id, i) => {
      const raw = actionsRaw[i];
      if (!raw) return; // already gone

      const { destination, origin, asset } = JSON.parse(raw) as RebalanceAction;
      pipeline.srem(this.routeKey(destination, origin, asset), id);
      pipeline.hdel(this.dataKey, id);
    });

    const results = await pipeline.exec();
    if (!results) return 0;

    let removedCount = 0;
    // Each ID processed results in two operations in the pipeline: srem then hdel.
    // We iterate through the results, looking at the hdel result (every second item).
    for (let i = 0; i < results.length; i += 2) {
      // The hdel result is at index i + 1, if it exists
      if (i + 1 < results.length) {
        const hdelResult = results[i + 1]; // This is the result for an HDEL command
        // hdelResult is a tuple [Error | null, 0 | 1]
        if (hdelResult && hdelResult[1] === 1) {
          removedCount++;
        }
      }
    }
    return removedCount;
  }

  /** Nuke everything. */
  public async clear(): Promise<void> {
    const routeKeysPattern = `${this.prefix}:route:*`;
    const dataKeyToDelete = this.dataKey;
    const pauseKeyToDelete = this.pauseKey;

    const routeKeys = await this.store.keys(routeKeysPattern);

    const keysToDelete: string[] = [];
    if (await this.store.exists(dataKeyToDelete)) {
      keysToDelete.push(dataKeyToDelete);
    }
    if (await this.store.exists(pauseKeyToDelete)) {
      keysToDelete.push(pauseKeyToDelete);
    }

    keysToDelete.push(...routeKeys);

    if (keysToDelete.length > 0) {
      await this.store.del(...keysToDelete);
    }
    // Unlike FLUSHALL, DEL returns the number of keys deleted.
    // We don't need to check for an 'OK' status. If DEL fails, it will throw an error.
  }

  /** Fast existence check. */
  public async hasRebalance(id: string): Promise<boolean> {
    return (await this.store.hexists(this.dataKey, id)) === 1;
  }

  /** Pause / unpause the entire rebalancing flow. */
  public async setPause(paused: boolean): Promise<void> {
    await this.store.set(this.pauseKey, paused ? '1' : '0');
  }

  /** Helper for callers that need to know the status. */
  public async isPaused(): Promise<boolean> {
    return (await this.store.get(this.pauseKey)) === '1';
  }

  /** Disconnect from Redis to prevent file descriptor leaks */
  public async disconnect(): Promise<void> {
    await this.store.disconnect();
  }
}
