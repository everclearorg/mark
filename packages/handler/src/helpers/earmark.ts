import { ProcessingContext } from '@mark/poller/src/init';
import { EarmarkStatus, Invoice, RebalanceOperationStatus } from '@mark/core';
import * as onDemand from '@mark/poller/src/rebalance/onDemand';
import { jsonifyError } from '@mark/logger';

/**
 * Process pending earmark for an invoice:
 * - Gets the pending earmark for this invoice (if any)
 * - Handles minAmount changes
 * - Checks if all operations are complete and updates status to READY
 */
export async function processPendingEarmark(
  invoice: Invoice,
  minAmounts: Record<string, string>,
  processingContext: ProcessingContext,
): Promise<void> {
  const { logger, requestId, database } = processingContext;

  try {
    // Get a pending earmark for this specific invoice
    const pendingEarmarks = await database.getEarmarks({
      status: EarmarkStatus.PENDING,
      invoiceId: invoice.intent_id,
    });

    if (pendingEarmarks.length === 0) {
      return;
    }

    // Database constraint ensures at most one PENDING earmark per invoice
    const earmark = pendingEarmarks[0];
    logger.debug('Processing pending earmark for invoice', {
      requestId,
      invoiceId: invoice.intent_id,
      earmarkId: earmark.id,
    });

    try {
      // Get the current minAmount for the designated purchase chain
      let currentMinAmount = minAmounts[earmark.designatedPurchaseChain.toString()];
      if (!currentMinAmount) {
        logger.warn('No minAmounts for earmarked invoice', {
          requestId,
          invoiceId: invoice.intent_id,
        });
        return;
      }

      const currentRequiredAmount = BigInt(currentMinAmount);
      const earmarkedAmount = BigInt(earmark.minAmount);

      if (currentRequiredAmount && earmarkedAmount) {
        if (currentRequiredAmount > earmarkedAmount) {
          // MinAmount increased - see if additional rebalancing is needed
          const handled = await onDemand.handleMinAmountIncrease(earmark, invoice, currentMinAmount, processingContext);
          if (!handled) {
            await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);
          }
          return;
        } else if (currentRequiredAmount < earmarkedAmount) {
          // MinAmount decreased - don't need to do anything
          logger.info('MinAmount decreased, proceeding with original plan', {
            requestId,
            invoiceId: invoice.intent_id,
            oldMinAmount: earmark.minAmount,
            newMinAmount: currentMinAmount,
          });
        }
      }

      // Check if all operations are complete and update if so
      const operations = await database.getRebalanceOperationsByEarmark(earmark.id);
      const allComplete =
        operations.length > 0 && operations.every((op) => op.status === RebalanceOperationStatus.COMPLETED);

      if (allComplete) {
        logger.info('All rebalance operations complete for earmark', {
          requestId,
          invoiceId: invoice.intent_id,
          earmarkId: earmark.id,
        });
        await database.updateEarmarkStatus(earmark.id, EarmarkStatus.READY);
      }
    } catch (error) {
      logger.error('Error processing earmarked invoice', {
        requestId,
        invoiceId: invoice.intent_id,
        earmarkId: earmark.id,
        error: jsonifyError(error),
      });
    }
  } catch (error) {
    logger.error('Failed to process pending earmarks due to database error', {
      requestId,
      invoiceId: invoice.intent_id,
      error: jsonifyError(error),
    });
  }
}
