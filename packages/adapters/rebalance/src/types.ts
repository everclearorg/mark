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
}

// Swap operation types for CEX adapters
export interface SwapQuote {
  quoteId: string;
  fromAsset: string; // e.g., 'USDT'
  toAsset: string; // e.g., 'USDC'
  fromAmount: string; // Amount in native units
  toAmount: string; // Amount in native units
  rate: string; // Conversion rate
  validUntil: number; // Unix timestamp
  estimatedFee?: string;
}

export interface SwapExecution {
  orderId: string;
  quoteId: string;
  status: 'processing' | 'success' | 'failed';
  executedAmount?: string;
  executedRate?: string;
}

export interface SwapStatus {
  orderId: string;
  status: 'processing' | 'success' | 'failed';
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  executedAt?: number;
}

export interface SwapExchangeInfo {
  minAmount: string; // Minimum swap amount in native units
  maxAmount: string; // Maximum swap amount in native units
}

// Extension interface for swap-capable adapters (CEX adapters)
export interface SwapCapableBridgeAdapter extends BridgeAdapter {
  supportsSwap(fromAsset: string, toAsset: string): Promise<boolean>;
  getSwapQuote(fromAsset: string, toAsset: string, fromAmount: string): Promise<SwapQuote>;
  executeSwap(quote: SwapQuote): Promise<SwapExecution>;
  getSwapStatus(orderId: string): Promise<SwapStatus>;
  getSwapExchangeInfo(fromAsset: string, toAsset: string): Promise<SwapExchangeInfo>;
}
