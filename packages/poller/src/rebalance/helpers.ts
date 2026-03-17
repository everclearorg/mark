/**
 * Shared helpers for rebalancer modules.
 */

import { SupportedBridge } from '@mark/core';

// Default operation timeout: 24 hours (in minutes)
export const DEFAULT_OPERATION_TTL_MINUTES = 24 * 60;

/**
 * Check if an operation has exceeded its TTL (time-to-live).
 * Operations stuck in PENDING or AWAITING_CALLBACK for too long should be marked as failed.
 *
 * @param createdAt - Operation creation timestamp
 * @param ttlMinutes - TTL in minutes (default: 24 hours)
 * @returns true if operation has timed out
 */
export function isOperationTimedOut(createdAt: Date, ttlMinutes: number = DEFAULT_OPERATION_TTL_MINUTES): boolean {
  const maxAgeMs = ttlMinutes * 60 * 1000;
  const operationAgeMs = Date.now() - createdAt.getTime();
  return operationAgeMs > maxAgeMs;
}

/**
 * Map from bridge tag (stored in DB) to the SupportedBridge adapter type.
 * Replaces fragile `bridge.split('-')[0]` parsing scattered across rebalancers.
 */
const BRIDGE_TAG_TO_TYPE: Record<string, SupportedBridge> = {
  // Aave token flows
  'stargate-amanusde': SupportedBridge.Stargate,
  'stargate-amansyrupusdt': SupportedBridge.Stargate,
  // TAC USDT flow
  'stargate-tac': SupportedBridge.Stargate,
  // mETH flows
  [SupportedBridge.Mantle]: SupportedBridge.Mantle,
  [`${SupportedBridge.Across}-mantle`]: SupportedBridge.Across,
  // Solana CCIP flow
  'ccip-solana-mainnet': SupportedBridge.CCIP,
};

/**
 * Resolve the SupportedBridge adapter type from a bridge tag stored in the database.
 * First checks the explicit mapping, then falls back to extracting the prefix before
 * the first '-' (e.g., 'stargate-foo' → 'stargate') for forward compatibility
 * with new bridge tags that follow the convention.
 *
 * Returns undefined only if neither approach yields a valid SupportedBridge.
 */
export function getBridgeTypeFromTag(bridgeTag: string): SupportedBridge | undefined {
  const explicit = BRIDGE_TAG_TO_TYPE[bridgeTag];
  if (explicit) return explicit;

  // Fallback: extract prefix before first '-' and check if it's a valid SupportedBridge
  const prefix = bridgeTag.split('-')[0];
  if (Object.values(SupportedBridge).includes(prefix as SupportedBridge)) {
    return prefix as SupportedBridge;
  }

  return undefined;
}

/**
 * Register a custom bridge tag → adapter type mapping at runtime.
 * Useful for new rebalancers that introduce new bridge tags.
 */
export function registerBridgeTag(tag: string, bridgeType: SupportedBridge): void {
  BRIDGE_TAG_TO_TYPE[tag] = bridgeType;
}
