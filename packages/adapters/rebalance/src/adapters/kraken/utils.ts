import { RebalanceRoute } from '@mark/core';
import { KrakenAssetMapping } from './types';
import { DynamicAssetConfig } from './dynamic-config';

export async function getDestinationAssetMapping(
  dynamicConfig: DynamicAssetConfig,
  route: RebalanceRoute,
  _originMapping?: KrakenAssetMapping,
): Promise<KrakenAssetMapping> {
  // First get the origin asset mapping to determine the external symbol
  const originMapping = _originMapping ?? (await dynamicConfig.getAssetMapping(route.origin, route.asset));

  // Map the external symbol - for WETH we use 'WETH' externally
  const externalSymbol = originMapping.krakenSymbol === 'ETH' ? 'WETH' : originMapping.krakenSymbol;

  // Then get the destination mapping using the external symbol
  return dynamicConfig.getAssetMapping(route.destination, externalSymbol);
}

export async function getValidAssetMapping(
  dynamicConfig: DynamicAssetConfig,
  route: RebalanceRoute,
  context: string,
): Promise<KrakenAssetMapping> {
  try {
    const mapping = await dynamicConfig.getAssetMapping(route.origin, route.asset);

    if (!mapping.krakenSymbol || !mapping.krakenAsset) {
      throw new Error(`Invalid Kraken asset mapping for ${context}: missing symbol or asset`);
    }

    if (!mapping.depositMethod) {
      throw new Error(`Invalid Kraken asset mapping for ${context}: missing deposit method`);
    }

    if (!mapping.withdrawMethod) {
      throw new Error(`Invalid Kraken asset mapping for ${context}: missing withdraw method`);
    }

    return mapping;
  } catch (error) {
    throw new Error(`No Kraken asset mapping found for ${context}: ${(error as Error).message}`);
  }
}
