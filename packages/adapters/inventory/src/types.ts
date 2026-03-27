/**
 * Operation types supported by the unified inventory service.
 */
export type OperationType =
  | 'FAST_PATH_FILL'
  | 'REBALANCE_LEG2'
  | 'REBALANCE_ONDEMAND'
  | 'MARK_PURCHASE'
  | 'REBALANCE_THRESHOLD';

/**
 * Reservation lifecycle statuses.
 */
export type ReservationStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED'
  | 'PREEMPTED';

/**
 * A reservation returned by the inventory service.
 */
export interface Reservation {
  id: string;
  chainId: string;
  asset: string;
  amount: string;
  operationType: OperationType;
  operationId: string;
  priority: number;
  status: ReservationStatus;
  ttlSeconds: number;
  expiresAt: number;
  requestedBy: string;
  parentReservationId?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, string>;
}

/**
 * Parameters for creating a new reservation.
 */
export interface CreateReservationParams {
  chainId: string;
  asset: string;
  amount: string;
  operationType: OperationType;
  operationId: string;
  requestedBy: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}

/**
 * A nonce assignment returned by the inventory service.
 */
export interface NonceAssignment {
  nonce: number;
  nonceId: string;
  chainId: string;
  wallet: string;
  assignedAt: number;
}

/**
 * Inventory balance response from GET /inventory/balance/{chainId}/{asset}.
 * This is the full balance view including on-chain balance, reservations, and pending state.
 */
export interface InventoryBalance {
  chainId: string;
  asset: string;
  totalBalance: string;
  availableBalance: string;
  reservedByType: Partial<Record<OperationType, string>>;
  pendingInbound: string;
  pendingIntents: string;
  reservationCount: number;
  timestamp: number;
}

/**
 * Pending inbound entry for cross-chain rebalance tracking.
 */
export interface PendingInbound {
  id: string;
  chainId: string;
  asset: string;
  amount: string;
  sourceChain: string;
  operationType: string; // API accepts any string (not restricted to OperationType enum)
  operationId: string;
  status: 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
  expectedArrivalAt?: number;
  txHash?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, string>;
}

/**
 * Parameters for registering a pending inbound.
 */
export interface RegisterInboundParams {
  chainId: string;
  asset: string;
  amount: string;
  sourceChain: string;
  operationType: string; // API accepts any string (not restricted to OperationType enum)
  operationId: string;
  expectedArrivalSeconds?: number;
  txHash?: string;
  metadata?: Record<string, string>;
}
