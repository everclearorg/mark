import { RebalanceAction } from '@mark/core';
import { ProcessingContext } from '../init';

export interface RebalancerRegistration {
  runMode: string;
  displayName: string;
  handler: (context: ProcessingContext) => Promise<RebalanceAction[]>;
  /** Bridge tags owned by this rebalancer (used by the generic callback handler to avoid races) */
  bridgeTags?: string[];
}

const registry: RebalancerRegistration[] = [];

export function registerRebalancer(reg: RebalancerRegistration): void {
  if (registry.some((r) => r.runMode === reg.runMode)) {
    throw new Error(`Duplicate rebalancer registration for runMode: ${reg.runMode}`);
  }
  registry.push(reg);
}

export function getRegisteredRebalancers(): readonly RebalancerRegistration[] {
  return registry;
}

/**
 * Returns the set of bridge tags owned by registered rebalancers.
 * The generic callback handler should skip operations with these tags.
 */
export function getRegisteredBridgeTags(): Set<string> {
  const tags = new Set<string>();
  for (const reg of registry) {
    if (reg.bridgeTags) {
      for (const tag of reg.bridgeTags) {
        tags.add(tag);
      }
    }
  }
  return tags;
}
