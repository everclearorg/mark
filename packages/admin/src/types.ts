import { PurchaseCache } from '@mark/cache';
import { LogLevel, RedisConfig, DatabaseConfig, MarkConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import { APIGatewayEvent } from 'aws-lambda';
import * as database from '@mark/database';
import { ChainService } from '@mark/chainservice';

export interface AdminConfig {
  logLevel: LogLevel;
  adminToken: string;
  redis: RedisConfig;
  database: DatabaseConfig;
  whitelistedRecipients?: string[];
  markConfig: MarkConfiguration;
}

export interface AdminAdapter {
  database: typeof database;
  purchaseCache: PurchaseCache;
  chainService: ChainService;
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
  PauseOnDemandRebalance = '/pause/ondemand-rebalance',
  UnpausePurchase = '/unpause/purchase',
  UnpauseRebalance = '/unpause/rebalance',
  UnpauseOnDemandRebalance = '/unpause/ondemand-rebalance',
  GetEarmarks = '/rebalance/earmarks',
  GetRebalanceOperations = '/rebalance/operations',
  GetEarmarkDetails = '/rebalance/earmark',
  GetRebalanceOperationDetails = '/rebalance/operation',
  CancelEarmark = '/rebalance/cancel',
  CancelRebalanceOperation = '/rebalance/operation/cancel',
  TriggerSend = '/trigger/send',
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
  invoiceId?: string;
}
