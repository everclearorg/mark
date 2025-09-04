import { ProcessingContext } from '../init';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';
import { jsonifyError } from '@mark/logger';

export async function cleanupExpiredEarmarks(context: ProcessingContext): Promise<void> {
  const { database, logger, requestId, config } = context;
  const ttlMinutes = config.earmarkTTLMinutes || 1440;

  try {
    await database.withTransaction(async (client) => {
      const expiredOps = await client.query(
        `
        UPDATE rebalance_operations
        SET status = $1, updated_at = NOW()
        WHERE status = ANY($2)
        AND created_at < NOW() - INTERVAL '${ttlMinutes} minutes'
        RETURNING earmark_id
      `,
        [
          RebalanceOperationStatus.EXPIRED,
          [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
        ],
      );

      const orphanedEarmarks = await client.query(
        `
        SELECT DISTINCT e.id, e.invoice_id, e.created_at
        FROM earmarks e
        WHERE e.status IN ($1, $2)
        AND (
          NOT EXISTS (
            SELECT 1 FROM rebalance_operations ro
            WHERE ro.earmark_id = e.id
            AND ro.status IN ($3, $4)
          )
          OR e.created_at < NOW() - INTERVAL '${ttlMinutes} minutes'
        )
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

        logger.info('Earmark expired due to TTL', {
          requestId,
          earmarkId: earmark.id,
          invoiceId: earmark.invoice_id,
          reason: 'TTL_EXPIRATION',
          ageMinutes: Math.floor((Date.now() - new Date(earmark.created_at).getTime()) / (1000 * 60)),
        });
      }

      if (expiredOps.rows.length > 0 || orphanedEarmarks.rows.length > 0) {
        logger.info('Cleanup summary', {
          requestId,
          expiredOperations: expiredOps.rows.length,
          expiredEarmarks: orphanedEarmarks.rows.length,
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
