import { ProcessingContext } from '../init';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';
import { jsonifyError } from '@mark/logger';

export async function cleanupExpiredEarmarks(context: ProcessingContext): Promise<void> {
  const { database, logger, requestId, config } = context;
  const ttlMinutes = config.earmarkTTLMinutes || 1440;

  try {
    await database.withTransaction(async (client) => {
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
      const orphanedEarmarks = await client.query(
        `
        SELECT DISTINCT e.id, e.invoice_id, e.created_at
        FROM earmarks e
        WHERE e.status IN ($1, $2)
        AND NOT EXISTS (
          SELECT 1 FROM rebalance_operations ro
          WHERE ro.earmark_id = e.id
          AND ro.status IN ($3, $4)
        )
        AND e.created_at < NOW() - INTERVAL '${ttlMinutes} minutes'
      `,
        [
          EarmarkStatus.PENDING,
          EarmarkStatus.READY,
          RebalanceOperationStatus.PENDING,
          RebalanceOperationStatus.AWAITING_CALLBACK,
        ],
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

      if (earmarksToExpire.rows.length > 0 || orphanedEarmarks.rows.length > 0) {
        logger.info('Cleanup summary', {
          requestId,
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
