import { TransactionReceipt, TransactionRequestBase } from 'viem';
import { SupportedBridge, RebalanceRoute } from '@mark/core';

export enum RebalanceTransactionMemo {
  Rebalance = 'Rebalance',
  Approval = 'Approval',
  Wrap = 'Wrap',
  Unwrap = 'Unwrap',
  Mint = 'Mint',
}

export interface MemoizedTransactionRequest {
  transaction: TransactionRequestBase & {
    funcSig?: string; // Function signature for Tron support
  };
  memo: RebalanceTransactionMemo;
  effectiveAmount?: string; // The effective amount being bridged (after any caps or adjustments)
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
  executeSwap?(sender: string, recipient: string, amount: string, route: RebalanceRoute): Promise<SwapExecutionResult>;
}

export interface SwapExecutionResult {
  orderUid: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  executedSellAmount: string;
  executedBuyAmount: string;
}
