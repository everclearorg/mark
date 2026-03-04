export enum EarmarkStatus {
  INITIATING = 'initiating',
  PENDING = 'pending',
  READY = 'ready',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
  EXPIRED = 'expired',
}

export enum RebalanceOperationStatus {
  PENDING = 'pending', // Transaction submitted on-chain
  AWAITING_CALLBACK = 'awaiting_callback', // Waiting for callback execution
  AWAITING_POST_BRIDGE = 'awaiting_post_bridge', // Bridge done, executing post-bridge actions (e.g. Aave supply)
  COMPLETED = 'completed', // Fully complete
  FAILED = 'failed', // Operation failed (e.g., bridge failure)
  EXPIRED = 'expired', // Expired (24 hours)
  CANCELLED = 'cancelled', // Cancelled (e.g., due to earmark cancellation)
}
