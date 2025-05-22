import { PurchaseCache, RebalanceCache } from '@mark/cache';
import { LogLevel, RedisConfig } from '@mark/core';
import { Logger } from '@mark/logger';
import { APIGatewayEvent } from 'aws-lambda';

export interface AdminConfig {
  logLevel: LogLevel;
  redis: RedisConfig;
  adminToken: string;
}

export interface AdminAdapter {
  rebalanceCache: RebalanceCache;
  purchaseCache: PurchaseCache;
}

export interface AdminContext extends AdminAdapter {
  logger: Logger;
  config: AdminConfig;
  event: APIGatewayEvent;
  requestId: string;
  startTime: number;
}

export enum HttpPaths {
  PausePurchase = '/pause/purchase',
  PauseRebalance = '/pause/rebalance',
  UnpausePurchase = '/unpause/purchase',
  UnpauseRebalance = '/unpause/rebalance',
  GetRebalanceActions = '/rebalance/actions',
  GetRebalanceStatus = '/rebalance/status',
}
