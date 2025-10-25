import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import { parseUnits } from 'viem';

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
 * Finds the destination asset for a route
 * If destinationAsset is provided, looks it up directly
 * Otherwise, matches by ticker hash (same-asset route)
 * @param asset - The origin asset address
 * @param origin - The origin chain ID
 * @param destination - The destination chain ID
 * @param chains - The chain configurations
 * @param logger - Logger instance for debugging
 * @param destinationAsset - Optional explicit destination asset address (for cross-asset swaps)
 * @returns The matching destination asset configuration if found, undefined otherwise
 */
export function findMatchingDestinationAsset(
  asset: string,
  origin: number,
  destination: number,
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
  destinationAsset?: string,
): AssetConfiguration | undefined {
  // If explicit destination asset provided, use it directly
  if (destinationAsset) {
    logger.debug('Finding explicit destination asset', { destinationAsset, destination });
    return findAssetByAddress(destinationAsset, destination, chains, logger);
  }

  // Otherwise, find matching asset by ticker hash (same-asset route)
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
  const matchedAsset = destinationChainConfig.assets.find(
    (a: AssetConfiguration) => a.tickerHash === originAsset.tickerHash,
  );

  if (!matchedAsset) {
    logger.warn(`Matching asset not found in destination chain`, {
      asset: originAsset,
      destination,
    });
    return undefined;
  }

  logger.debug('Found matching asset in destination chain', {
    originAsset,
    destinationAsset: matchedAsset,
  });

  return matchedAsset;
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

/**
 * Validate exchange account balance
 * @param getBalance - Function to get account balances
 * @param logger - Logger instance
 * @param exchangeName - Name of the exchange (for logging/errors)
 * @param asset - Asset symbol to check
 * @param amount - Required amount (in base units)
 * @param decimals - Asset decimals
 */
export async function validateExchangeAssetBalance(
  getBalance: () => Promise<Record<string, string>>,
  logger: Logger,
  exchangeName: string,
  asset: string,
  amount: string,
  decimals: number,
): Promise<void> {
  const balance = await getBalance();
  const availableBalance = balance[asset] || '0';
  const requiredAmount = BigInt(amount);
  const availableAmount = parseUnits(availableBalance, decimals);

  logger.debug(`${exchangeName} balance validation`, {
    asset,
    requiredAmount: amount,
    availableBalance,
    availableAmount: availableAmount.toString(),
    sufficient: availableAmount >= requiredAmount,
  });

  if (availableAmount < requiredAmount) {
    throw new Error(
      `Insufficient balance (${exchangeName}) ${asset}: required ${amount}, available ${availableBalance}`,
    );
  }
}

/**
 * Gets the destination asset for a route, respecting cross-asset swaps
 * @param route - The rebalance route
 * @param chains - Chain configurations
 * @param logger - Logger instance
 * @returns Destination asset configuration
 */
export function getDestinationAssetForRoute(
  route: { asset: string; origin: number; destination: number; destinationAsset?: string },
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
): AssetConfiguration | undefined {
  // If destinationAsset is explicitly set, use it
  if (route.destinationAsset) {
    logger.debug('Using explicit destination asset from route', {
      destinationAsset: route.destinationAsset,
      destination: route.destination,
    });
    return findAssetByAddress(route.destinationAsset, route.destination, chains, logger);
  }

  // Otherwise, find matching asset by tickerHash (same-asset route)
  logger.debug('Finding destination asset by tickerHash match', {
    originAsset: route.asset,
    origin: route.origin,
    destination: route.destination,
  });
  return findMatchingDestinationAsset(route.asset, route.origin, route.destination, chains, logger);
}

/**
 * Checks if a route is a cross-asset swap route
 */
export function isSwapRoute(route: { asset: string; destinationAsset?: string }): boolean {
  if (!route.destinationAsset) return false;
  return route.destinationAsset.toLowerCase() !== route.asset.toLowerCase();
}

/**
 * Gets asset symbols for a route (needed for CEX APIs)
 * @throws Error if assets not found in config
 */
export function getRouteAssetSymbols(
  route: { asset: string; origin: number; destination: number; destinationAsset?: string },
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
): { fromSymbol: string; toSymbol: string; fromDecimals: number; toDecimals: number } {
  const originAsset = findAssetByAddress(route.asset, route.origin, chains, logger);
  if (!originAsset) {
    throw new Error(`Origin asset not found: ${route.asset} on chain ${route.origin}`);
  }

  const destAsset = getDestinationAssetForRoute(route, chains, logger);
  if (!destAsset) {
    throw new Error(`Destination asset not found for route`);
  }

  return {
    fromSymbol: originAsset.symbol,
    toSymbol: destAsset.symbol,
    fromDecimals: originAsset.decimals,
    toDecimals: destAsset.decimals,
  };
}

/**
 * Validates a swap route configuration
 * @throws Error if route is invalid
 */
export function validateSwapRoute(
  route: { asset: string; origin: number; destination: number; destinationAsset?: string },
  chains: Record<string, ChainConfiguration>,
  logger: Logger,
): void {
  if (!isSwapRoute(route)) return;

  const originAsset = findAssetByAddress(route.asset, route.origin, chains, logger);
  const destAsset = findAssetByAddress(route.destinationAsset!, route.destination, chains, logger);

  if (!originAsset) {
    throw new Error(`Invalid swap route: origin asset ${route.asset} not found on chain ${route.origin}`);
  }

  if (!destAsset) {
    throw new Error(
      `Invalid swap route: destination asset ${route.destinationAsset} not found on chain ${route.destination}`,
    );
  }

  // Warn if same tickerHash (probably a mistake)
  if (originAsset.tickerHash === destAsset.tickerHash) {
    logger.warn('Swap route has same tickerHash for origin and destination assets', {
      route,
      originAsset,
      destAsset,
      note: 'This may be intentional for same-asset swaps on CEX, but verify config',
    });
  }
}
