import { SupportedBridge } from './config';

// TODO - maybe delete?
export interface RebalanceAction {
  bridge: SupportedBridge;
  amount: string;
  origin: number;
  destination: number;
  asset: string;
  transaction: string;
  recipient: string;
}
