export interface NewIntentParams {
  origin: string;
  destinations: string[];
  to: string;
  inputAsset: string;
  amount: string | number;
  callData: string;
  maxFee: string | number;
}
