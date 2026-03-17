import { RebalanceAction } from '@mark/core';
import { ProcessingContext } from '../init';

export interface RebalancerRegistration {
  runMode: string;
  displayName: string;
  handler: (context: ProcessingContext) => Promise<RebalanceAction[]>;
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
