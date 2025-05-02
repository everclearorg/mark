import { TransactionReceipt, TransactionRequestBase } from 'viem';
import { BridgeAdapter, SupportedBridge } from './types';

export const MAINNET_ACROSS_URL = 'https://app.across.to/api';
export const TESTNET_ACROSS_URL = 'https://testnet.across.to/api';

export class AcrossBridgeAdapter implements BridgeAdapter {
  constructor(protected url: string) {}

  type(): SupportedBridge {
    return 'across';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getReceivedAmount(amount: string, asset: string, origin: number, destination: number): Promise<string> {
    // TODO: Implement actual logic
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async send(amount: string, origin: number, destination: number): Promise<TransactionRequestBase> {
    // TODO: Implement actual logic
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async destinationCallback(originTransaction: TransactionReceipt): Promise<TransactionRequestBase | void> {
    // TODO: Implement actual logic
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async readyOnDestination(originTransaction: TransactionReceipt): Promise<boolean> {
    // TODO: Implement actual logic
    return false;
  }
}
