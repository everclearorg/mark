import { TransactionReceipt, TransactionRequestBase } from 'viem';

export type SupportedBridge = 'across';

export interface BridgeAdapter {
  type(): SupportedBridge;
  getReceivedAmount(amount: string, asset: string, origin: number, destination: number): Promise<string>;
  send(amount: string, origin: number, destination: number): Promise<TransactionRequestBase>;
  destinationCallback(originTransaction: TransactionReceipt): Promise<TransactionRequestBase | void>;
  readyOnDestination(originTransaction: TransactionReceipt): Promise<boolean>;
}
