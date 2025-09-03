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
  UnpausePurchase = '/unpause/purchase',
  UnpauseRebalance = '/unpause/rebalance',
}
