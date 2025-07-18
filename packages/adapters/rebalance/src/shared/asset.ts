import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';

/**
 * Finds an asset configuration by address in a specific chain
 * @param asset - The asset address to find
 * @param chain - The chain ID to search in
 * @param chains - The chain configurations
 * @param logger - Logger instance for debugging
 * @returns The asset configuration if found, undefined otherwise
 */
export function findAssetByAddress(
  asset: string,
  chain: number,
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
): AssetConfiguration | undefined {
  logger.debug('Finding matching asset', { asset, chain });
  const chainConfig = chains[chain.toString()];
  if (!chainConfig) {
    logger.warn(`Chain configuration not found`, { asset, chain });
    return undefined;
  }
  return chainConfig.assets.find((a: AssetConfiguration) => a.address.toLowerCase() === asset.toLowerCase());
}

/**
 * Finds the matching destination asset for a given origin asset
 * Uses the asset symbol to match between origin and destination chains
 * @param asset - The origin asset address
 * @param origin - The origin chain ID
 * @param destination - The destination chain ID
 * @param chains - The chain configurations
 * @param logger - Logger instance for debugging
 * @returns The matching destination asset configuration if found, undefined otherwise
 */
export function findMatchingDestinationAsset(
  asset: string,
  origin: number,
  destination: number,
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
): AssetConfiguration | undefined {
  logger.debug('Finding matching destination asset', { asset, origin, destination });

  const destinationChainConfig = chains[destination.toString()];
  if (!destinationChainConfig) {
    logger.warn(`Destination chain configuration not found`, { asset, origin, destination });
    return undefined;
  }

  // Find the asset in the origin chain
  const originAsset = findAssetByAddress(asset, origin, chains, logger);
  if (!originAsset) {
    logger.warn(`Asset not found on origin chain`, { asset, origin });
    return undefined;
  }

  logger.debug('Found asset in origin chain', {
    asset,
    origin,
    originAsset,
  });

  // Find the matching asset in the destination chain by ticker hash
  const destinationAsset = destinationChainConfig.assets.find(
    (a: AssetConfiguration) => a.tickerHash === originAsset.tickerHash,
  );

  if (!destinationAsset) {
    logger.warn(`Matching asset not found in destination chain`, {
      asset: originAsset,
      destination,
    });
    return undefined;
  }

  logger.debug('Found matching asset in destination chain', {
    originAsset,
    destinationAsset,
  });

  return destinationAsset;
}

/**
 * Gets the destination asset address for a given origin asset
 * @param originAsset - The origin asset address
 * @param originChain - The origin chain ID
 * @param destinationChain - The destination chain ID
 * @param chains - The chain configurations
 * @param logger - Logger instance for debugging
 * @returns The destination asset address if found, undefined otherwise
 */
export function getDestinationAssetAddress(
  originAsset: string,
  originChain: number,
  destinationChain: number,
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
): string | undefined {
  const destinationAsset = findMatchingDestinationAsset(originAsset, originChain, destinationChain, chains, logger);
  return destinationAsset?.address;
}
