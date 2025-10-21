import { PurchaseCache } from '@mark/cache';
import { LogLevel, RedisConfig, DatabaseConfig } from '@mark/core';
import { Logger } from '@mark/logger';
import { APIGatewayEvent } from 'aws-lambda';
import * as database from '@mark/database';

export interface AdminConfig {
  logLevel: LogLevel;
  adminToken: string;
  redis: RedisConfig;
  database: DatabaseConfig;
}

export interface AdminAdapter {
  database: typeof database;
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
  ClearPurchase = '/clear/purchase',
  ClearRebalance = '/clear/rebalance',
  PausePurchase = '/pause/purchase',
  PauseRebalance = '/pause/rebalance',
  PauseOnDemandRebalance = '/pause/ondemand-rebalance',
  UnpausePurchase = '/unpause/purchase',
  UnpauseRebalance = '/unpause/rebalance',
  UnpauseOnDemandRebalance = '/unpause/ondemand-rebalance',
  GetEarmarks = '/rebalance/earmarks',
  GetRebalanceOperations = '/rebalance/operations',
  GetEarmarkDetails = '/rebalance/earmark',
  CancelEarmark = '/rebalance/cancel',
  CancelRebalanceOperation = '/rebalance/operation/cancel',
}

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface EarmarkFilter {
  status?: string;
  chainId?: number;
  invoiceId?: string;
}

export interface OperationFilter {
  status?: string;
  chainId?: number;
  earmarkId?: string;
}
