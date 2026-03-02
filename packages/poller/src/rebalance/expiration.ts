import { ProcessingContext } from '../init';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';
import { jsonifyError } from '@mark/logger';

export async function cleanupExpiredRegularRebalanceOps(context: ProcessingContext): Promise<void> {
  const { database, logger, requestId, config } = context;
  const ttlMinutes = config.regularRebalanceOpTTLMinutes || 1440;

  try {
    await database.withTransaction(async (client) => {
      // Find regular rebalance operations (no earmark) that should expire
      const opsToExpire = await client.query(
        `
        UPDATE rebalance_operations
        SET status = $1, updated_at = NOW()
        WHERE earmark_id IS NULL
          AND status IN ($2, $3)
          AND created_at < NOW() - INTERVAL '${ttlMinutes} minutes'
        RETURNING id, status, created_at, origin_chain_id, destination_chain_id
        `,
        [
          RebalanceOperationStatus.EXPIRED,
          RebalanceOperationStatus.PENDING,
          RebalanceOperationStatus.AWAITING_CALLBACK,
        ],
      );

      if (opsToExpire.rows.length > 0) {
        for (const op of opsToExpire.rows) {
          logger.info('Regular rebalance operation expired due to TTL', {
            requestId,
            operationId: op.id,
            previousStatus: op.status,
            originChain: op.origin_chain_id,
            destinationChain: op.destination_chain_id,
            ageMinutes: Math.floor((Date.now() - new Date(op.created_at).getTime()) / (1000 * 60)),
            ttlMinutes,
          });
        }

        logger.info('Expired regular rebalance operations summary', {
          requestId,
          expiredCount: opsToExpire.rows.length,
          ttlMinutes,
        });
      }
    });
  } catch (error) {
    logger.error('Failed to expire regular rebalance operations', {
      requestId,
      error: jsonifyError(error),
    });
  }
}

export async function cleanupExpiredEarmarks(context: ProcessingContext): Promise<void> {
  const { database, logger, requestId, config } = context;
  const ttlMinutes = config.earmarkTTLMinutes || 1440;

  const initiatingTtlMinutes = 5;

  try {
    await database.withTransaction(async (client) => {
      // Expire stuck INITIATING earmarks with a short TTL.
      // INITIATING is a transient state that should be resolved within seconds.
      // If still INITIATING after 5 minutes, the status update to PENDING/FAILED must have failed.
      const stuckInitiating = await client.query(
        `
        UPDATE earmarks SET status = $1, updated_at = NOW()
        WHERE status = $2
        AND created_at < NOW() - INTERVAL '${initiatingTtlMinutes} minutes'
        RETURNING id, invoice_id, created_at
      `,
        [EarmarkStatus.EXPIRED, EarmarkStatus.INITIATING],
      );

      for (const earmark of stuckInitiating.rows) {
        logger.info('Stuck INITIATING earmark expired', {
          requestId,
          earmarkId: earmark.id,
          invoiceId: earmark.invoice_id,
          reason: 'STUCK_INITIATING',
          ageMinutes: Math.floor((Date.now() - new Date(earmark.created_at).getTime()) / (1000 * 60)),
          ttlMinutes: initiatingTtlMinutes,
        });
      }

      // Find earmarks that should expire due to TTL (not completed/cancelled/expired)
      const earmarksToExpire = await client.query(
        `
        SELECT DISTINCT e.id, e.invoice_id, e.created_at, e.status
        FROM earmarks e
        WHERE e.status NOT IN ($1, $2, $3)
        AND e.created_at < NOW() - INTERVAL '${ttlMinutes} minutes'
      `,
        [EarmarkStatus.COMPLETED, EarmarkStatus.CANCELLED, EarmarkStatus.EXPIRED],
      );

      for (const earmark of earmarksToExpire.rows) {
        // Mark all operations as orphaned (both PENDING and AWAITING_CALLBACK keep their status)
        const orphanedOps = await client.query(
          `
          UPDATE rebalance_operations
          SET is_orphaned = true, updated_at = NOW()
          WHERE earmark_id = $1 AND status IN ($2, $3)
          RETURNING id, status
        `,
          [earmark.id, RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
        );

        // Update earmark status to expired
        await client.query(`UPDATE earmarks SET status = $1, updated_at = NOW() WHERE id = $2`, [
          EarmarkStatus.EXPIRED,
          earmark.id,
        ]);

        logger.info('Earmark expired due to TTL', {
          requestId,
          earmarkId: earmark.id,
          invoiceId: earmark.invoice_id,
          previousStatus: earmark.status,
          reason: 'TTL_EXPIRATION',
          ageMinutes: Math.floor((Date.now() - new Date(earmark.created_at).getTime()) / (1000 * 60)),
          orphanedOperations: orphanedOps.rows.length,
          orphanedPending: orphanedOps.rows.filter((op) => op.status === RebalanceOperationStatus.PENDING).length,
          orphanedAwaitingCallback: orphanedOps.rows.filter(
            (op) => op.status === RebalanceOperationStatus.AWAITING_CALLBACK,
          ).length,
        });
      }

      // Also handle orphaned earmarks (earmarks with no active operations)
      // READY earmarks are not orphaned - they're successfully ready for purchase
      const orphanedEarmarks = await client.query(
        `
        SELECT DISTINCT e.id, e.invoice_id, e.created_at
        FROM earmarks e
        WHERE e.status = $1
        AND NOT EXISTS (
          SELECT 1 FROM rebalance_operations ro
          WHERE ro.earmark_id = e.id
          AND ro.status IN ($2, $3)
        )
        AND e.created_at < NOW() - INTERVAL '${ttlMinutes} minutes'
      `,
        [EarmarkStatus.PENDING, RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
      );

      for (const earmark of orphanedEarmarks.rows) {
        await client.query(`UPDATE earmarks SET status = $1, updated_at = NOW() WHERE id = $2`, [
          EarmarkStatus.EXPIRED,
          earmark.id,
        ]);

        logger.info('Orphaned earmark expired', {
          requestId,
          earmarkId: earmark.id,
          invoiceId: earmark.invoice_id,
          reason: 'ORPHANED_TTL_EXPIRATION',
          ageMinutes: Math.floor((Date.now() - new Date(earmark.created_at).getTime()) / (1000 * 60)),
        });
      }

      if (stuckInitiating.rows.length > 0 || earmarksToExpire.rows.length > 0 || orphanedEarmarks.rows.length > 0) {
        logger.info('Cleanup summary', {
          requestId,
          stuckInitiatingEarmarks: stuckInitiating.rows.length,
          expiredEarmarks: earmarksToExpire.rows.length,
          orphanedEarmarks: orphanedEarmarks.rows.length,
          ttlMinutes,
        });
      }
    });
  } catch (error) {
    logger.error('Failed to cleanup expired earmarks', {
      requestId,
      error: jsonifyError(error),
    });
  }
}
