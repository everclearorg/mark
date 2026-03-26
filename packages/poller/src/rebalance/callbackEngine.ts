/**
 * Generic callback engine for processing in-flight rebalance operations.
 *
 * Captures the shared lifecycle across all rebalancers:
 *   fetch in-flight ops → iterate → check timeout → delegate to processOperation
 *
 * Each rebalancer provides a descriptor with the parts that differ
 * (bridge tag, statuses to query, per-operation processing logic).
 */
import { RebalanceOperationStatus } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import type { CamelCasedProperties } from 'type-fest';
import type { rebalance_operations, TransactionEntry } from '@mark/database';
import { ProcessingContext } from '../init';
import { isOperationTimedOut, DEFAULT_OPERATION_TTL_MINUTES } from './helpers';

/** The operation type returned by the database query, with transactions attached. */
export type RebalanceOperation = CamelCasedProperties<rebalance_operations> & {
  transactions?: Record<string, TransactionEntry>;
};

export interface CallbackDescriptor {
  /** Human-readable name for logging (e.g., 'mETH', 'aManUSDe') */
  name: string;

  /** Bridge tag(s) to filter operations (e.g., 'stargate-amanusde', ['mantle', 'across-mantle']) */
  bridge: string | string[];

  /** Operation statuses to query for in-flight operations */
  statuses: RebalanceOperationStatus[];

  /** Optional additional filter: chain ID */
  chainId?: number;

  /** TTL override in minutes (defaults to config.regularRebalanceOpTTLMinutes or 24h) */
  ttlMinutes?: number;

  /** Status to set when an operation times out (default: CANCELLED) */
  timeoutStatus?: RebalanceOperationStatus;

  /**
   * Called when an operation times out, after the status has been updated.
   * Use for side effects like cancelling linked earmarks.
   */
  onTimeout?: (operation: RebalanceOperation, context: ProcessingContext) => Promise<void>;

  /**
   * Process a single in-flight operation. This is where the bridge-specific
   * state machine logic lives (e.g., PENDING → AWAITING_CALLBACK → COMPLETED).
   *
   * The operation's `status` field may be mutated to reflect in-memory transitions
   * within a single poll cycle (e.g., PENDING→AWAITING_CALLBACK fall-through).
   */
  processOperation: (operation: RebalanceOperation, context: ProcessingContext) => Promise<void>;
}

/**
 * Run the callback loop for in-flight rebalance operations.
 *
 * Fetches operations matching the descriptor's filters, checks timeouts,
 * and delegates per-operation processing to the descriptor.
 */
export async function runCallbackLoop(context: ProcessingContext, descriptor: CallbackDescriptor): Promise<void> {
  const { logger, requestId, config, database: db } = context;
  const name = descriptor.name;

  const operationTtlMinutes =
    descriptor.ttlMinutes ?? config.regularRebalanceOpTTLMinutes ?? DEFAULT_OPERATION_TTL_MINUTES;
  const timeoutStatus = descriptor.timeoutStatus ?? RebalanceOperationStatus.CANCELLED;

  logger.info(`Executing callbacks for ${name} rebalance`, { requestId });

  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: descriptor.statuses,
    bridge: descriptor.bridge,
    ...(descriptor.chainId !== undefined ? { chainId: descriptor.chainId } : {}),
  });

  logger.debug(`Found ${operations.length} ${name} rebalance operations`, {
    count: operations.length,
    requestId,
    operationTtlMinutes,
  });

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
      status: operation.status,
    };

    // Check for operation timeout
    if (operation.createdAt && isOperationTimedOut(operation.createdAt, operationTtlMinutes)) {
      const operationAgeMinutes = Math.round((Date.now() - operation.createdAt.getTime()) / (60 * 1000));
      logger.warn(`${name} operation timed out, marking as ${timeoutStatus}`, {
        ...logContext,
        createdAt: operation.createdAt.toISOString(),
        operationAgeMinutes,
        ttlMinutes: operationTtlMinutes,
      });

      try {
        await db.updateRebalanceOperation(operation.id, { status: timeoutStatus });
        if (descriptor.onTimeout) {
          await descriptor.onTimeout(operation, context);
        }
      } catch (error) {
        logger.error(`Failed to handle timed-out ${name} operation`, {
          ...logContext,
          error: jsonifyError(error),
        });
      }
      continue;
    }

    // Delegate to bridge-specific processing
    try {
      await descriptor.processOperation(operation, context);
    } catch (error) {
      logger.error(`Failed to process ${name} callback for operation`, {
        ...logContext,
        error: jsonifyError(error),
      });
    }
  }
}
