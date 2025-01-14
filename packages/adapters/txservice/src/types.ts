import { providers, BigNumber } from 'ethers';
import { RequestContext } from '@connext/nxtp-utils';

export interface WriteTransaction {
  domain: number;
  to: string;
  data: string;
  from?: string;
  value?: BigNumber;
  gasLimit?: BigNumber;
  gasPrice?: BigNumber;
}

export interface TxServiceSubmittedEvent {
  responses: providers.TransactionResponse[];
}

export interface TxServiceMinedEvent {
  receipt: providers.TransactionReceipt;
}

export interface TxServiceConfirmedEvent {
  receipt: providers.TransactionReceipt;
}

export interface TxServiceFailedEvent {
  error: Error;
  receipt?: providers.TransactionReceipt;
}

export interface ITxService {
  sendTx(tx: WriteTransaction, requestContext: RequestContext): Promise<providers.TransactionReceipt>;
  getTransactionReceipt(hash: string): Promise<providers.TransactionReceipt>;
  getGasEstimate(tx: WriteTransaction): Promise<BigNumber>;
  initialize(): Promise<void>;
  attach<T extends TxServiceEvent>(
    event: T,
    callback: (data: TxServiceEventPayloads[T]) => void,
    filter?: (data: TxServiceEventPayloads[T]) => boolean,
    timeout?: number,
  ): void;
  detach<T extends TxServiceEvent>(event?: T): void;
}

export const TxServiceEvents = {
  TransactionSubmitted: 'TransactionSubmitted',
  TransactionMined: 'TransactionMined',
  TransactionConfirmed: 'TransactionConfirmed',
  TransactionFailed: 'TransactionFailed',
} as const;

export type TxServiceEvent = (typeof TxServiceEvents)[keyof typeof TxServiceEvents];

export interface TxServiceEventPayloads {
  [TxServiceEvents.TransactionSubmitted]: TxServiceSubmittedEvent;
  [TxServiceEvents.TransactionMined]: TxServiceMinedEvent;
  [TxServiceEvents.TransactionConfirmed]: TxServiceConfirmedEvent;
  [TxServiceEvents.TransactionFailed]: TxServiceFailedEvent;
}
