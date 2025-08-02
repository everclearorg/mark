// Database type definitions (will be enhanced with zapatos generated types)

import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

// Basic earmark types (to be replaced with zapatos generated types)
export interface EarmarkRecord {
  id: string;
  invoiceId: string;
  designatedPurchaseChain: number;
  tickerHash: string;
  minAmount: string;
  status: EarmarkStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface RebalanceOperationRecord {
  id: string;
  earmarkId: string;
  originChainId: number;
  destinationChainId: number;
  amountSent: string;
  amountReceived: string;
  slippage: string;
  status: RebalanceOperationStatus;
  recipient?: string;
  originTxHash?: string;
  destinationTxHash?: string;
  callbackTxHash?: string;
  createdAt: Date;
  updatedAt: Date;
}
