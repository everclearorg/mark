import { ProcessingContext } from '../init';
import { Invoice, EarmarkStatus, RebalanceOperationStatus, SupportedBridge } from '@mark/core';
import { OnDemandRouteConfig } from '@mark/core';
import * as database from '@mark/database';
import type { earmarks, Earmark } from '@mark/database';
import {
  convertTo18Decimals,
  getMarkBalances,
  getTickerForAsset,
  planSameChainSwap,
  planDirectBridgeRoute,
  planSwapBridgeRoute,
  isSameChainSwapRoute,
  isSwapBridgeRoute,
  isDirectBridgeRoute,
  getRoutePriority,
  PlannedRebalanceOperation,
  RouteEntry,
} from '../helpers';
import { getDecimalsFromConfig, getTokenAddressFromConfig } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import { RebalanceTransactionMemo } from '@mark/rebalance';
import { getValidatedZodiacConfig, getActualAddress } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';

interface OnDemandRebalanceResult {
  canRebalance: boolean;
  destinationChain?: number;
  rebalanceOperations?: PlannedRebalanceOperation[];
  totalAmount?: string;
  minAmount?: string;
}

interface EarmarkedFunds {
  chainId: number;
  tickerHash: string;
  amount: bigint;
}

export async function evaluateOnDemandRebalancing(
  invoice: Invoice,
  minAmounts: Record<string, string>,
  context: ProcessingContext,
): Promise<OnDemandRebalanceResult> {
  const { logger, requestId, config } = context;

  logger.info('Evaluating on-demand rebalancing for invoice', {
    requestId,
    invoiceId: invoice.intent_id,
    amount: invoice.amount,
    destinations: invoice.destinations,
    minAmounts,
  });

  // Get on-demand routes from config
  const onDemandRoutes = config.onDemandRoutes || [];
  if (onDemandRoutes.length === 0) {
    logger.info('No on-demand routes configured', {
      requestId,
      invoiceId: invoice.intent_id,
    });
    return { canRebalance: false };
  }

  const balances = await getMarkBalances(config, context.chainService, context.prometheus);

  // Get active earmarks to exclude from available balance
  const activeEarmarks = await database.getEarmarks({ status: [EarmarkStatus.PENDING, EarmarkStatus.READY] });
  const earmarkedFunds = calculateEarmarkedFunds(activeEarmarks);

  // For each potential destination chain, evaluate if we can aggregate enough funds
  const evaluationResults: Map<number, OnDemandRebalanceResult & { minAmount: string }> = new Map();

  logger.info('Evaluating all invoice destinations for on-demand rebalancing', {
    requestId,
    invoiceId: invoice.intent_id,
    invoiceTicker: invoice.ticker_hash.toLowerCase(),
    destinations: invoice.destinations,
    minAmounts,
    onDemandRoutesCount: onDemandRoutes.length,
  });

  for (const destinationStr of invoice.destinations) {
    const destination = parseInt(destinationStr);

    // Skip if no minAmount for this destination
    if (!minAmounts[destinationStr]) {
      logger.warn('No minAmount for destination, skipping', {
        requestId,
        invoiceId: invoice.intent_id,
        destination,
        destinationStr,
        availableMinAmounts: Object.keys(minAmounts),
      });
      continue;
    }

    logger.info('Evaluating destination chain', {
      requestId,
      invoiceId: invoice.intent_id,
      destination,
      minAmount: minAmounts[destinationStr],
    });

    const result = await evaluateDestinationChain(
      invoice,
      destination,
      minAmounts[destinationStr],
      onDemandRoutes,
      balances,
      earmarkedFunds,
      context,
    );

    logger.info('Destination chain evaluation result', {
      requestId,
      invoiceId: invoice.intent_id,
      destination,
      canRebalance: result.canRebalance,
      hasOperations: !!result.rebalanceOperations && result.rebalanceOperations.length > 0,
      operationsCount: result.rebalanceOperations?.length || 0,
    });

    if (result.canRebalance) {
      evaluationResults.set(destination, { ...result, minAmount: minAmounts[destinationStr] });
      logger.info('Destination chain can be rebalanced', {
        requestId,
        invoiceId: invoice.intent_id,
        destination,
        operationsCount: result.rebalanceOperations?.length || 0,
      });
    } else {
      logger.warn('Destination chain cannot be rebalanced', {
        requestId,
        invoiceId: invoice.intent_id,
        destination,
      });
    }
  }

  logger.info('Finished evaluating all destinations', {
    requestId,
    invoiceId: invoice.intent_id,
    totalDestinations: invoice.destinations.length,
    viableDestinations: evaluationResults.size,
    viableDestinationChains: Array.from(evaluationResults.keys()),
  });

  // Select the best destination
  const bestDestination = selectBestDestination(evaluationResults);

  if (!bestDestination) {
    logger.warn('No viable destination found for on-demand rebalancing', {
      requestId,
      invoiceId: invoice.intent_id,
      evaluatedDestinations: evaluationResults.size,
      invoiceDestinations: invoice.destinations,
      invoiceTicker: invoice.ticker_hash.toLowerCase(),
      onDemandRoutesCount: onDemandRoutes.length,
    });
    return { canRebalance: false };
  }

  logger.info('Selected best destination for on-demand rebalancing', {
    requestId,
    invoiceId: invoice.intent_id,
    destinationChain: bestDestination.destinationChain,
    operationsCount: bestDestination.rebalanceOperations?.length || 0,
  });

  return bestDestination;
}

async function evaluateDestinationChain(
  invoice: Invoice,
  destination: number,
  minAmount: string,
  routes: OnDemandRouteConfig[],
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  context: ProcessingContext,
): Promise<OnDemandRebalanceResult> {
  const { logger, config, requestId } = context;

  const invoiceTickerLower = invoice.ticker_hash.toLowerCase();

  logger.info('Evaluating destination chain for on-demand rebalancing', {
    requestId,
    invoiceId: invoice.intent_id,
    destination,
    invoiceTicker: invoiceTickerLower,
    minAmount,
    availableRoutes: routes.length,
  });

  const routeEntries = buildRouteEntriesForDestination(
    destination,
    routes,
    invoiceTickerLower,
    invoice.intent_id,
    config,
    logger,
  );

  logger.info('Route entries built for destination', {
    requestId,
    invoiceId: invoice.intent_id,
    destination,
    routeEntriesCount: routeEntries.length,
    routeEntries: routeEntries.map((e) => ({
      inputTicker: e.inputTicker,
      outputTicker: e.outputTicker,
      priority: e.priority,
      route: {
        origin: e.route.origin,
        destination: e.route.destination,
        asset: e.route.asset,
        swapOutputAsset: e.route.swapOutputAsset,
      },
    })),
  });

  if (routeEntries.length === 0) {
    logger.warn('No route entries found for destination', {
      requestId,
      invoiceId: invoice.intent_id,
      destination,
      invoiceTicker: invoiceTickerLower,
    });
    return { canRebalance: false };
  }

  const ticker = invoiceTickerLower;

  // minAmount from API is already in standardized 18 decimals
  const requiredAmount = BigInt(minAmount);

  if (!requiredAmount) {
    logger.error('Invalid minAmount', {
      requestId,
      invoiceId: invoice.intent_id,
      minAmount,
      destination,
    });
    return { canRebalance: false };
  }

  // Check current balance on destination (already in 18 decimals from getMarkBalances)
  const destinationBalance = balances.get(ticker)?.get(destination.toString()) || 0n;
  const earmarkedOnDestination = earmarkedFunds
    .filter((e) => e.chainId === destination && e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + e.amount, 0n);

  // Calculate available balance, ensuring it doesn't go negative
  const availableOnDestination =
    destinationBalance > earmarkedOnDestination ? destinationBalance - earmarkedOnDestination : 0n;

  // Calculate the amount needed to fulfill the invoice (both values now in 18 decimals)
  const amountNeeded = requiredAmount > availableOnDestination ? requiredAmount - availableOnDestination : 0n;

  logger.info('Balance check for destination', {
    requestId,
    invoiceId: invoice.intent_id,
    destination,
    ticker,
    requiredAmount: requiredAmount.toString(),
    destinationBalance: destinationBalance.toString(),
    earmarkedOnDestination: earmarkedOnDestination.toString(),
    availableOnDestination: availableOnDestination.toString(),
    amountNeeded: amountNeeded.toString(),
  });

  // If destination already has enough, no need to rebalance
  if (amountNeeded <= 0n) {
    logger.info('Destination already has sufficient balance, no rebalancing needed', {
      requestId,
      invoiceId: invoice.intent_id,
      destination,
      requiredAmount: requiredAmount.toString(),
      availableOnDestination: availableOnDestination.toString(),
    });
    return { canRebalance: false };
  }

  // Calculate rebalancing operations
  logger.info('Calculating rebalancing operations', {
    requestId,
    invoiceId: invoice.intent_id,
    destination,
    amountNeeded: amountNeeded.toString(),
    routeEntriesCount: routeEntries.length,
  });

  const { operations, canFulfill, totalAchievable } = await calculateRebalancingOperations(
    amountNeeded,
    routeEntries,
    balances,
    earmarkedFunds,
    invoiceTickerLower,
    invoice.intent_id,
    context,
  );

  logger.info('Rebalancing operations calculated', {
    requestId,
    invoiceId: invoice.intent_id,
    destination,
    operationsCount: operations.length,
    canFulfill,
    totalAchievable: totalAchievable.toString(),
    amountNeeded: amountNeeded.toString(),
    operations: operations.map((op) => ({
      originChain: op.originChain,
      destinationChain: op.destinationChain,
      amount: op.amount,
      bridge: op.bridge,
      isSameChainSwap: op.isSameChainSwap,
      inputAsset: op.inputAsset,
      outputAsset: op.outputAsset,
    })),
  });

  // Check if we can fulfill the invoice after all rebalancing
  if (canFulfill) {
    logger.info('Can fulfill invoice for destination', {
      requestId,
      invoiceId: invoice.intent_id,
      destination,
      requiredAmount: requiredAmount.toString(),
      operations: operations.length,
      totalAchievable: totalAchievable.toString(),
    });
    return {
      canRebalance: true,
      destinationChain: destination,
      rebalanceOperations: operations,
      totalAmount: requiredAmount.toString(),
    };
  }

  logger.warn('Cannot fulfill invoice for destination', {
    requestId,
    invoiceId: invoice.intent_id,
    destination,
    requiredAmount: requiredAmount.toString(),
    destinationBalance: destinationBalance.toString(),
    earmarkedOnDestination: earmarkedOnDestination.toString(),
    availableOnDestination: availableOnDestination.toString(),
    amountNeeded: amountNeeded.toString(),
    operations: operations.length,
    totalAchievable: totalAchievable.toString(),
  });
  return { canRebalance: false };
}

/**
 * Finds a same-chain swap route that produces the given asset on the origin chain
 */
function findMatchingSwapRoute(
  bridgeRoute: OnDemandRouteConfig,
  routes: OnDemandRouteConfig[],
  config: ProcessingContext['config'],
): OnDemandRouteConfig | undefined {
  // Must be a direct bridge route (no swapOutputAsset, cross-chain)
  if (bridgeRoute.swapOutputAsset || bridgeRoute.origin === bridgeRoute.destination) {
    return undefined;
  }

  const bridgeInputTicker = getTickerForAsset(bridgeRoute.asset, bridgeRoute.origin, config)?.toLowerCase();
  if (!bridgeInputTicker) {
    return undefined;
  }

  return routes.find((r) => {
    // Must be same-chain swap on the same origin
    if (r.origin !== r.destination || r.origin !== bridgeRoute.origin) {
      return false;
    }

    // Must have swap configuration
    if (!r.swapOutputAsset || !r.swapPreferences?.length) {
      return false;
    }

    // Swap output must match bridge input
    const swapOutputTicker = getTickerForAsset(r.swapOutputAsset, r.origin, config)?.toLowerCase();
    return swapOutputTicker === bridgeInputTicker;
  });
}

function buildRouteEntriesForDestination(
  destination: number,
  routes: OnDemandRouteConfig[],
  invoiceTickerLower: string,
  invoiceId: string,
  config: ProcessingContext['config'],
  logger?: ProcessingContext['logger'],
): RouteEntry[] {
  const entries: RouteEntry[] = [];

  logger?.info('Building route entries for destination', {
    destination,
    invoiceId,
    invoiceTicker: invoiceTickerLower,
    totalRoutes: routes.length,
    routes: routes.map((r) => ({
      origin: r.origin,
      destination: r.destination,
      asset: r.asset,
      swapOutputAsset: r.swapOutputAsset,
    })),
  });

  for (const route of routes) {
    if (route.destination !== destination) {
      logger?.debug('Route destination does not match, skipping', {
        invoiceId,
        routeDestination: route.destination,
        targetDestination: destination,
      });
      continue;
    }

    logger?.debug('Processing route for destination', {
      invoiceId,
      destination,
      route: {
        origin: route.origin,
        destination: route.destination,
        asset: route.asset,
        swapOutputAsset: route.swapOutputAsset,
        preferences: route.preferences,
        swapPreferences: route.swapPreferences,
      },
    });

    // Check if this bridge route can be combined with a same-chain swap route
    let combinedRoute = route;
    let inputTicker = getTickerForAsset(route.asset, route.origin, config)?.toLowerCase();

    logger?.debug('Initial route ticker resolution', {
      invoiceId,
      routeAsset: route.asset,
      routeOrigin: route.origin,
      inputTicker: inputTicker || 'not found',
    });

    const swapRoute = findMatchingSwapRoute(route, routes, config);
    if (swapRoute) {
      logger?.info('Found matching swap route for bridge route, combining into swap+bridge pattern', {
        invoiceId,
        destination,
        bridgeRoute: {
          origin: route.origin,
          destination: route.destination,
          asset: route.asset,
        },
        swapRoute: {
          origin: swapRoute.origin,
          destination: swapRoute.destination,
          asset: swapRoute.asset,
          swapOutputAsset: swapRoute.swapOutputAsset,
        },
      });

      combinedRoute = {
        ...route,
        asset: swapRoute.asset, // Use the swap route's input asset
        swapOutputAsset: route.asset, // The bridge route's asset (output of swap, input to bridge)
        swapPreferences: swapRoute.swapPreferences,
        slippagesDbps: route.slippagesDbps,
      };

      inputTicker = getTickerForAsset(swapRoute.asset, swapRoute.origin, config)?.toLowerCase();
      logger?.debug('After combining with swap route', {
        invoiceId,
        combinedRouteAsset: combinedRoute.asset,
        combinedRouteDestinationAsset: combinedRoute.swapOutputAsset,
        inputTicker: inputTicker || 'not found',
      });
    }

    // For swap+bridge routes, swapOutputAsset is the intermediate asset on origin chain
    // We need to resolve the final output asset from the invoice ticker on destination chain
    const isSwapBridgeRoute = combinedRoute.swapOutputAsset && route.origin !== route.destination;
    logger?.debug('Determining output asset address', {
      invoiceId,
      isSwapBridgeRoute,
      hasDestinationAsset: !!combinedRoute.swapOutputAsset,
      origin: route.origin,
      destination: route.destination,
      routeAsset: route.asset,
      combinedRouteDestinationAsset: combinedRoute.swapOutputAsset,
    });

    // For swap+bridge routes, we must get the token address from the destination chain config
    // The fallback to route.asset would be wrong (it's on origin chain, not destination)
    let swapOutputAssetAddress: string | undefined;
    if (isSwapBridgeRoute) {
      swapOutputAssetAddress = getTokenAddressFromConfig(invoiceTickerLower, route.destination.toString(), config);
      if (!swapOutputAssetAddress) {
        logger?.warn('Failed to resolve destination asset address for swap+bridge route', {
          invoiceId,
          invoiceTicker: invoiceTickerLower,
          destinationChain: route.destination,
          originChain: route.origin,
          intermediateAsset: combinedRoute.swapOutputAsset,
        });
      }
    } else {
      swapOutputAssetAddress =
        combinedRoute.swapOutputAsset ??
        getTokenAddressFromConfig(invoiceTickerLower, route.destination.toString(), config) ??
        route.asset;
    }

    logger?.debug('Resolved destination asset address', {
      invoiceId,
      swapOutputAssetAddress,
      destinationChain: route.destination,
      invoiceTicker: invoiceTickerLower,
      tokenAddressFromConfig: getTokenAddressFromConfig(invoiceTickerLower, route.destination.toString(), config),
    });

    let outputTicker: string | undefined;
    if (swapOutputAssetAddress) {
      outputTicker = getTickerForAsset(swapOutputAssetAddress, route.destination, config)?.toLowerCase();
    }

    if (!outputTicker) {
      logger?.debug('Output ticker not found, trying fallback', {
        invoiceId,
        swapOutputAssetAddress,
        destinationChain: route.destination,
      });
      const fallbackAddress = getTokenAddressFromConfig(invoiceTickerLower, route.destination.toString(), config);
      if (fallbackAddress) {
        outputTicker = getTickerForAsset(fallbackAddress, route.destination, config)?.toLowerCase();
        logger?.debug('Fallback ticker resolution', {
          invoiceId,
          fallbackAddress,
          outputTicker: outputTicker || 'still not found',
        });
      }
    }

    logger?.info('Route entry validation', {
      invoiceId,
      destination,
      inputTicker: inputTicker || 'missing',
      outputTicker: outputTicker || 'missing',
      invoiceTicker: invoiceTickerLower,
      outputTickerMatches: outputTicker === invoiceTickerLower,
      route: {
        origin: combinedRoute.origin,
        destination: combinedRoute.destination,
        asset: combinedRoute.asset,
        swapOutputAsset: combinedRoute.swapOutputAsset,
      },
    });

    if (!inputTicker || !outputTicker || outputTicker !== invoiceTickerLower) {
      logger?.warn('Route skipped during route entry building', {
        invoiceId,
        destination,
        route: {
          origin: combinedRoute.origin,
          destination: combinedRoute.destination,
          asset: combinedRoute.asset,
          swapOutputAsset: combinedRoute.swapOutputAsset,
        },
        invoiceTicker: invoiceTickerLower,
        inputTicker: inputTicker || 'missing',
        outputTicker: outputTicker || 'missing',
        reason: !inputTicker
          ? 'inputTicker not found in config'
          : !outputTicker
            ? 'outputTicker not found in config'
            : 'outputTicker does not match invoice ticker',
        swapOutputAssetAddress,
        tokenAddressFromConfig: getTokenAddressFromConfig(invoiceTickerLower, route.destination.toString(), config),
      });
      continue;
    }

    logger?.info('Route entry created successfully', {
      invoiceId,
      destination,
      inputTicker,
      outputTicker,
      priority: getRoutePriority(combinedRoute),
    });

    entries.push({
      route: combinedRoute,
      inputTicker,
      outputTicker,
      priority: getRoutePriority(combinedRoute),
    });
  }

  logger?.info('Finished building route entries', {
    invoiceId,
    destination,
    invoiceTicker: invoiceTickerLower,
    entriesCreated: entries.length,
    entries: entries.map((e) => ({
      inputTicker: e.inputTicker,
      outputTicker: e.outputTicker,
      priority: e.priority,
    })),
  });

  return entries;
}

function getAvailableBalance(
  chainId: number,
  tickerHash: string,
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  reserve: string,
): bigint {
  const ticker = tickerHash.toLowerCase();
  const balance = balances.get(ticker)?.get(chainId.toString()) || 0n;

  // Subtract earmarked funds
  const earmarked = earmarkedFunds
    .filter((e) => e.chainId === chainId && e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + e.amount, 0n);

  // Subtract reserve amount (already in standardized 18 decimals)
  const reserveAmount = BigInt(reserve);

  const available = balance - earmarked - reserveAmount;
  return available > 0n ? available : 0n;
}

function calculateEarmarkedFunds(earmarks: database.CamelCasedProperties<earmarks>[]): EarmarkedFunds[] {
  const fundsMap = new Map<string, EarmarkedFunds>();

  for (const earmark of earmarks) {
    const key = `${earmark.designatedPurchaseChain}-${earmark.tickerHash}`;

    // earmark.minAmount is already stored in standardized 18 decimals from the API
    const amount = BigInt(earmark.minAmount) || 0n;

    const existing = fundsMap.get(key);
    if (existing) {
      existing.amount += amount;
    } else {
      fundsMap.set(key, {
        chainId: earmark.designatedPurchaseChain,
        tickerHash: earmark.tickerHash,
        amount,
      });
    }
  }

  return Array.from(fundsMap.values());
}

/**
 * Calculates rebalancing operations needed to achieve a target amount
 * @param amountNeeded - Amount needed in standardized 18 decimals
 * @param routes - Available routes for rebalancing
 * @param balances - Current balances across chains
 * @param earmarkedFunds - Funds already earmarked for other operations
 * @param tickerHash - Asset ticker hash
 * @param context - Processing context with access to adapters
 * @returns Array of rebalancing operations and total amount that can be achieved
 */
async function calculateRebalancingOperations(
  amountNeeded: bigint,
  routeEntries: RouteEntry[],
  balances: Map<string, Map<string, bigint>>,
  earmarkedFunds: EarmarkedFunds[],
  invoiceTicker: string,
  invoiceId: string,
  context: ProcessingContext,
): Promise<{
  operations: PlannedRebalanceOperation[];
  totalAchievable: bigint;
  canFulfill: boolean;
}> {
  const { logger, requestId } = context;
  const operations: PlannedRebalanceOperation[] = [];
  let remainingNeeded = amountNeeded;
  let totalAchievable = 0n;

  const availabilityByKey = new Map<string, bigint>();
  const availabilityKey = (chainId: number, ticker: string) => `${chainId}:${ticker.toLowerCase()}`;
  const getAvailableForEntry = (entry: RouteEntry): bigint => {
    if (!entry.inputTicker) {
      return 0n;
    }

    const key = availabilityKey(entry.route.origin, entry.inputTicker);

    if (availabilityByKey.has(key)) {
      return availabilityByKey.get(key)!;
    }

    const available = getAvailableBalance(
      entry.route.origin,
      entry.inputTicker,
      balances,
      earmarkedFunds,
      entry.route.reserve || '0',
    );

    availabilityByKey.set(key, available);
    return available;
  };

  const reduceAvailabilityForEntry = (entry: RouteEntry, amountIn18: bigint) => {
    if (!entry.inputTicker) {
      return;
    }

    const key = availabilityKey(entry.route.origin, entry.inputTicker);
    const current = getAvailableForEntry(entry);
    const next = current > amountIn18 ? current - amountIn18 : 0n;
    availabilityByKey.set(key, next);
  };

  const sortedEntries = [...routeEntries].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    const balanceA = getAvailableForEntry(a);
    const balanceB = getAvailableForEntry(b);

    if (balanceA === balanceB) {
      return 0;
    }

    return balanceB > balanceA ? 1 : -1;
  });

  for (const entry of sortedEntries) {
    if (remainingNeeded <= 0n) {
      break;
    }

    const availableOnOrigin = getAvailableForEntry(entry);

    if (availableOnOrigin <= 0n) {
      logger.debug('Route skipped during planning due to zero available balance', {
        requestId,
        invoiceId,
        route: entry.route,
        inputTicker: entry.inputTicker,
      });
      continue;
    }

    let planned = false;

    if (isSameChainSwapRoute(entry.route)) {
      const sameChainResult = await planSameChainSwap(entry, availableOnOrigin, remainingNeeded, context);

      if (sameChainResult) {
        operations.push(sameChainResult.operation);

        const produced = sameChainResult.producedAmount;
        totalAchievable += produced;
        remainingNeeded = remainingNeeded > produced ? remainingNeeded - produced : 0n;
        planned = true;

        const decimals = getDecimalsFromConfig(entry.inputTicker!, entry.route.origin.toString(), context.config);
        if (decimals) {
          const consumed = convertTo18Decimals(BigInt(sameChainResult.operation.amount), decimals);
          reduceAvailabilityForEntry(entry, consumed);
        } else {
          logger.debug('Missing decimals while reducing availability for same-chain swap', {
            requestId,
            invoiceId,
            route: entry.route,
            ticker: entry.inputTicker,
          });
        }
      }
    } else if (isDirectBridgeRoute(entry.route)) {
      const directResult = await planDirectBridgeRoute(
        entry,
        availableOnOrigin,
        invoiceTicker,
        remainingNeeded,
        context,
      );

      if (directResult) {
        operations.push(directResult.operation);

        const produced = directResult.producedAmount;
        totalAchievable += produced;
        remainingNeeded = remainingNeeded > produced ? remainingNeeded - produced : 0n;
        planned = true;

        const decimals = getDecimalsFromConfig(entry.inputTicker!, entry.route.origin.toString(), context.config);
        if (decimals) {
          const consumed = convertTo18Decimals(BigInt(directResult.operation.amount), decimals);
          reduceAvailabilityForEntry(entry, consumed);
        } else {
          logger.debug('Missing decimals while reducing availability for direct bridge', {
            requestId,
            invoiceId,
            route: entry.route,
            ticker: entry.inputTicker,
          });
        }
      }
    } else if (isSwapBridgeRoute(entry.route)) {
      const pairResult = await planSwapBridgeRoute(entry, availableOnOrigin, invoiceTicker, remainingNeeded, context);

      if (pairResult) {
        operations.push(...pairResult.operations);

        const produced = pairResult.producedAmount;
        totalAchievable += produced;
        remainingNeeded = remainingNeeded > produced ? remainingNeeded - produced : 0n;
        planned = true;

        const swapOperation = pairResult.operations.find((op) => op.isSameChainSwap);
        if (swapOperation && entry.inputTicker) {
          const decimals = getDecimalsFromConfig(entry.inputTicker!, entry.route.origin.toString(), context.config);
          if (decimals) {
            const consumed = convertTo18Decimals(BigInt(swapOperation.amount), decimals);
            reduceAvailabilityForEntry(entry, consumed);
          } else {
            logger.debug('Missing decimals while reducing availability for swap+bridge swap leg', {
              requestId,
              invoiceId,
              route: entry.route,
              ticker: entry.inputTicker,
            });
          }
        }
      }
    }

    if (!planned) {
      logger.debug('Route entry did not yield viable operation during planning', {
        requestId,
        invoiceId,
        route: entry.route,
        inputTicker: entry.inputTicker,
        outputTicker: entry.outputTicker,
      });
    }
  }

  const roundingTolerance = BigInt(10 ** 12); // 1 unit in 6 decimals = 1e12 in 18 decimals
  const canFulfill = remainingNeeded <= roundingTolerance;

  logger.debug('calculateRebalancingOperations result', {
    requestId,
    invoiceId,
    operations: operations.length,
    totalAchievable: totalAchievable.toString(),
    remainingNeeded: remainingNeeded.toString(),
    canFulfill,
  });

  return {
    operations,
    totalAchievable,
    canFulfill,
  };
}

/**
 * Defensive fallback to find route for an operation if routeConfig is missing
 * Note: routeConfig should always be set when operations are created, so this is only
 * used as a safety fallback in unexpected scenarios
 */
function findRouteForOperation(
  operation: PlannedRebalanceOperation,
  routes: OnDemandRouteConfig[],
): OnDemandRouteConfig | undefined {
  if (!operation.inputAsset || !operation.outputAsset) {
    return undefined;
  }

  const origin = operation.originChain;
  const destination = operation.destinationChain;
  const inputAssetLower = operation.inputAsset.toLowerCase();
  const outputAssetLower = operation.outputAsset.toLowerCase();

  return routes.find((route) => {
    if (route.origin !== origin || route.destination !== destination) {
      return false;
    }

    const routeInput = route.asset.toLowerCase();
    const routeOutput = (route.swapOutputAsset ?? route.asset).toLowerCase();

    return routeInput === inputAssetLower && routeOutput === outputAssetLower;
  });
}

function selectBestDestination(
  evaluationResults: Map<number, OnDemandRebalanceResult & { minAmount: string }>,
): OnDemandRebalanceResult | null {
  if (evaluationResults.size === 0) return null;

  // Primary criteria: minimize number of rebalancing operations
  // Secondary criteria: minimize total amount to rebalance
  let bestResult: OnDemandRebalanceResult | null = null;
  let minOperations = Infinity;
  let minAmount = BigInt(Number.MAX_SAFE_INTEGER);

  for (const [, result] of evaluationResults) {
    const numOps = result.rebalanceOperations?.length || 0;
    const totalAmount =
      result.rebalanceOperations?.reduce((sum, op) => {
        return sum + (BigInt(op.amount) || 0n);
      }, 0n) || 0n;

    if (numOps < minOperations || (numOps === minOperations && totalAmount < minAmount)) {
      bestResult = result;
      minOperations = numOps;
      minAmount = totalAmount;
    }
  }

  return bestResult;
}

export async function executeOnDemandRebalancing(
  invoice: Invoice,
  evaluationResult: OnDemandRebalanceResult,
  context: ProcessingContext,
): Promise<string | null> {
  const { logger, requestId, config } = context;

  if (!evaluationResult.canRebalance) {
    return null;
  }

  const { destinationChain, rebalanceOperations, minAmount } = evaluationResult;

  // Check if an active earmark already exists for this invoice before executing operations
  const existingActive = await database.getActiveEarmarkForInvoice(invoice.intent_id);

  if (existingActive) {
    logger.warn('Active earmark already exists for invoice, skipping rebalance operations', {
      requestId,
      invoiceId: invoice.intent_id,
      existingEarmarkId: existingActive.id,
      existingStatus: existingActive.status,
    });
    return existingActive.status === EarmarkStatus.PENDING ? existingActive.id : null;
  }

  // Track successful operations to create database records later
  const successfulOperations: Array<{
    originChainId: number;
    amount: string;
    slippage: number;
    bridge: string;
    receipt: database.TransactionReceipt;
    recipient: string;
  }> = [];
  let bridgeOperationCount = 0;
  let swapSuccessCount = 0;

  try {
    for (const operation of rebalanceOperations!) {
      const execResult = await executeSingleOperation(
        operation,
        invoice.intent_id,
        destinationChain!,
        context,
        config.onDemandRoutes || [],
      );

      if (!execResult) {
        // Error already logged in executeSingleOperation
        // For swaps, fail fast; for bridges, continue to next operation
        if (operation.isSameChainSwap) {
          return null;
        }
        continue;
      }

      if (execResult.isSwap) {
        swapSuccessCount += 1;
        continue;
      }

      bridgeOperationCount += 1;

      if (execResult.result && execResult.recipient) {
        successfulOperations.push({
          originChainId: operation.originChain,
          amount: execResult.result.effectiveAmount || operation.amount,
          slippage: operation.slippage,
          bridge: operation.bridge,
          receipt: execResult.result.receipt,
          recipient: execResult.recipient,
        });
      }
    }

    if (bridgeOperationCount === 0) {
      if (swapSuccessCount > 0) {
        logger.info('Same-chain swap satisfied rebalancing need without bridge operations', {
          requestId,
          invoiceId: invoice.intent_id,
        });
      } else {
        logger.warn('No rebalance operations executed for invoice', {
          requestId,
          invoiceId: invoice.intent_id,
        });
      }
      return null;
    }

    if (successfulOperations.length === 0) {
      logger.error('No bridge operations succeeded, not creating earmark', {
        requestId,
        invoiceId: invoice.intent_id,
        totalBridgeOperations: bridgeOperationCount,
      });
      return null;
    }

    const allSucceeded = successfulOperations.length === bridgeOperationCount;
    if (allSucceeded) {
      logger.info('All bridge operations succeeded, creating earmark', {
        requestId,
        invoiceId: invoice.intent_id,
        successfulOperations: successfulOperations.length,
        totalBridgeOperations: bridgeOperationCount,
      });
    } else {
      logger.warn('Partial failure in rebalancing, creating FAILED earmark', {
        requestId,
        invoiceId: invoice.intent_id,
        successfulOperations: successfulOperations.length,
        totalBridgeOperations: bridgeOperationCount,
      });
    }

    let earmark: Earmark;
    try {
      earmark = await database.createEarmark({
        invoiceId: invoice.intent_id,
        designatedPurchaseChain: destinationChain!,
        tickerHash: invoice.ticker_hash,
        minAmount: minAmount!,
        status: allSucceeded ? EarmarkStatus.PENDING : EarmarkStatus.FAILED,
      });
    } catch (error: unknown) {
      const dbError = error as { code?: string; constraint?: string };
      if (dbError.code === '23505' && dbError.constraint === 'unique_active_earmark_per_invoice') {
        logger.warn('Race condition: Active earmark created by another process', {
          requestId,
          invoiceId: invoice.intent_id,
        });
        const existing = await database.getActiveEarmarkForInvoice(invoice.intent_id);
        return existing?.status === EarmarkStatus.PENDING ? existing.id : null;
      }
      throw error;
    }

    logger.info('Created earmark for invoice', {
      requestId,
      earmarkId: earmark.id,
      invoiceId: invoice.intent_id,
      status: earmark.status,
    });

    for (const op of successfulOperations) {
      try {
        await database.createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: op.originChainId,
          destinationChainId: destinationChain!,
          tickerHash: invoice.ticker_hash,
          amount: op.amount,
          slippage: op.slippage,
          status: RebalanceOperationStatus.PENDING,
          bridge: op.bridge,
          transactions: { [op.originChainId]: op.receipt },
          recipient: op.recipient,
        });

        logger.info('Created rebalance operation record', {
          requestId,
          earmarkId: earmark.id,
          originChain: op.originChainId,
          txHash: op.receipt.transactionHash,
          bridge: op.bridge,
        });
      } catch (error) {
        logger.error('CRITICAL: Failed to create rebalance operation record for confirmed transaction', {
          requestId,
          earmarkId: earmark.id,
          operation: op,
          error: jsonifyError(error),
        });
      }
    }

    return earmark.status === EarmarkStatus.PENDING ? earmark.id : null;
  } catch (error) {
    logger.error('Failed to execute on-demand rebalancing', {
      requestId,
      invoiceId: invoice.intent_id,
      error: jsonifyError(error),
      successfulOperations: successfulOperations.length,
    });
    return null;
  }
}

/**
 * Helper function to get minAmounts for an invoice with error handling
 */
async function getMinAmountsForInvoice(
  invoiceId: string,
  context: ProcessingContext,
): Promise<Record<string, string> | null> {
  const { logger, requestId, everclear } = context;

  try {
    const response = await everclear.getMinAmounts(invoiceId);
    return response.minAmounts;
  } catch (error) {
    logger.error('Failed to get minAmounts for earmarked invoice', {
      requestId,
      invoiceId,
      error: jsonifyError(error),
    });
    return null;
  }
}

/**
 * Check if all rebalance operations for an earmark are complete
 */
async function checkAllOperationsComplete(earmarkId: string): Promise<boolean> {
  const operations = await database.getRebalanceOperationsByEarmark(earmarkId);
  return operations.length > 0 && operations.every((op) => op.status === RebalanceOperationStatus.COMPLETED);
}

/**
 * Handle the case when minAmount has increased for an earmarked invoice
 */
async function handleMinAmountIncrease(
  earmark: database.CamelCasedProperties<earmarks>,
  invoice: Invoice,
  currentMinAmount: string,
  context: ProcessingContext,
): Promise<boolean> {
  const { logger, requestId, config } = context;
  const ticker = earmark.tickerHash.toLowerCase();

  const currentRequiredAmount = BigInt(currentMinAmount);
  const earmarkedAmount = BigInt(earmark.minAmount);

  if (!currentRequiredAmount || !earmarkedAmount) {
    return false;
  }

  // Both values are already in standardized 18 decimals from the API
  const additionalAmount = currentRequiredAmount - earmarkedAmount;

  logger.info('MinAmount increased, evaluating additional rebalancing', {
    requestId,
    invoiceId: earmark.invoiceId,
    oldMinAmount: earmark.minAmount,
    newMinAmount: currentMinAmount,
    difference: additionalAmount.toString(),
  });

  // Get current balances and earmarked funds
  const balances = await getMarkBalances(config, context.chainService, context.prometheus);
  const activeEarmarks = await database.getEarmarks({ status: [EarmarkStatus.PENDING, EarmarkStatus.READY] });
  const earmarkedFunds = calculateEarmarkedFunds(activeEarmarks);

  // Check if destination already has enough available balance
  const destinationBalance = balances.get(ticker)?.get(earmark.designatedPurchaseChain.toString()) || 0n;
  const earmarkedOnDestination = earmarkedFunds
    .filter((e) => e.chainId === earmark.designatedPurchaseChain && e.tickerHash.toLowerCase() === ticker)
    .reduce((sum, e) => sum + e.amount, 0n);
  const availableBalance = destinationBalance - earmarkedOnDestination;

  if (availableBalance >= additionalAmount) {
    logger.info('Sufficient balance already available for increased minAmount', {
      requestId,
      invoiceId: earmark.invoiceId,
      additionalAmount: additionalAmount.toString(),
      availableBalance: availableBalance.toString(),
    });
    return true;
  }

  // Evaluate if we can rebalance the additional amount
  const onDemandRoutes = config.onDemandRoutes || [];
  const invoiceTickerLower = invoice.ticker_hash.toLowerCase();
  const additionalRouteEntries = buildRouteEntriesForDestination(
    earmark.designatedPurchaseChain,
    onDemandRoutes,
    invoiceTickerLower,
    earmark.invoiceId,
    config,
    logger,
  );

  const { operations: additionalOperations, canFulfill: canRebalanceAdditional } = await calculateRebalancingOperations(
    additionalAmount,
    additionalRouteEntries,
    balances,
    earmarkedFunds,
    invoice.ticker_hash.toLowerCase(),
    earmark.invoiceId,
    context,
  );

  if (!canRebalanceAdditional || additionalOperations.length === 0) {
    logger.warn('Cannot rebalance additional amount for increased minAmount', {
      requestId,
      invoiceId: earmark.invoiceId,
      additionalAmount: additionalAmount.toString(),
    });
    return false;
  }

  logger.info('Can rebalance additional amount for increased minAmount', {
    requestId,
    invoiceId: earmark.invoiceId,
    additionalAmount: additionalAmount.toString(),
    operations: additionalOperations.length,
  });

  // Track successful additional operations
  const successfulAdditionalOps: Array<{
    originChainId: number;
    amount: string;
    slippage: number;
    bridge: string;
    receipt: database.TransactionReceipt;
    recipient: string;
  }> = [];

  let additionalBridgeCount = 0;

  // Execute additional rebalancing operations
  for (const operation of additionalOperations) {
    const execResult = await executeSingleOperation(
      operation,
      earmark.invoiceId,
      earmark.designatedPurchaseChain,
      context,
      onDemandRoutes,
    );

    if (!execResult) {
      // Error already logged in executeSingleOperation
      // For swaps, fail fast; for bridges, continue to next operation
      if (operation.isSameChainSwap) {
        return false;
      }
      continue;
    }

    if (execResult.isSwap) {
      continue;
    }

    additionalBridgeCount += 1;

    if (execResult.result && execResult.recipient) {
      logger.info('Additional rebalance transaction confirmed', {
        requestId,
        invoiceId: earmark.invoiceId,
        transactionHash: execResult.result.receipt.transactionHash,
        bridgeType: operation.bridge,
        originChain: operation.originChain,
        amount: execResult.result.effectiveAmount || operation.amount,
        originalAmount:
          execResult.result.effectiveAmount && execResult.result.effectiveAmount !== operation.amount
            ? operation.amount
            : undefined,
      });

      successfulAdditionalOps.push({
        originChainId: operation.originChain,
        amount: execResult.result.effectiveAmount || operation.amount,
        slippage: operation.slippage,
        bridge: operation.bridge,
        receipt: execResult.result.receipt,
        recipient: execResult.recipient,
      });
    }
  }

  if (additionalBridgeCount > 0 && successfulAdditionalOps.length === 0) {
    logger.error('No additional bridge operations succeeded for increased minAmount', {
      requestId,
      invoiceId: earmark.invoiceId,
      additionalBridgeCount,
    });
    return false;
  }

  // Create database records for successful additional operations
  if (successfulAdditionalOps.length > 0) {
    logger.info('Creating database records for additional rebalancing operations', {
      requestId,
      earmarkId: earmark.id,
      successfulOperations: successfulAdditionalOps.length,
    });

    for (const op of successfulAdditionalOps) {
      try {
        await database.createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: op.originChainId,
          destinationChainId: earmark.designatedPurchaseChain,
          tickerHash: invoice.ticker_hash,
          amount: op.amount,
          slippage: op.slippage,
          status: RebalanceOperationStatus.PENDING,
          bridge: op.bridge,
          transactions: { [op.originChainId]: op.receipt },
          recipient: op.recipient,
        });

        logger.info('Created additional rebalance operation record', {
          requestId,
          earmarkId: earmark.id,
          originChain: op.originChainId,
          txHash: op.receipt.transactionHash,
          bridge: op.bridge,
        });
      } catch (error) {
        // This is a critical error - we have a transaction on-chain but failed to record it
        logger.error('CRITICAL: Failed to create additional rebalance operation record for confirmed transaction', {
          requestId,
          earmarkId: earmark.id,
          operation: op,
          error: jsonifyError(error),
        });
      }
    }
  }

  // Update earmark with new minAmount
  const pool = database.getPool();
  await pool.query('UPDATE earmarks SET "min_amount" = $1, "updated_at" = $2 WHERE id = $3', [
    currentMinAmount,
    new Date(),
    earmark.id,
  ]);

  logger.info('Successfully handled minAmount increase', {
    requestId,
    invoiceId: earmark.invoiceId,
    newMinAmount: currentMinAmount,
  });

  return true;
}

interface RebalanceTransactionResult {
  receipt: database.TransactionReceipt;
  effectiveAmount?: string;
}

interface ExecuteOperationResult {
  success: boolean;
  isSwap: boolean;
  result?: RebalanceTransactionResult;
  recipient?: string;
}

/**
 * Get recipient address for an operation
 */
function getRecipientForOperation(
  operation: PlannedRebalanceOperation,
  config: ProcessingContext['config'],
  logger: ProcessingContext['logger'],
  context: { requestId: string },
): string {
  return getActualAddress(operation.destinationChain, config, logger, context);
}

/**
 * Execute a single rebalancing operation (swap or bridge)
 * Returns structured result for consistent handling by callers
 */
async function executeSingleOperation(
  operation: PlannedRebalanceOperation,
  invoiceId: string,
  destinationChain: number,
  context: ProcessingContext,
  onDemandRoutes: OnDemandRouteConfig[],
): Promise<ExecuteOperationResult | null> {
  const { logger, requestId } = context;

  try {
    if (operation.isSameChainSwap) {
      const swapSucceeded = await executeSameChainSwapOperation(operation, invoiceId, context);

      if (!swapSucceeded) {
        logger.error('Failed to execute same-chain swap operation', {
          requestId,
          invoiceId,
          operation,
        });
        return null;
      }

      return {
        success: true,
        isSwap: true,
      };
    }

    // Bridge operation - routeConfig should always be set when operations are created
    // This is a defensive check in case of unexpected state
    const routeConfig = operation.routeConfig ?? findRouteForOperation(operation, onDemandRoutes);

    if (!routeConfig) {
      logger.error('Route not found for rebalancing operation', { operation });
      return null;
    }

    const recipient = getRecipientForOperation(operation, context.config, logger, { requestId });

    const result = await executeRebalanceTransactionWithBridge(
      routeConfig,
      operation.amount,
      recipient,
      operation.bridge,
      invoiceId,
      context,
    );

    if (!result) {
      logger.warn('Failed to execute rebalancing operation, no transaction returned', {
        requestId,
        operation,
      });
      return null;
    }

    logger.info('On-demand rebalance transaction confirmed', {
      requestId,
      invoiceId,
      transactionHash: result.receipt.transactionHash,
      bridgeType: operation.bridge,
      originChain: operation.originChain,
      amount: result.effectiveAmount || operation.amount,
      originalAmount:
        result.effectiveAmount && result.effectiveAmount !== operation.amount ? operation.amount : undefined,
    });

    return {
      success: true,
      isSwap: false,
      result,
      recipient,
    };
  } catch (error) {
    logger.error('Failed to execute rebalancing operation', {
      requestId,
      operation,
      error: jsonifyError(error),
    });
    return null;
  }
}

async function executeSameChainSwapOperation(
  operation: PlannedRebalanceOperation,
  invoiceId: string,
  context: ProcessingContext,
): Promise<boolean> {
  const { rebalance, logger, requestId, config } = context;

  const adapter = rebalance.getAdapter(operation.bridge);

  if (!adapter || !adapter.executeSwap) {
    logger.error('Swap adapter does not support executeSwap', {
      requestId,
      invoiceId,
      bridgeType: operation.bridge,
      originChain: operation.originChain,
    });
    return false;
  }

  // routeConfig should always be set when operations are created
  // This is a defensive check in case of unexpected state
  if (!operation.routeConfig) {
    logger.error('Route config missing for same-chain swap operation', {
      requestId,
      invoiceId,
      operation,
    });
    return false;
  }

  const route: OnDemandRouteConfig = {
    ...operation.routeConfig,
    preferences: [...(operation.routeConfig.preferences || [])],
    swapPreferences: [...(operation.routeConfig.swapPreferences || [])],
  };

  const sender = getActualAddress(operation.originChain, config, logger, { requestId });
  const recipient = getRecipientForOperation(operation, config, logger, { requestId });

  try {
    const swapResult = await adapter.executeSwap(sender, recipient, operation.amount, route);

    logger.info('Executed same-chain swap operation', {
      requestId,
      invoiceId,
      bridgeType: operation.bridge,
      originChain: operation.originChain,
      destinationChain: operation.destinationChain,
      amount: operation.amount,
      executedSellAmount: swapResult.executedSellAmount,
      executedBuyAmount: swapResult.executedBuyAmount,
      expectedOutputAmount: operation.expectedOutputAmount,
      orderUid: swapResult.orderUid,
    });

    return true;
  } catch (error) {
    logger.error('Failed to execute same-chain swap operation', {
      requestId,
      invoiceId,
      bridgeType: operation.bridge,
      originChain: operation.originChain,
      error: jsonifyError(error),
    });
    return false;
  }
}

/**
 * Execute rebalance transaction with a pre-determined bridge
 */
async function executeRebalanceTransactionWithBridge(
  route: OnDemandRouteConfig,
  amount: string,
  recipient: string,
  bridgeType: SupportedBridge,
  invoiceId: string,
  context: ProcessingContext,
): Promise<RebalanceTransactionResult | undefined> {
  const { logger, rebalance, requestId, config } = context;

  try {
    const sender = getActualAddress(route.origin, config, logger, { requestId });
    const originChainConfig = config.chains[route.origin];
    const zodiacConfig = getValidatedZodiacConfig(originChainConfig, logger, { requestId, route });

    const adapter = rebalance.getAdapter(bridgeType);
    if (!adapter) {
      logger.error('Bridge adapter not found', {
        requestId,
        invoiceId,
        bridgeType,
      });
      return undefined;
    }

    logger.info('Executing on-demand rebalance with pre-determined bridge', {
      requestId,
      invoiceId,
      route,
      bridgeType,
      amount,
      sender,
      recipient,
    });

    // Execute the rebalance transaction
    const bridgeTxRequests = await adapter.send(sender, recipient, amount, route);

    if (bridgeTxRequests && bridgeTxRequests.length > 0) {
      let receipt: database.TransactionReceipt | undefined = undefined;
      let effectiveBridgedAmount = amount; // Default to requested amount

      for (const { transaction, memo, effectiveAmount } of bridgeTxRequests) {
        logger.info('Submitting on-demand rebalance transaction', {
          requestId,
          invoiceId,
          bridgeType,
          memo,
          transaction,
          useZodiac: zodiacConfig.walletType,
        });

        try {
          const result = await submitTransactionWithLogging({
            chainService: context.chainService,
            logger,
            chainId: route.origin.toString(),
            txRequest: {
              to: transaction.to!,
              data: transaction.data!,
              value: (transaction.value || 0).toString(),
              chainId: route.origin,
              from: context.config.ownAddress,
              funcSig: transaction.funcSig || '',
            },
            zodiacConfig,
            context: { requestId, invoiceId, bridgeType, transactionType: memo },
          });

          logger.info('Successfully submitted on-demand rebalance transaction', {
            requestId,
            invoiceId,
            bridgeType,
            memo,
            transactionHash: result.hash,
            useZodiac: zodiacConfig.walletType,
          });

          if (memo === RebalanceTransactionMemo.Rebalance) {
            receipt = result.receipt as unknown as database.TransactionReceipt;
            // Track effective amount if it was capped
            if (effectiveAmount) {
              effectiveBridgedAmount = effectiveAmount;
              logger.info('Using effective bridged amount from adapter', {
                requestId,
                invoiceId,
                originalAmount: amount,
                effectiveAmount: effectiveBridgedAmount,
                bridgeType,
              });
            }
          }
        } catch (txError) {
          logger.error('Failed to submit on-demand rebalance transaction', {
            requestId,
            invoiceId,
            bridgeType,
            memo,
            error: jsonifyError(txError),
          });
          throw txError;
        }
      }

      if (receipt) {
        logger.info('Successfully completed on-demand rebalance transaction', {
          requestId,
          invoiceId,
          bridgeType,
          amount: effectiveBridgedAmount,
          originalAmount: amount !== effectiveBridgedAmount ? amount : undefined,
          route,
          transactionHash: receipt.transactionHash,
          transactionCount: bridgeTxRequests.length,
        });
        return { receipt, effectiveAmount: effectiveBridgedAmount };
      }
    }

    return undefined;
  } catch (error) {
    logger.error('Failed to execute rebalance transaction with bridge', {
      requestId,
      invoiceId,
      bridgeType,
      error: jsonifyError(error),
    });
    return undefined;
  }
}

/**
 * Process pending earmarked invoices
 * - Validates pending earmarks still have valid invoices
 * - Handles minAmount changes (increases/decreases)
 * - Updates earmark statuses based on rebalancing operation completion
 */
export async function processPendingEarmarks(context: ProcessingContext, currentInvoices: Invoice[]): Promise<void> {
  const { logger, requestId } = context;

  try {
    const pendingEarmarks = await database.getEarmarks({ status: EarmarkStatus.PENDING });
    const invoiceMap = new Map<string, Invoice>(currentInvoices.map((inv) => [inv.intent_id, inv]));

    // Process pending earmarks
    for (const earmark of pendingEarmarks) {
      try {
        // Validate invoice still exists
        const invoice = invoiceMap.get(earmark.invoiceId);
        if (!invoice) {
          logger.info('Earmarked invoice not valid anymore', {
            requestId,
            invoiceId: earmark.invoiceId,
          });
          await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);
          continue;
        }

        // Get current minAmount for the designated purchase chain
        const currentMinAmounts = await getMinAmountsForInvoice(earmark.invoiceId, context);
        if (!currentMinAmounts) continue;
        const currentMinAmount = currentMinAmounts[earmark.designatedPurchaseChain.toString()];

        const currentRequiredAmount = BigInt(currentMinAmount);
        const earmarkedAmount = BigInt(earmark.minAmount);

        if (currentRequiredAmount && earmarkedAmount && currentRequiredAmount > earmarkedAmount) {
          // MinAmount increased - see if additional rebalaning is needed
          const handled = await handleMinAmountIncrease(earmark, invoice, currentMinAmount, context);
          if (!handled) {
            await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);
            continue;
          }
        } else if (currentRequiredAmount && earmarkedAmount && currentRequiredAmount < earmarkedAmount) {
          // MinAmount decreased - don't need to do anything
          logger.info('MinAmount decreased, proceeding with original plan', {
            requestId,
            invoiceId: earmark.invoiceId,
            oldMinAmount: earmark.minAmount,
            newMinAmount: currentMinAmount,
          });
        }

        // Check if all operations are complete and update if so
        if (await checkAllOperationsComplete(earmark.id)) {
          logger.info('All rebalance operations complete for earmark', {
            requestId,
            earmarkId: earmark.id,
            invoiceId: earmark.invoiceId,
          });
          await database.updateEarmarkStatus(earmark.id, EarmarkStatus.READY);
        }
      } catch (error) {
        logger.error('Error processing earmarked invoice', {
          requestId,
          earmarkId: earmark.id,
          error: jsonifyError(error),
        });
      }
    }
  } catch (error) {
    logger.error('Failed to process pending earmarks due to database error', {
      requestId,
      error: jsonifyError(error),
    });
  }
}

export async function cleanupCompletedEarmarks(
  purchasedInvoiceIds: string[],
  context: ProcessingContext,
): Promise<void> {
  const { logger, requestId } = context;

  for (const invoiceId of purchasedInvoiceIds) {
    try {
      const earmark = await database.getActiveEarmarkForInvoice(invoiceId);

      if (earmark && earmark.status === EarmarkStatus.READY) {
        await database.updateEarmarkStatus(earmark.id, EarmarkStatus.COMPLETED);

        logger.info('Marked earmark as completed', {
          requestId,
          earmarkId: earmark.id,
          invoiceId,
        });
      }
    } catch (error) {
      logger.error('Error cleaning up earmark', {
        requestId,
        invoiceId,
        error: jsonifyError(error),
      });
    }
  }
}

export async function cleanupStaleEarmarks(invoiceIds: string[], context: ProcessingContext): Promise<void> {
  const { logger, requestId } = context;

  for (const invoiceId of invoiceIds) {
    try {
      const earmark = await database.getActiveEarmarkForInvoice(invoiceId);

      if (earmark) {
        // Mark earmark as cancelled since the invoice is no longer available
        await database.updateEarmarkStatus(earmark.id, EarmarkStatus.CANCELLED);

        logger.info('Marked stale earmark as cancelled', {
          requestId,
          earmarkId: earmark.id,
          invoiceId,
          previousStatus: earmark.status,
        });
      }
    } catch (error) {
      logger.error('Error cleaning up stale earmark', {
        requestId,
        invoiceId,
        error: jsonifyError(error),
      });
    }
  }
}

export async function getEarmarkedBalance(
  chainId: number,
  tickerHash: string,
  context: ProcessingContext,
): Promise<bigint> {
  const { config } = context;

  const ticker = tickerHash.toLowerCase();
  
  // Get earmarked amounts (both pending and ready)
  const earmarks = await database.getEarmarks({
    designatedPurchaseChain: chainId,
    status: [EarmarkStatus.PENDING, EarmarkStatus.READY],
  });
  const earmarkedAmount = earmarks
    .filter((e: database.Earmark) => e.tickerHash.toLowerCase() === ticker)
    .reduce((sum: bigint, e: database.Earmark) => {
      // earmark.minAmount is already stored in standardized 18 decimals from the API
      const amount = BigInt(e.minAmount) || 0n;
      return sum + amount;
    }, 0n);

  // Exclude funds from on-demand operations associated with active earmarks
  // Note: This query loads all operations matching the status filter. Performance is optimized with
  // the idx_rebalance_operations_status_earmark_dest composite index. At expected scale (< 1,000 operations),
  // this performs well (~10-15ms). If scale exceeds 10,000 operations, consider adding chainId filter here.
  const activeEarmarkIds = new Set(earmarks.map((e: database.Earmark) => e.id));
  const { operations: onDemandOps } = await database.getRebalanceOperations(undefined, undefined, {
    status: [
      RebalanceOperationStatus.PENDING,
      RebalanceOperationStatus.AWAITING_CALLBACK,
      RebalanceOperationStatus.COMPLETED,
    ],
  });

  const onDemandFunds = onDemandOps
    .filter(
      (op: database.RebalanceOperation) =>
        op.destinationChainId === chainId &&
        op.tickerHash.toLowerCase() === ticker &&
        op.earmarkId !== null &&
        activeEarmarkIds.has(op.earmarkId),
    )
    .reduce((sum: bigint, op: database.RebalanceOperation) => {
      const decimals = getDecimalsFromConfig(ticker, op.originChainId.toString(), config);
      return sum + convertTo18Decimals(BigInt(op.amount), decimals);
    }, 0n);

  return earmarkedAmount > onDemandFunds ? earmarkedAmount : onDemandFunds;
}
