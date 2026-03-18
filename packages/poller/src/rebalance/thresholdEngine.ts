/**
 * Generic threshold-based rebalancing engine.
 *
 * Captures the shared orchestration pattern used across all threshold rebalancers:
 *   check in-flight → get recipient balance → threshold compare → compute shortfall →
 *   get sender balance → apply min/max caps → execute bridge → track committed amount
 *
 * Each rebalancer provides a descriptor with callbacks for the parts that differ
 * (balance fetching, bridge execution, decimal conversion, etc.).
 */
import { RebalanceAction } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import { ProcessingContext } from '../init';
import { RebalanceRunState } from './types';

export interface ThresholdRebalanceDescriptor {
  /** Human-readable name for logging (e.g., 'aManUSDe', 'mETH', 'Solana ptUSDe') */
  name: string;

  /** Whether this threshold rebalancer is enabled */
  isEnabled: () => boolean;

  /** Check for in-flight operations that would prevent a new rebalance. Return true to skip. */
  hasInFlightOperations: (context: ProcessingContext) => Promise<boolean>;

  /** Get recipient's balance on destination chain (in normalized 18-decimal units) */
  getRecipientBalance: (context: ProcessingContext) => Promise<bigint>;

  /** Threshold and target (in same units as recipient balance) */
  getThresholds: () => { threshold: bigint; target: bigint };

  /**
   * Convert a shortfall (in recipient-balance units) to the amount the sender needs to bridge.
   * For same-decimal tokens, this is identity. For cross-decimal or pricing-dependent flows
   * (e.g., Pendle USDC→ptUSDe), this performs the conversion.
   */
  convertShortfallToBridgeAmount: (shortfall: bigint, context: ProcessingContext) => Promise<bigint>;

  /** Get sender's available balance on origin chain (in bridge-amount units) */
  getSenderBalance: (context: ProcessingContext) => Promise<bigint>;

  /** Min/max caps on bridge amount (in bridge-amount units) */
  getAmountCaps: () => { min: bigint; max?: bigint };

  /** Execute the bridge for the given amount. Returns the resulting actions. */
  executeBridge: (context: ProcessingContext, amount: bigint) => Promise<RebalanceAction[]>;
}

/**
 * Run the threshold rebalance evaluation using the provided descriptor.
 *
 * Returns the actions taken (empty if no rebalance was needed or possible).
 */
export async function runThresholdRebalance(
  context: ProcessingContext,
  descriptor: ThresholdRebalanceDescriptor,
  runState: RebalanceRunState,
): Promise<RebalanceAction[]> {
  const { logger, requestId } = context;
  const name = descriptor.name;

  // 1. Check if enabled
  if (!descriptor.isEnabled()) {
    logger.debug(`${name} threshold rebalancing disabled`, { requestId });
    return [];
  }

  // 2. Check for in-flight operations
  try {
    const hasInFlight = await descriptor.hasInFlightOperations(context);
    if (hasInFlight) {
      logger.info(`${name} has in-flight operations, skipping threshold rebalance`, { requestId });
      return [];
    }
  } catch (error) {
    logger.error(`${name} failed to check in-flight operations`, { requestId, error: jsonifyError(error) });
    return [];
  }

  // 3. Get recipient balance
  let recipientBalance: bigint;
  try {
    recipientBalance = await descriptor.getRecipientBalance(context);
  } catch (error) {
    logger.warn(`${name} failed to get recipient balance`, { requestId, error: jsonifyError(error) });
    return [];
  }

  // 4. Threshold comparison
  const { threshold, target } = descriptor.getThresholds();

  if (target < threshold) {
    logger.error(
      `${name} misconfiguration: target (${target.toString()}) is less than threshold (${threshold.toString()})`,
      {
        requestId,
        threshold: threshold.toString(),
        target: target.toString(),
      },
    );
    return [];
  }

  logger.info(`${name} threshold check`, {
    requestId,
    recipientBalance: recipientBalance.toString(),
    threshold: threshold.toString(),
    target: target.toString(),
    committedAmount: runState.committedAmount.toString(),
  });

  if (recipientBalance >= threshold) {
    logger.info(`${name} recipient balance above threshold, no rebalance needed`, {
      requestId,
      recipientBalance: recipientBalance.toString(),
      threshold: threshold.toString(),
    });
    return [];
  }

  // 5. Compute shortfall and convert to bridge amount
  // Clamp to 0n to guard against edge cases where recipientBalance > target but < threshold
  const shortfall = recipientBalance < target ? target - recipientBalance : 0n;
  if (shortfall === 0n) {
    logger.info(`${name} recipient balance above target, no shortfall`, { requestId });
    return [];
  }
  let bridgeAmount: bigint;
  try {
    bridgeAmount = await descriptor.convertShortfallToBridgeAmount(shortfall, context);
  } catch (error) {
    logger.warn(`${name} failed to convert shortfall to bridge amount`, { requestId, error: jsonifyError(error) });
    return [];
  }

  // 6. Get sender balance
  let senderBalance: bigint;
  try {
    senderBalance = await descriptor.getSenderBalance(context);
  } catch (error) {
    logger.warn(`${name} failed to get sender balance`, { requestId, error: jsonifyError(error) });
    return [];
  }

  // 7. Calculate amount: min(bridgeAmount, senderBalance)
  let amount = senderBalance < bridgeAmount ? senderBalance : bridgeAmount;

  if (senderBalance < bridgeAmount) {
    logger.warn(`${name} sender has insufficient balance to cover full shortfall`, {
      requestId,
      senderBalance: senderBalance.toString(),
      bridgeAmount: bridgeAmount.toString(),
      note: 'Will bridge available balance if above minimum',
    });
  }

  // 8. Apply caps
  const { min, max } = descriptor.getAmountCaps();
  if (max && max > 0n && amount > max) {
    amount = max;
  }
  if (amount < min) {
    logger.warn(`${name} available amount below minimum rebalance threshold, skipping`, {
      requestId,
      availableAmount: amount.toString(),
      minRebalance: min.toString(),
    });
    return [];
  }

  logger.info(`${name} threshold rebalance triggered`, {
    requestId,
    shortfall: shortfall.toString(),
    bridgeAmount: bridgeAmount.toString(),
    senderBalance: senderBalance.toString(),
    amount: amount.toString(),
  });

  // 9. Execute bridge
  let actions: RebalanceAction[];
  try {
    actions = await descriptor.executeBridge(context, amount);
  } catch (error) {
    logger.error(`${name} failed to execute bridge`, {
      requestId,
      amount: amount.toString(),
      error: jsonifyError(error),
    });
    return [];
  }

  // 10. Track committed amount
  if (actions.length > 0) {
    runState.committedAmount += amount;
    logger.debug(`${name} updated committed amount`, {
      requestId,
      bridgedAmount: amount.toString(),
      totalCommitted: runState.committedAmount.toString(),
    });
  }

  return actions;
}
