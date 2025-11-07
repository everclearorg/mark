import {
  DBPS_MULTIPLIER,
  OnDemandRouteConfig,
  SupportedBridge,
  getTokenAddressFromConfig,
  getDecimalsFromConfig,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { convertTo18Decimals, convertToNativeUnits, getTickerForAsset } from './asset';
import { jsonifyError } from '@mark/logger';

export interface PlannedRebalanceOperation {
  originChain: number;
  destinationChain: number;
  amount: string;
  bridge: SupportedBridge;
  slippage: number;
  inputAsset: string;
  outputAsset: string;
  inputTicker?: string;
  outputTicker?: string;
  isSameChainSwap?: boolean;
  expectedOutputAmount?: string;
  routeConfig: OnDemandRouteConfig;
}

export type RouteEntry = {
  route: OnDemandRouteConfig;
  inputTicker?: string;
  outputTicker?: string;
  priority: number;
};

export type PlannedOperationResult = {
  operation: PlannedRebalanceOperation;
  producedAmount: bigint;
};

export type PlannedOperationPairResult = {
  operations: PlannedRebalanceOperation[];
  producedAmount: bigint;
};

const ACROSS_SLIPPAGE_HEADROOM_DBPS = 10n;

export function isSameChainSwapRoute(route: OnDemandRouteConfig): boolean {
  if (!route.destinationAsset) {
    return false;
  }
  return route.origin === route.destination && route.asset.toLowerCase() !== route.destinationAsset.toLowerCase();
}

export function isSwapBridgeRoute(route: OnDemandRouteConfig): boolean {
  if (!route.destinationAsset) {
    return false;
  }
  return route.origin !== route.destination && route.asset.toLowerCase() !== route.destinationAsset.toLowerCase();
}

export function isDirectBridgeRoute(route: OnDemandRouteConfig): boolean {
  return !route.destinationAsset || route.asset.toLowerCase() === route.destinationAsset.toLowerCase();
}

export function getRoutePriority(route: OnDemandRouteConfig): number {
  if (isSameChainSwapRoute(route)) {
    return 0;
  }
  if (isDirectBridgeRoute(route)) {
    return 1;
  }
  if (isSwapBridgeRoute(route)) {
    return 2;
  }
  return 3;
}

export function adjustSwapBridgeAmounts(params: {
  remainingNeeded: bigint;
  swapInputNative: bigint;
  swapOutputNative: bigint;
  bridgeSendNative: bigint;
  bridgeOutputIn18: bigint;
}): {
  producedAmount: bigint;
  adjustedSwapInputNative: bigint;
  adjustedSwapOutputNative: bigint;
  adjustedBridgeSendNative: bigint;
} {
  const { remainingNeeded, swapInputNative, swapOutputNative, bridgeSendNative, bridgeOutputIn18 } = params;

  if (bridgeOutputIn18 === 0n) {
    return {
      producedAmount: 0n,
      adjustedSwapInputNative: 0n,
      adjustedSwapOutputNative: 0n,
      adjustedBridgeSendNative: 0n,
    };
  }

  const producedAmount = bridgeOutputIn18 <= remainingNeeded ? bridgeOutputIn18 : remainingNeeded;

  if (producedAmount === bridgeOutputIn18) {
    return {
      producedAmount,
      adjustedSwapInputNative: swapInputNative,
      adjustedSwapOutputNative: swapOutputNative,
      adjustedBridgeSendNative: bridgeSendNative,
    };
  }

  const scaleAmount = (value: bigint, numerator: bigint, denominator: bigint): bigint => {
    if (value === 0n || numerator === 0n) {
      return 0n;
    }

    let scaled = (value * numerator) / denominator;
    if (scaled <= 0n) {
      scaled = 1n;
    }
    return scaled;
  };

  const adjustedBridgeSendNative = scaleAmount(bridgeSendNative, producedAmount, bridgeOutputIn18);
  const adjustedSwapOutputNative = scaleAmount(swapOutputNative, producedAmount, bridgeOutputIn18);
  const adjustedSwapInputNative = scaleAmount(swapInputNative, adjustedSwapOutputNative, swapOutputNative);

  return {
    producedAmount,
    adjustedSwapInputNative,
    adjustedSwapOutputNative,
    adjustedBridgeSendNative,
  };
}

export async function planSameChainSwap(
  entry: RouteEntry,
  availableOnOrigin: bigint,
  remainingNeeded: bigint,
  context: ProcessingContext,
): Promise<PlannedOperationResult | null> {
  const { route, inputTicker, outputTicker } = entry;
  const { rebalance, config, logger } = context;

  if (!route.destinationAsset || !route.swapPreferences?.length || !inputTicker || !outputTicker) {
    return null;
  }

  const swapBridge = route.swapPreferences[0];
  const adapter = rebalance.getAdapter(swapBridge);

  if (!adapter || !adapter.getReceivedAmount) {
    logger.debug('Swap adapter not available for route', { route, swapBridge });
    return null;
  }

  const originDecimals = getDecimalsFromConfig(inputTicker, route.origin.toString(), config);
  const destinationDecimals = getDecimalsFromConfig(outputTicker, route.destination.toString(), config);

  if (!originDecimals || !destinationDecimals) {
    logger.debug('Missing decimals for same-chain swap route', { route });
    return null;
  }

  const availableNative = convertToNativeUnits(availableOnOrigin, originDecimals);
  if (availableNative <= 0n) {
    return null;
  }

  const remainingNeededNative = convertToNativeUnits(remainingNeeded, destinationDecimals);
  if (remainingNeededNative <= 0n) {
    return null;
  }

  const maxSwapSlippage = route.slippagesDbps?.[0] ?? 1000;

  // Calculate the required swap input accounting for slippage upfront
  // This ensures we get at least remainingNeeded even with worst-case slippage
  const slippageDivisor = DBPS_MULTIPLIER - BigInt(maxSwapSlippage);
  const requiredSwapNative =
    slippageDivisor > 0n
      ? (remainingNeededNative * DBPS_MULTIPLIER + (slippageDivisor - 1n)) / slippageDivisor
      : remainingNeededNative;

  // Start with the slippage-adjusted amount, but cap at available balance
  let swapAmountNative = availableNative < requiredSwapNative ? availableNative : requiredSwapNative;
  if (swapAmountNative <= 0n) {
    return null;
  }

  // Get quote with the slippage-adjusted amount
  let swapQuote = await adapter.getReceivedAmount(swapAmountNative.toString(), route);
  let swapOutputNative = BigInt(swapQuote);
  if (swapOutputNative <= 0n) {
    return null;
  }

  let inputIn18 = convertTo18Decimals(swapAmountNative, originDecimals);
  let outputIn18 = convertTo18Decimals(swapOutputNative, destinationDecimals);
  if (inputIn18 <= 0n || outputIn18 <= 0n) {
    return null;
  }

  // Check if we need to scale up to meet the minimum requirement
  // This can happen if the actual quote is worse than the slippage-adjusted estimate
  const swapSlippage = ((inputIn18 - outputIn18) * DBPS_MULTIPLIER) / inputIn18;
  const needsMore = outputIn18 < remainingNeeded;

  if (needsMore && swapSlippage <= BigInt(maxSwapSlippage)) {
    // Scale up proportionally: if we got outputIn18 from swapAmountNative,
    // we need scaleFactor * swapAmountNative to get remainingNeeded
    // Scale factor = remainingNeeded / outputIn18 (with some safety margin for slippage)
    const requiredOutput = (remainingNeeded * DBPS_MULTIPLIER + (slippageDivisor - 1n)) / slippageDivisor;
    const scaleFactor = (requiredOutput * DBPS_MULTIPLIER + (outputIn18 - 1n)) / outputIn18;
    const scaledSwapAmountNative =
      (swapAmountNative * scaleFactor + (10n ** BigInt(originDecimals) - 1n)) / 10n ** BigInt(originDecimals);

    // Cap at available balance
    const newSwapAmountNative = scaledSwapAmountNative < availableNative ? scaledSwapAmountNative : availableNative;

    if (newSwapAmountNative > swapAmountNative && newSwapAmountNative <= availableNative) {
      // Get new quote with scaled amount
      swapQuote = await adapter.getReceivedAmount(newSwapAmountNative.toString(), route);
      swapOutputNative = BigInt(swapQuote);
      if (swapOutputNative > 0n) {
        swapAmountNative = newSwapAmountNative;
        inputIn18 = convertTo18Decimals(swapAmountNative, originDecimals);
        outputIn18 = convertTo18Decimals(swapOutputNative, destinationDecimals);
        if (inputIn18 <= 0n || outputIn18 <= 0n) {
          return null;
        }
      }
    }
  }

  // Final checks: ensure we got enough and slippage is acceptable
  if (outputIn18 < remainingNeeded) {
    logger.debug('Swap output insufficient after optimization', {
      route,
      outputIn18: outputIn18.toString(),
      remainingNeeded: remainingNeeded.toString(),
    });
    return null;
  }

  const finalSwapSlippage = ((inputIn18 - outputIn18) * DBPS_MULTIPLIER) / inputIn18;
  if (finalSwapSlippage > BigInt(maxSwapSlippage)) {
    logger.debug('Swap slippage exceeds tolerance', {
      route,
      swapSlippage: finalSwapSlippage.toString(),
      maxSwapSlippage,
    });
    return null;
  }

  // For accounting purposes, we cap at remainingNeeded
  // But for bridge planning in swap+bridge routes, we need the actual output
  const producedAmount = outputIn18 <= remainingNeeded ? outputIn18 : remainingNeeded;
  const operation: PlannedRebalanceOperation = {
    originChain: route.origin,
    destinationChain: route.destination,
    amount: swapAmountNative.toString(),
    bridge: swapBridge,
    slippage: maxSwapSlippage,
    inputAsset: route.asset,
    outputAsset: route.destinationAsset,
    inputTicker,
    outputTicker,
    isSameChainSwap: true,
    // Store the actual quote output (not capped) for use in swap+bridge planning
    // The producedAmount is capped for accounting, but expectedOutputAmount should be actual
    expectedOutputAmount: outputIn18.toString(),
    routeConfig: route,
  };

  return {
    operation,
    producedAmount,
  };
}

export async function planDirectBridgeRoute(
  entry: RouteEntry,
  availableOnOrigin: bigint,
  invoiceTicker: string,
  remainingNeeded: bigint,
  context: ProcessingContext,
): Promise<PlannedOperationResult | null> {
  const { route, inputTicker } = entry;
  const { rebalance, config, logger } = context;

  if (!inputTicker) {
    return null;
  }

  const originDecimals = getDecimalsFromConfig(inputTicker, route.origin.toString(), config);
  const destinationDecimals = getDecimalsFromConfig(invoiceTicker, route.destination.toString(), config);

  if (!originDecimals || !destinationDecimals) {
    logger.debug('Missing decimals for direct bridge route', { route });
    return null;
  }

  for (let bridgeIndex = 0; bridgeIndex < route.preferences.length; bridgeIndex++) {
    const bridgeType = route.preferences[bridgeIndex];
    const adapter = rebalance.getAdapter(bridgeType);

    if (!adapter) {
      logger.debug('Adapter not found for bridge route', { route, bridgeType });
      continue;
    }

    try {
      const configuredSlippage = route.slippagesDbps?.[bridgeIndex] ?? 1000;
      let maxSlippage = BigInt(configuredSlippage);

      if (bridgeType === SupportedBridge.Across) {
        if (maxSlippage <= ACROSS_SLIPPAGE_HEADROOM_DBPS) {
          logger.debug('Across route skipped, insufficient slippage budget after headroom', {
            route,
            configuredSlippage,
          });
          continue;
        }
        maxSlippage -= ACROSS_SLIPPAGE_HEADROOM_DBPS;
      }

      const slippageDivisor = DBPS_MULTIPLIER - maxSlippage;
      if (slippageDivisor <= 0n) {
        logger.debug('Invalid slippage divisor for route', { route, maxSlippage: maxSlippage.toString() });
        continue;
      }

      const estimatedAmountToSend = (remainingNeeded * DBPS_MULTIPLIER) / slippageDivisor;
      const amountToTry = estimatedAmountToSend < availableOnOrigin ? estimatedAmountToSend : availableOnOrigin;

      const nativeAmountBigInt = convertToNativeUnits(amountToTry, originDecimals);
      if (nativeAmountBigInt <= 0n) {
        continue;
      }

      const nativeAmount = nativeAmountBigInt.toString();
      const receivedAmountStr = await adapter.getReceivedAmount(nativeAmount, route);
      const receivedIn18Decimals = convertTo18Decimals(BigInt(receivedAmountStr), destinationDecimals);
      const sentIn18Decimals = convertTo18Decimals(nativeAmountBigInt, originDecimals);

      if (sentIn18Decimals === 0n || receivedIn18Decimals === 0n) {
        continue;
      }

      const slippageDbps = ((sentIn18Decimals - receivedIn18Decimals) * DBPS_MULTIPLIER) / sentIn18Decimals;
      if (slippageDbps > maxSlippage) {
        logger.debug('Bridge slippage exceeds tolerance', {
          route,
          bridgeType,
          slippageDbps: slippageDbps.toString(),
          maxSlippage: maxSlippage.toString(),
        });
        continue;
      }

      let producedAmount = receivedIn18Decimals <= remainingNeeded ? receivedIn18Decimals : remainingNeeded;
      let adjustedNativeAmount = nativeAmountBigInt;
      let finalReceivedIn18Decimals = receivedIn18Decimals;

      // If we got more than needed, scale down and re-quote to get accurate rate
      // (Slippage is a function of amount, so we can't assume the rate is constant)
      if (producedAmount < receivedIn18Decimals) {
        adjustedNativeAmount = (nativeAmountBigInt * producedAmount) / receivedIn18Decimals;
        if (adjustedNativeAmount <= 0n) {
          adjustedNativeAmount = 1n;
        }

        // Re-quote with the scaled-down amount to get accurate rate
        // Add a small buffer (same as Across headroom) to account for potential rate changes
        // This ensures we get enough even if the rate is slightly worse for smaller amounts
        const bufferDbps = ACROSS_SLIPPAGE_HEADROOM_DBPS; // 10 dbps = 0.01%
        const bufferDivisor = DBPS_MULTIPLIER - bufferDbps;
        const bufferedNativeAmount = (adjustedNativeAmount * DBPS_MULTIPLIER + (bufferDivisor - 1n)) / bufferDivisor;
        const bufferedNativeAmountCapped =
          bufferedNativeAmount < nativeAmountBigInt ? bufferedNativeAmount : nativeAmountBigInt;

        if (bufferedNativeAmountCapped > 0n) {
          try {
            const reQuoteReceivedStr = await adapter.getReceivedAmount(bufferedNativeAmountCapped.toString(), route);
            const reQuoteReceivedIn18 = convertTo18Decimals(BigInt(reQuoteReceivedStr), destinationDecimals);
            const reQuoteSentIn18 = convertTo18Decimals(bufferedNativeAmountCapped, originDecimals);

            if (reQuoteReceivedIn18 >= remainingNeeded && reQuoteSentIn18 > 0n) {
              // Re-quote is sufficient, use it
              adjustedNativeAmount = bufferedNativeAmountCapped;
              finalReceivedIn18Decimals = reQuoteReceivedIn18;
              producedAmount = remainingNeeded;

              // Verify slippage is still acceptable
              const reQuoteSlippage = ((reQuoteSentIn18 - reQuoteReceivedIn18) * DBPS_MULTIPLIER) / reQuoteSentIn18;
              if (reQuoteSlippage > maxSlippage) {
                logger.debug('Re-quote slippage exceeds tolerance after scaling', {
                  route,
                  bridgeType,
                  slippageDbps: reQuoteSlippage.toString(),
                  maxSlippage: maxSlippage.toString(),
                });
                continue; // Try next bridge preference
              }
            } else if (reQuoteReceivedIn18 > 0n) {
              // Re-quote gives less than needed, but we can still use the original quote
              // (fall back to original, but use scaled amount)
              finalReceivedIn18Decimals = reQuoteReceivedIn18;
              producedAmount = reQuoteReceivedIn18 <= remainingNeeded ? reQuoteReceivedIn18 : remainingNeeded;
            }
          } catch (reQuoteError) {
            // If re-quote fails, fall back to using scaled amount with original rate assumption
            logger.debug('Re-quote failed after scaling, using original rate assumption', {
              route,
              bridgeType,
              error: jsonifyError(reQuoteError),
            });
          }
        }
      }

      const destinationAssetAddress =
        getTokenAddressFromConfig(invoiceTicker, route.destination.toString(), config) ??
        route.destinationAsset ??
        route.asset;

      const operation: PlannedRebalanceOperation = {
        originChain: route.origin,
        destinationChain: route.destination,
        amount: adjustedNativeAmount.toString(),
        bridge: bridgeType,
        slippage: Number(maxSlippage),
        inputAsset: route.asset,
        outputAsset: destinationAssetAddress,
        inputTicker,
        outputTicker: invoiceTicker,
        expectedOutputAmount: finalReceivedIn18Decimals.toString(),
        routeConfig: route,
      };

      return {
        operation,
        producedAmount,
      };
    } catch (error) {
      logger.debug('Failed to evaluate direct bridge route', {
        route,
        bridgeType,
        error: jsonifyError(error),
      });
      continue;
    }
  }

  return null;
}

export async function planSwapBridgeRoute(
  entry: RouteEntry,
  availableOnOrigin: bigint,
  invoiceTicker: string,
  remainingNeeded: bigint,
  context: ProcessingContext,
): Promise<PlannedOperationPairResult | null> {
  const { route, inputTicker, outputTicker } = entry;
  const { rebalance, config, logger } = context;

  if (!route.destinationAsset || !route.swapPreferences?.length || route.preferences.length === 0) {
    return null;
  }

  const swapTicker = getTickerForAsset(route.asset, route.origin, config)?.toLowerCase();
  const postSwapTicker = getTickerForAsset(route.destinationAsset, route.origin, config)?.toLowerCase();
  const invoiceTickerLower = invoiceTicker.toLowerCase();

  if (!swapTicker || !postSwapTicker || !inputTicker || !outputTicker) {
    return null;
  }

  const swapRouteEntry: RouteEntry = {
    route: {
      ...route,
      destination: route.origin,
      preferences: [],
    },
    inputTicker: swapTicker,
    outputTicker: postSwapTicker,
    priority: 0,
  };

  const postSwapDecimals = getDecimalsFromConfig(postSwapTicker, route.origin.toString(), config);
  const destinationDecimals = getDecimalsFromConfig(invoiceTickerLower, route.destination.toString(), config);

  if (!postSwapDecimals || !destinationDecimals) {
    logger.debug('Missing decimals for swap+bridge route', {
      route,
      postSwapTicker,
      invoiceTicker: invoiceTickerLower,
    });
    return null;
  }

  // Work backwards from the final requirement, accounting for both swap and bridge slippage:
  // 1. Final needed: remainingNeeded on destination chain
  // 2. After bridge slippage: we need more on origin chain to account for bridge fees/slippage
  // 3. After swap slippage: we need even more USDC to account for swap slippage
  //
  // First, estimate how much we need on origin chain (after swap) to get remainingNeeded after bridge
  const bridgeSlippage = route.slippagesDbps?.[0] ?? 1000;
  let maxBridgeSlippage = BigInt(bridgeSlippage);

  // Check if Across bridge (has headroom)
  const firstBridgeType = route.preferences[0];
  if (firstBridgeType === SupportedBridge.Across) {
    if (maxBridgeSlippage <= ACROSS_SLIPPAGE_HEADROOM_DBPS) {
      logger.debug('Across route skipped, insufficient slippage budget after headroom', {
        route,
        configuredSlippage: bridgeSlippage,
      });
      return null;
    }
    maxBridgeSlippage -= ACROSS_SLIPPAGE_HEADROOM_DBPS;
  }

  const bridgeSlippageDivisor = DBPS_MULTIPLIER - maxBridgeSlippage;
  if (bridgeSlippageDivisor <= 0n) {
    logger.debug('Invalid bridge slippage divisor for swap+bridge route', {
      route,
      maxBridgeSlippage: maxBridgeSlippage.toString(),
    });
    return null;
  }

  // Calculate how much we need on origin chain (after swap) to get remainingNeeded after bridge
  // Formula: neededAfterSwap = remainingNeeded / (1 - bridgeSlippage)
  const neededAfterSwap = (remainingNeeded * DBPS_MULTIPLIER + (bridgeSlippageDivisor - 1n)) / bridgeSlippageDivisor;

  // Now plan the swap to get at least neededAfterSwap on origin chain
  const swapResult = await planSameChainSwap(swapRouteEntry, availableOnOrigin, neededAfterSwap, context);
  if (!swapResult) {
    return null;
  }

  const swapOperation = swapResult.operation;
  // Use the actual quote output (not capped) for bridge planning
  const swapProduced = BigInt(swapOperation.expectedOutputAmount || swapResult.producedAmount.toString());

  const bridgeRoute: OnDemandRouteConfig = {
    asset: route.destinationAsset,
    origin: route.origin,
    destination: route.destination,
    slippagesDbps: route.slippagesDbps,
    preferences: route.preferences,
    reserve: route.reserve,
  };

  const bridgeEntry: RouteEntry = {
    route: bridgeRoute,
    inputTicker: postSwapTicker,
    outputTicker: invoiceTickerLower,
    priority: 1,
  };

  // For swap+bridge routes, we want to bridge the FULL swap output to maximize final amount
  // So we pass a very large remainingNeeded to prevent planDirectBridgeRoute from scaling down
  // We'll handle the final scaling in adjustSwapBridgeAmounts if needed
  const bridgeResult = await planDirectBridgeRoute(
    bridgeEntry,
    swapProduced,
    invoiceTickerLower,
    swapProduced,
    context,
  );
  if (!bridgeResult) {
    return null;
  }

  const { producedAmount, operation: bridgeOperation } = bridgeResult;

  // Use the actual bridge output (not capped) for final calculation
  // The bridgeOperation.expectedOutputAmount contains the actual quote output
  const actualBridgeOutput = BigInt(bridgeOperation.expectedOutputAmount || producedAmount.toString());

  const adjusted = adjustSwapBridgeAmounts({
    remainingNeeded,
    swapInputNative: BigInt(swapOperation.amount),
    swapOutputNative: convertToNativeUnits(swapProduced, postSwapDecimals),
    bridgeSendNative: BigInt(bridgeOperation.amount),
    bridgeOutputIn18: actualBridgeOutput,
  });

  swapOperation.amount = adjusted.adjustedSwapInputNative.toString();
  swapOperation.expectedOutputAmount = adjusted.adjustedSwapOutputNative
    ? convertTo18Decimals(adjusted.adjustedSwapOutputNative, postSwapDecimals).toString()
    : swapOperation.expectedOutputAmount;

  bridgeOperation.amount = adjusted.adjustedBridgeSendNative.toString();
  bridgeOperation.expectedOutputAmount = producedAmount.toString();

  return {
    operations: [swapOperation, bridgeOperation],
    producedAmount,
  };
}
