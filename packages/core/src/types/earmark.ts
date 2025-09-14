export enum EarmarkStatus {
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
  COMPLETED = 'completed', // Fully complete
  EXPIRED = 'expired', // Expired (24 hours)
  CANCELLED = 'cancelled', // Cancelled (e.g., due to earmark cancellation)
}
