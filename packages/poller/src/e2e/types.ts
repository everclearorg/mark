import { TokenRebalanceConfig, SolanaRebalanceConfig } from '@mark/core';

export interface E2EConfig {
  dryRun: boolean;
  runModes: string[]; // e.g., ["methOnly", "tacOnly"] or ["all"]
  sequential: boolean; // run one at a time vs parallel
  overrides?: {
    methRebalance?: Partial<TokenRebalanceConfig>;
    tacRebalance?: Partial<TokenRebalanceConfig>;
    aManUsdeRebalance?: Partial<TokenRebalanceConfig>;
    aMansyrupUsdtRebalance?: Partial<TokenRebalanceConfig>;
    solanaPtusdeRebalance?: Partial<SolanaRebalanceConfig>;
  };
}

export interface E2EResult {
  runMode: string;
  displayName: string;
  status: 'completed' | 'failed' | 'skipped';
  actions: number;
  dryRunIntercepted: number;
  error?: string;
  durationMs: number;
}
