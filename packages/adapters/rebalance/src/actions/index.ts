import { ChainConfiguration, PostBridgeActionConfig, PostBridgeActionType } from '@mark/core';
import { Logger } from '@mark/logger';
import { MemoizedTransactionRequest } from '../types';
import { AaveSupplyActionHandler } from './aave-supply';
import { DexSwapActionHandler } from './dex-swap';

export { PostBridgeActionHandler } from './types';
export { AaveSupplyActionHandler } from './aave-supply';
export { DexSwapActionHandler } from './dex-swap';

const DEFAULT_QUOTE_SERVICE_URL = 'https://quotes.api.everclear.org';

export async function buildTransactionsForAction(
  sender: string,
  amount: string,
  destinationChainId: number,
  action: PostBridgeActionConfig,
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
  quoteServiceUrl?: string,
): Promise<MemoizedTransactionRequest[]> {
  switch (action.type) {
    case PostBridgeActionType.DexSwap: {
      const handler = new DexSwapActionHandler(chains, logger, quoteServiceUrl || DEFAULT_QUOTE_SERVICE_URL);
      return handler.buildTransactions(sender, amount, destinationChainId, action);
    }
    case PostBridgeActionType.AaveSupply: {
      const handler = new AaveSupplyActionHandler(chains, logger);
      return handler.buildTransactions(sender, amount, destinationChainId, action);
    }
    default:
      logger.warn('Unknown post-bridge action type, skipping', {
        type: (action as PostBridgeActionConfig).type,
        destinationChainId,
      });
      return [];
  }
}

