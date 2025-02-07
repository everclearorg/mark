import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { ProcessInvoicesDependencies } from '../invoice/pollAndProcess';
import { getERC20Contract } from './contracts';
import { encodeFunctionData, erc20Abi } from 'viem';
import { jsonifyMap } from '@mark/logger';

/**
 * Receives a mapping of new intent params designed to purchase a single invoice, keyed
 * on the origin of the created intent.
 *
 * Will return a single intent per origin - asset combo that groups all origin-asset intents into a single
 * created intent. i.e. all USDC intents from optimism will be aggregated into a single USDC on optimism
 * intent.
 */
export const combineIntents = async (
  unbatched: Map<string, NewIntentParams[]>,
  deps: ProcessInvoicesDependencies,
): Promise<Map<string, Map<string, NewIntentParams>>> => {
  const { logger } = deps;
  try {
    // Initialize the result map
    logger.debug('Method started', { method: combineIntents.name, unbatched: jsonifyMap(unbatched) });
    const result = new Map<string, Map<string, NewIntentParams>>();

    // Iterate over the unbatched map
    for (const [origin, intents] of unbatched.entries()) {
      logger.info('Combining intents for domain', { domain: origin, intents: intents.length });
      const assetMap = new Map<string, NewIntentParams>();

      for (const intent of intents) {
        const { inputAsset, amount, destinations, to, callData, maxFee } = intent;

        // If the asset already exists, update the existing intent
        if (assetMap.has(inputAsset.toLowerCase())) {
          const existingIntent = assetMap.get(inputAsset.toLowerCase())!;
          existingIntent.amount = (BigInt(existingIntent.amount) + BigInt(amount)).toString();
        } else {
          assetMap.set(inputAsset.toLowerCase(), { origin, destinations, to, inputAsset, amount, callData, maxFee });
        }
      }
      logger.info('Combined intents for domain + asset', {
        domain: origin,
        assets: [...assetMap.keys()],
        intents: intents.length,
      });

      result.set(origin, assetMap);
    }
    logger.info('Batched intents mapping', { domains: [...result.keys()] });
    return result;
  } catch (err: unknown) {
    const error = err as Error;
    logger.error('Error combining intents', { message: error.message, name: error.name, stack: error.stack });
    throw new Error(`combineIntents failed ${(err as unknown as Error).message || err}`);
  }
};

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
