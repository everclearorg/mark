import { TransactionReceipt, TransactionRequestBase } from 'viem';
import { SupportedBridge, RebalanceRoute } from '@mark/core';
export interface BridgeAdapter {
  type(): SupportedBridge;
  getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string>;
  send(sender: string, recipient: string, amount: string, route: RebalanceRoute): Promise<TransactionRequestBase>;
  destinationCallback(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<TransactionRequestBase | void>;
  readyOnDestination(amount: string, route: RebalanceRoute, originTransaction: TransactionReceipt): Promise<boolean>;
}
