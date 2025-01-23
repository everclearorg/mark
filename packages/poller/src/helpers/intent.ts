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
  console.log('combineIntents params: ', unbatched);
  throw new Error('combineIntents - not implemented');
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
