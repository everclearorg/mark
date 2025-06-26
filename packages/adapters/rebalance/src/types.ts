import { TransactionReceipt, TransactionRequestBase } from 'viem';
import { SupportedBridge, RebalanceRoute } from '@mark/core';

export enum RebalanceTransactionMemo {
  Rebalance = 'Rebalance',
  Approval = 'Approval',
  Wrap = 'Wrap',
  Unwrap = 'Unwrap',
}
export interface MemoizedTransactionRequest {
  transaction: TransactionRequestBase;
  memo: RebalanceTransactionMemo;
}
export interface BridgeAdapter {
  type(): SupportedBridge;
  getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string>;
  send(sender: string, recipient: string, amount: string, route: RebalanceRoute): Promise<MemoizedTransactionRequest[]>;
  destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void>;
  readyOnDestination(amount: string, route: RebalanceRoute, originTransaction: TransactionReceipt): Promise<boolean>;
}
