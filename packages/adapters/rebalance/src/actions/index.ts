import { ChainConfiguration, PostBridgeActionConfig, PostBridgeActionType } from '@mark/core';
import { Logger } from '@mark/logger';
import { MemoizedTransactionRequest } from '../types';
import { AaveSupplyActionHandler } from './aave-supply';

export { PostBridgeActionHandler } from './types';
export { AaveSupplyActionHandler } from './aave-supply';

export async function buildPostBridgeTransactions(
  sender: string,
  amount: string,
  destinationChainId: number,
  actions: PostBridgeActionConfig[],
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
): Promise<MemoizedTransactionRequest[]> {
  const txs: MemoizedTransactionRequest[] = [];

  for (const action of actions) {
    switch (action.type) {
      case PostBridgeActionType.AaveSupply: {
        const handler = new AaveSupplyActionHandler(chains, logger);
        const actionTxs = await handler.buildTransactions(sender, amount, destinationChainId, action);
        txs.push(...actionTxs);
        break;
      }
      default:
        logger.warn('Unknown post-bridge action type, skipping', {
          type: (action as PostBridgeActionConfig).type,
          destinationChainId,
        });
    }
  }

  return txs;
}
