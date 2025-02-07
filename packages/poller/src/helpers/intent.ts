import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { ProcessInvoicesDependencies } from '../invoice/pollAndProcess';
import { getERC20Contract } from './contracts';
import { encodeFunctionData, erc20Abi } from 'viem';
import { jsonifyMap } from '@mark/logger';

/**
 * Uses the api to get the tx data and chainservice to send intents and approve assets if required. Takes in the origin-asset batched intents.
 */
export const sendIntents = async (
  intents: NewIntentParams[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<{ transactionHash: string; chainId: string }[]> => {
  const { everclear, logger, chainService } = deps;
  const results: { transactionHash: string; chainId: string }[] = [];
  logger.info('Attempting to send batched intents', { batch: intents });

  try {
    for (const intent of intents) {
      logger.info('Processing intent for new transaction', { intent });

      // Fetch transaction data for creating a new intent
      const txData = await everclear.createNewIntent(intent);

      logger.debug('Received transaction data for new intent', { txData });

      // Ensure allowance for the transaction
      const tokenContract = await getERC20Contract(config, intent.origin, intent.inputAsset as `0x${string}`);
      const allowance = await tokenContract.read.allowance([config.ownAddress, txData.to]);

      if (BigInt(allowance as string) < BigInt(intent.amount)) {
        logger.info('Allowance insufficient, preparing approval transaction', {
          requiredAmount: intent.amount,
          currentAllowance: allowance,
        });

        const approveCalldata = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [txData.to as `0x${string}`, BigInt(intent.amount)],
        });
        const transaction = {
          to: tokenContract.address,
          data: approveCalldata,
          from: config.ownAddress,
        };

        logger.debug('Sending approval transaction', { transaction, chainId: txData.chainId });
        const approvalTxHash = await chainService.submitAndMonitor(txData.chainId.toString(), transaction);

        logger.info('Approval transaction sent successfully', {
          chain: txData.chainId,
          approvalTxHash,
          allowance,
          asset: tokenContract.address,
          amount: intent.amount,
        });
      } else {
        logger.info('Sufficient allowance already available', {
          allowance,
          chain: txData.chainId,
          asset: tokenContract.address,
          amount: intent.amount,
        });
      }

      // Submit the create intent transaction
      logger.info('Submitting create intent transaction', {
        intent,
        transaction: {
          to: txData.to,
          value: txData.value,
          data: txData.data,
          from: txData.from,
          chain: txData.chainId,
        },
      });

      const intentTxHash = await chainService.submitAndMonitor(txData.chainId.toString(), {
        to: txData.to as string,
        value: txData.value ?? '0',
        data: txData.data,
        from: txData.from ?? config.ownAddress,
      });

      logger.info('Create intent transaction sent successfully', {
        intentTxHash,
        chainId: intent.origin,
      });

      // Add result to the output array
      results.push({ transactionHash: intentTxHash, chainId: intent.origin });
    }
    return results;
  } catch (err) {
    const error = err as Error;
    logger.error('Error encountered while sending intents', {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    throw new Error(`Failed to send intents: ${error.message || err}`);
  }
};
