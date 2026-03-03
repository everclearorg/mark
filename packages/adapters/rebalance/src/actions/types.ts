import { PostBridgeActionConfig } from '@mark/core';
import { MemoizedTransactionRequest } from '../types';

export interface PostBridgeActionHandler {
  buildTransactions(
    sender: string,
    amount: string,
    destinationChainId: number,
    actionConfig: PostBridgeActionConfig,
  ): Promise<MemoizedTransactionRequest[]>;
}
