import { BinanceAssetMapping } from './types';
import { RebalanceRoute, ChainConfiguration } from '@mark/core';
import { BinanceClient } from './client';
import { DynamicAssetConfig } from './dynamic-config';
import { formatUnits } from 'viem';

export async function getAssetMapping(
  client: BinanceClient,
  route: RebalanceRoute,
  chains: Record<string, ChainConfiguration>,
): Promise<BinanceAssetMapping> {
  const dynamicConfig = new DynamicAssetConfig(client, chains);
  return dynamicConfig.getAssetMapping(route.origin, route.asset);
}

export async function getDestinationAssetMapping(
  client: BinanceClient,
  route: RebalanceRoute,
  chains: Record<string, ChainConfiguration>,
): Promise<BinanceAssetMapping> {
  const dynamicConfig = new DynamicAssetConfig(client, chains);

  // First get the origin asset mapping to determine the external symbol
  const originMapping = await dynamicConfig.getAssetMapping(route.origin, route.asset);

  // Map the external symbol - for WETH we use 'WETH' externally
  const externalSymbol = originMapping.binanceSymbol === 'ETH' ? 'WETH' : originMapping.binanceSymbol;

  // Then get the destination mapping using the external symbol
  return dynamicConfig.getAssetMapping(route.destination, externalSymbol);
}

/**
 * Calculate net amount after withdrawal fees
 */
export function calculateNetAmount(amount: string, withdrawalFee: string): string {
  const amountBN = BigInt(amount);
  const feeBN = BigInt(withdrawalFee);

  if (amountBN <= feeBN) {
    throw new Error('Amount is too small to cover withdrawal fees');
  }

  return (amountBN - feeBN).toString();
}

export async function validateAssetMapping(
  client: BinanceClient,
  route: RebalanceRoute,
  context: string,
  chains: Record<string, ChainConfiguration>,
): Promise<BinanceAssetMapping> {
  try {
    const mapping = await getAssetMapping(client, route, chains);

    if (!mapping.binanceSymbol || !mapping.network) {
      throw new Error(`Invalid Binance asset mapping for ${context}: missing symbol or network`);
    }

    if (!mapping.withdrawalFee || !mapping.minWithdrawalAmount) {
      throw new Error(`Invalid Binance asset mapping for ${context}: missing fee configuration`);
    }

    return mapping;
  } catch (error) {
    throw new Error(`No Binance asset mapping found for ${context}: ${(error as Error).message}`);
  }
}

/**
 * Check if amount meets minimum withdrawal requirements
 */
export function meetsMinimumWithdrawal(amount: string, mapping: BinanceAssetMapping): boolean {
  const amountBN = BigInt(amount);
  const minBN = BigInt(mapping.minWithdrawalAmount);
  const feeBN = BigInt(mapping.withdrawalFee);

  // Amount must be greater than minimum + fee
  return amountBN >= minBN + feeBN;
}

/**
 * Generate a unique withdrawal order ID for tracking
 */
export function generateWithdrawOrderId(route: RebalanceRoute, txHash: string): string {
  const routeString = `${route.origin}-${route.destination}-${route.asset.slice(2, 8)}`;
  const shortHash = txHash.slice(2, 10); // Take first 8 chars after 0x
  return `mark-${shortHash}-${routeString}`;
}

/**
 * Convert asset amount to USD value
 */
export async function convertAmountToUSD(
  amount: string,
  binanceSymbol: string,
  decimals: number,
  client: BinanceClient,
): Promise<number> {
  const amountInAsset = parseFloat(formatUnits(BigInt(amount), decimals));

  // For stablecoins, assume 1:1 for simplicity
  if (binanceSymbol === 'USDT' || binanceSymbol === 'USDC') {
    return amountInAsset;
  }

  // Get price for the asset in USDT
  const ticker = await client.getPrice(`${binanceSymbol}USDT`);
  const price = parseFloat(ticker.price);

  // Calculate USD value
  return amountInAsset * price;
}

/**
 * Check if withdrawal amount exceeds remaining quota
 */
export async function checkWithdrawQuota(
  amount: string,
  binanceSymbol: string,
  decimals: number,
  client: BinanceClient,
): Promise<{ allowed: boolean; remainingQuotaUSD: number; amountUSD: number }> {
  // Get current quota (global, not per coin)
  const quota = await client.getWithdrawQuota();
  const totalQuota = parseFloat(quota.wdQuota);
  const usedQuota = parseFloat(quota.usedWdQuota);
  const remainingQuotaUSD = totalQuota - usedQuota;

  // Convert amount to USD
  const amountUSD = await convertAmountToUSD(amount, binanceSymbol, decimals, client);

  return {
    allowed: amountUSD <= remainingQuotaUSD,
    remainingQuotaUSD,
    amountUSD,
  };
}

/**
 * Parse Binance timestamp to Date
 */
export function parseBinanceTimestamp(timestamp: number | string): Date {
  const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;
  return new Date(ts);
}
