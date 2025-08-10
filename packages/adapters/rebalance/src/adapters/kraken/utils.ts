import { formatUnits, zeroAddress } from 'viem';
import { ChainConfiguration, RebalanceRoute } from '@mark/core';
import { KrakenClient } from './client';
import { KrakenAssetMapping } from './types';
import { DynamicAssetConfig } from './dynamic-config';
import { Logger } from '@mark/logger';

export function generateWithdrawOrderId(route: RebalanceRoute, transactionHash: string): string {
  return `mark-${route.origin}-${route.destination}-${transactionHash.slice(2, 10)}`;
}

export async function getDestinationAssetMapping(
  dynamicConfig: DynamicAssetConfig,
  route: RebalanceRoute,
): Promise<KrakenAssetMapping> {
  // First get the origin asset mapping to determine the external symbol
  const originMapping = await dynamicConfig.getAssetMapping(route.origin, route.asset);

  // Map the external symbol - for WETH we use 'WETH' externally
  const externalSymbol = originMapping.krakenSymbol === 'ETH' ? 'WETH' : originMapping.krakenSymbol;

  // Then get the destination mapping using the external symbol
  return dynamicConfig.getAssetMapping(route.destination, externalSymbol);
}

export async function validateAssetMapping(
  dynamicConfig: DynamicAssetConfig,
  route: RebalanceRoute,
  context: string,
): Promise<KrakenAssetMapping> {
  try {
    const mapping = await dynamicConfig.getAssetMapping(route.origin, route.asset);

    if (!mapping.krakenSymbol || !mapping.method) {
      throw new Error(`Invalid Kraken asset mapping for ${context}: missing symbol or method`);
    }

    if (!mapping.withdrawalFee || !mapping.minWithdrawalAmount) {
      throw new Error(`Invalid Kraken asset mapping for ${context}: missing fee configuration`);
    }

    return mapping;
  } catch (error) {
    throw new Error(`No Kraken asset mapping found for ${context}: ${(error as Error).message}`);
  }
}

export function findAssetByAddress(
  address: string,
  chainId: number,
  chains: Record<string, ChainConfiguration>,
): { tickerHash: string; address: string } | undefined {
  const chainConfig = chains[chainId.toString()];
  if (!chainConfig) return undefined;

  for (const assetConfig of chainConfig.assets) {
    if (assetConfig.address.toLowerCase() === address.toLowerCase()) {
      return { tickerHash: assetConfig.tickerHash, address: assetConfig.address };
    }
    if (address === zeroAddress && assetConfig.address === zeroAddress) {
      return { tickerHash: assetConfig.tickerHash, address: assetConfig.address };
    }
  }
  return undefined;
}

export function calculateNetAmount(amount: string, withdrawalFee: string): string {
  const originalAmount = BigInt(amount);
  const feeAmount = BigInt(withdrawalFee);

  if (originalAmount <= feeAmount) {
    throw new Error('Amount is less than or equal to withdrawal fee');
  }

  return (originalAmount - feeAmount).toString();
}

export function meetsMinimumWithdrawal(originAmount: string, mapping: KrakenAssetMapping): boolean {
  const amountBigInt = BigInt(originAmount);
  const minimumBigInt = BigInt(mapping.minWithdrawalAmount);
  return amountBigInt >= minimumBigInt;
}

export async function checkWithdrawQuota(
  amount: string,
  asset: string,
  decimals: number,
  _client: KrakenClient,
  logger: Logger,
): Promise<{ allowed: boolean; amountUSD: number; message?: string }> {
  try {
    const amountInUnits = parseFloat(formatUnits(BigInt(amount), decimals));

    // For now, implement a simple quota check
    // In a real implementation, you'd call Kraken's API to get current prices and limits
    const estimatedUSD = amountInUnits * getAssetUSDPrice(asset);

    // Kraken typically has daily withdrawal limits based on verification level
    // This is a simplified check - in practice you'd query their API
    const dailyLimit = 50000; // $50k USD daily limit for verified accounts

    logger.debug('Withdrawal quota check', {
      asset,
      amountInUnits,
      estimatedUSD,
      dailyLimit,
    });

    return {
      allowed: estimatedUSD <= dailyLimit,
      amountUSD: estimatedUSD,
      message: estimatedUSD > dailyLimit ? `Amount $${estimatedUSD} exceeds daily limit of $${dailyLimit}` : undefined,
    };
  } catch (error) {
    logger.warn('Failed to check withdrawal quota, allowing by default', { error });
    return { allowed: true, amountUSD: 0 };
  }
}

function getAssetUSDPrice(asset: string): number {
  // Simplified price mapping - in reality you'd call Kraken's ticker API
  const prices: Record<string, number> = {
    ETH: 3000,
    USDC: 1,
    USDT: 1,
    MATIC: 0.8,
    BNB: 400,
  };
  return prices[asset] || 1;
}
