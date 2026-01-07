declare module '@chainlink/ccip-sdk' {
  // Minimal typings to satisfy the compiler; runtime uses the real package.
  // Use unknown to avoid explicit any; consumers should refine as needed.
  export const SolanaChain: unknown;
  export const networkInfo: unknown;
  export type ExtraArgs = unknown;
}
