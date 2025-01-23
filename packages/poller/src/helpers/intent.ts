import { ChainService } from '@mark/chainservice';
import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { ProcessInvoicesDependencies } from '../invoice/pollAndProcess';
import { getERC20Contract } from './contracts';
import { encodeFunctionData } from 'viem';

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
  try {
    // Initialize the result map
    const { logger } = deps;
    logger.info('Into the combine intent method');
    const result = new Map<string, Map<string, NewIntentParams>>();

    // Iterate over the unbatched map
    for (const [origin, intents] of unbatched.entries()) {
      const assetMap = new Map<string, NewIntentParams>();

      for (const intent of intents) {
        const { inputAsset, amount, destinations, to, callData, maxFee } = intent;

        // If the asset already exists, update the existing intent
        if (assetMap.has(inputAsset)) {
          const existingIntent = assetMap.get(inputAsset)!;
          existingIntent.amount = (BigInt(existingIntent.amount) + BigInt(amount)).toString();
        } else {
          assetMap.set(inputAsset, { origin, destinations, to, inputAsset, amount, callData, maxFee });
        }
      }

      result.set(origin, assetMap);
    }
    logger.info('Batched intent mapping', { batch: result });
    return result;
  } catch (err) {
    throw new Error(`combine Intents failed ${(err as unknown as Error).message || err}`);
  }
};

/**
 * Uses the api to get the tx data and chainservice to send intents and approve assets if required. Takes in the origin-asset batched intents.
 */
export const sendIntents = async (
  batch: Map<string, Map<string, NewIntentParams>>,
  chainservice: ChainService,
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<{ transactionHash: string; chainId: string }[]> => {
  const { everclear, logger } = deps;
  const results: { transactionHash: string; chainId: string }[] = [];

  try {
    for (const originMap of batch.values()) {
      for (const intent of originMap.values()) {
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
            abi: [
              {
                inputs: [
                  { name: 'spender', type: 'address' },
                  { name: 'amount', type: 'uint256' },
                ],
                name: 'approve',
                outputs: [{ name: '', type: 'bool' }],
                stateMutability: 'nonpayable',
                type: 'function',
              },
            ],
            functionName: 'approve',
            args: [txData.to as `0x${string}`, BigInt(intent.amount)],
          });

          const approvalTxHash = await chainservice.submitAndMonitor(txData.chainId.toString(), {
            to: txData.to as string,
            data: approveCalldata,
            from: config.ownAddress,
          });

          logger.info('Approval transaction sent successfully', { approvalTxHash });
        } else {
          logger.info('Sufficient allowance already available', { allowance });
        }

        // Submit the create intent transaction
        logger.info('Submitting create intent transaction', {
          to: txData.to,
          value: txData.value,
          data: txData.data,
          from: txData.from,
        });

        const intentTxHash = await chainservice.submitAndMonitor(txData.chainId.toString(), {
          to: txData.to as string,
          value: txData.value,
          data: txData.data,
          from: txData.from as string,
        });

        logger.info('Create intent transaction sent successfully', {
          intentTxHash,
          chainId: intent.origin,
        });

        // Add result to the output array
        results.push({ transactionHash: intentTxHash, chainId: intent.origin });
      }
    }
    return results;
  } catch (err) {
    logger.error('Error encountered while sending intents', { error: err });
    throw new Error(`Failed to send intents: ${(err as unknown as Error).message || err}`);
  }
};
