import { RebalanceRoute } from '@mark/core';

/**
 * Generate a unique withdrawal order ID for tracking
 */
export function generateWithdrawOrderId(route: RebalanceRoute, txHash: string): string {
  const routeString = `${route.origin}-${route.destination}-${route.asset.slice(2, 8)}`;
  const shortHash = txHash.slice(2, 10); // Take first 8 chars after 0x
  return `mark-${shortHash}-${routeString}`;
}
