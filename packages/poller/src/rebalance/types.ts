/**
 * Shared types for rebalancer modules.
 */

/**
 * Sender configuration for rebalancing transactions.
 * Specifies which address should sign and send from origin chain.
 */
export interface SenderConfig {
  address: string; // Sender's chain address
  signerUrl?: string; // Web3signer URL for this sender (uses default if not specified)
  label: 'market-maker' | 'fill-service'; // For logging
}

/**
 * Shared state for tracking funds committed in a single rebalance run.
 * Prevents over-committing when multiple wallets need rebalancing simultaneously.
 */
export interface RebalanceRunState {
  committedAmount: bigint;
}
