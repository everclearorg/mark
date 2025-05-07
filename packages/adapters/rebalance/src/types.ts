import { TransactionReceipt, TransactionRequestBase } from 'viem';

export type SupportedBridge = 'across';

export interface RebalanceRoute {
  asset: string;
  origin: number;
  destination: number;
}

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
