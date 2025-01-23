import { ChainService } from '@mark/chainservice';
import { NewIntentParams } from '@mark/core';
import { TransactionReceipt } from 'viem';

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
): Promise<Map<string, Map<string, NewIntentParams>>> => {
  try {
    // Initialize the result map
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

    return result;
  } catch (err) {
    throw new Error('combine Intents failed');
  }
};

/**
 * Uses the chainservice to send intents and approve assets if required. Takes in the origin-asset batched intents.
 */
export const sendIntents = async (
  batch: Map<string, Map<string, NewIntentParams>>,
  chainservice: ChainService,
): Promise<(TransactionReceipt & { chainId: number })[]> => {
  console.log('sendIntents params: ', batch, chainservice);
  throw new Error('sendIntents - not implemented');
};
