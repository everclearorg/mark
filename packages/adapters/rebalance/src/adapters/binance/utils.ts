import { BinanceAssetMapping } from './types';
import { BINANCE_ASSET_MAPPINGS } from './constants';
import { AssetConfiguration, ChainConfiguration, RebalanceRoute } from '@mark/core';
import { BinanceClient } from './client';
import { formatUnits } from 'viem';

/**
 * Find asset mapping for a given route
 */
export function getAssetMapping(route: RebalanceRoute): BinanceAssetMapping | undefined {
  return BINANCE_ASSET_MAPPINGS.find(
    (mapping) => mapping.chainId === route.origin && mapping.onChainAddress.toLowerCase() === route.asset.toLowerCase(),
  );
}

/**
 * Find destination asset mapping for cross-chain transfers
 */
export function getDestinationAssetMapping(route: RebalanceRoute): BinanceAssetMapping | undefined {
  // First find the origin mapping to get the Binance symbol
  const originMapping = getAssetMapping(route);
  if (!originMapping) {
    return undefined;
  }

  // Find destination mapping with same Binance symbol
  return BINANCE_ASSET_MAPPINGS.find(
    (mapping) => mapping.chainId === route.destination && mapping.binanceSymbol === originMapping.binanceSymbol,
  );
}

/**
 * Get asset configuration from chains config
 */
export function getAsset(
  asset: string,
  chain: number,
  chains: Record<string, ChainConfiguration>,
): AssetConfiguration | undefined {
  const chainConfig = chains[chain.toString()];
  if (!chainConfig) {
    return undefined;
  }

  return chainConfig.assets.find((a) => a.address.toLowerCase() === asset.toLowerCase());
}

/**
 * Find matching destination asset in chains config
 */
export function findMatchingDestinationAsset(
  asset: string,
  origin: number,
  destination: number,
  chains: Record<string, ChainConfiguration>,
): AssetConfiguration | undefined {
  const originAsset = getAsset(asset, origin, chains);
  if (!originAsset) {
    return undefined;
  }

  const destinationChain = chains[destination.toString()];
  if (!destinationChain) {
    return undefined;
  }

  // Find asset with same symbol on destination chain
  return destinationChain.assets.find((a) => a.symbol === originAsset.symbol);
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

/**
 * Convert Wei amount to human readable format (for logging/debugging)
 */
export function formatAmount(amount: string, decimals: number): string {
  const amountBN = BigInt(amount);
  const divisor = BigInt(10 ** decimals);
  const wholePart = amountBN / divisor;
  const fractionalPart = amountBN % divisor;

  if (fractionalPart === 0n) {
    return wholePart.toString();
  }

  const fractionalString = fractionalPart.toString().padStart(decimals, '0');
  return `${wholePart}.${fractionalString.replace(/0+$/, '')}`;
}

/**
 * Validate that an asset mapping exists and is properly configured
 */
export function validateAssetMapping(
  mapping: BinanceAssetMapping | undefined,
  context: string,
): asserts mapping is BinanceAssetMapping {
  if (!mapping) {
    throw new Error(`No Binance asset mapping found for ${context}`);
  }

  if (!mapping.binanceSymbol || !mapping.network) {
    throw new Error(`Invalid Binance asset mapping for ${context}: missing symbol or network`);
  }

  if (!mapping.withdrawalFee || !mapping.minWithdrawalAmount) {
    throw new Error(`Invalid Binance asset mapping for ${context}: missing fee configuration`);
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
 * Must be deterministic - same inputs always produce same output
 */
export function generateWithdrawOrderId(route: RebalanceRoute, txHash: string): string {
  // Create a deterministic ID based on route and transaction
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

/**
 * Check if a withdrawal is considered stale (taking too long)
 */
export function isWithdrawalStale(applyTime: string, maxHours = 24): boolean {
  const applyDate = new Date(applyTime);
  const now = new Date();
  const diffHours = (now.getTime() - applyDate.getTime()) / (1000 * 60 * 60);
  return diffHours > maxHours;
}
