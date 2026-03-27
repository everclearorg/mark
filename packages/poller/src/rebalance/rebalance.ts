import { getMarkBalances, getTickerForAsset, convertToNativeUnits } from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import {
  getDecimalsFromConfig,
  getTokenAddressFromConfig,
  WalletType,
  RebalanceOperationStatus,
  DBPS_MULTIPLIER,
  RebalanceAction,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { executeDestinationCallbacks } from './callbacks';
import { getValidatedZodiacConfig, getActualAddress } from '../helpers/zodiac';
import { getEarmarkedBalance } from './onDemand';
import { executeEvmBridge } from './bridgeExecution';

export async function rebalanceInventory(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, chainService, rebalance } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  // Always check destination callbacks to ensure operations complete
  await executeDestinationCallbacks(context);

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('Rebalance loop is paused', { requestId });
    return rebalanceOperations;
  }

  logger.info('Starting to rebalance inventory', { requestId });

  // Get all of mark balances
  const balances = await getMarkBalances(config, chainService, context.prometheus, context.inventory);
  logger.debug('Retrieved all mark balances', { balances: jsonifyMap(balances) });

  // For each route that is configured,
  for (const route of config.routes) {
    // if the balance is below the maximum, continue

    // for each bridge in preferences
    // try to get a quote, if failed go to the next preferred bridge
    // if the amount received exceeds the configured slippage, go to the next preferred bridge
    // otherwise, call `send` and submit return transaction (approving token if necessary)
    // add the rebalance action to the cache with the origin transaction hash
    logger.info('Processing route', { requestId, route });

    // Check for Zodiac configuration on origin chain (for sender)
    const originChainConfig = config.chains[route.origin];
    const originZodiacConfig = getValidatedZodiacConfig(originChainConfig, logger, { requestId, route });

    // Check for Zodiac configuration on destination chain (for recipient)
    const destinationChainConfig = config.chains[route.destination];
    const destinationZodiacConfig = getValidatedZodiacConfig(destinationChainConfig, logger, { requestId });

    if (originZodiacConfig.walletType !== WalletType.EOA) {
      logger.info('Using Zodiac configuration for rebalance route origin chain', {
        requestId,
        route,
        originChain: route.origin,
        zodiacRoleModuleAddress: originZodiacConfig.moduleAddress,
        zodiacRoleKey: originZodiacConfig.roleKey,
        gnosisSafeAddress: originZodiacConfig.safeAddress,
      });
    }

    if (destinationZodiacConfig.walletType !== WalletType.EOA) {
      logger.info('Using Zodiac configuration for rebalance route destination chain', {
        requestId,
        route,
        destinationChain: route.destination,
        zodiacRoleModuleAddress: destinationZodiacConfig.moduleAddress,
        zodiacRoleKey: destinationZodiacConfig.roleKey,
        gnosisSafeAddress: destinationZodiacConfig.safeAddress,
      });
    }

    // --- Route Level Checks (Synchronous or handled internally) ---
    const ticker = getTickerForAsset(route.asset, route.origin, config);
    if (!ticker) {
      logger.error(`Ticker not found for asset, check config`, {
        config: config.chains[route.origin],
        route,
      });
      continue;
    }
    const tickerBalances = balances.get(ticker.toLowerCase());
    if (!tickerBalances) {
      logger.warn('No balances found for ticker, skipping route', { requestId, route, ticker });
      continue; // Skip to next route
    }

    // Get balance minus earmarked funds.
    // When inventory service provides the balance, it already accounts for all reservations
    // (from both Mark and fill service), so we skip the earmark subtraction to avoid double-counting.
    const rawBalance = tickerBalances.get(route.origin.toString()) || 0n;
    const availableBalance = context.inventory
      ? rawBalance
      : rawBalance - await getEarmarkedBalance(route.origin, ticker, context);

    // Ticker balances always in 18 units, convert to proper decimals
    const decimals = getDecimalsFromConfig(ticker, route.origin.toString(), config);
    const currentBalance = convertToNativeUnits(availableBalance, decimals);

    logger.debug('Current balance for route', { requestId, route, currentBalance: currentBalance.toString() });

    // Convert route maximum and reserve from standardized 18 decimals to asset's native decimals
    const maximumBalance = convertToNativeUnits(BigInt(route.maximum), decimals);
    const reserveAmount = convertToNativeUnits(BigInt(route.reserve ?? '0'), decimals);
    if (currentBalance <= maximumBalance) {
      logger.info('Balance is at or below maximum, skipping route', {
        requestId,
        route,
        currentBalance: currentBalance.toString(),
        maximumThreshold: maximumBalance.toString(),
      });
      continue; // Skip to next route
    }

    // Calculate amount to bridge (total balance minus reserve)
    const amountToBridge = currentBalance - reserveAmount;
    if (amountToBridge <= 0n) {
      logger.info('Amount to bridge after reserve is zero or negative, skipping route', {
        requestId,
        route,
        currentBalance: currentBalance.toString(),
        reserveAmount: reserveAmount.toString(),
        amountToBridge: amountToBridge.toString(),
      });
      continue;
    }

    // --- Bridge Preference Loop ---
    let rebalanceSuccessful = false;
    for (let bridgeIndex = 0; bridgeIndex < route.preferences.length; bridgeIndex++) {
      const bridgeType = route.preferences[bridgeIndex];
      logger.info('Attempting to bridge', {
        requestId,
        route,
        bridgeType,
        amountToBridge: amountToBridge.toString(),
      });

      // Get Adapter (Synchronous)
      const adapter = rebalance.getAdapter(bridgeType);
      if (!adapter) {
        logger.warn('Adapter not found for bridge type, trying next preference', {
          requestId,
          route,
          bridgeType,
        });
        continue; // Skip to next bridge preference
      }

      const sender = getActualAddress(route.origin, config, logger, { requestId });
      const recipient = getActualAddress(route.destination, config, logger, { requestId });

      const { inventory } = context;
      let thresholdReservationId: string | undefined;
      try {
        // Create REBALANCE_THRESHOLD reservation via inventory service
        if (inventory) {
          const tickerForRoute = getTickerForAsset(route.asset, route.origin, config) || route.asset;
          const tickerAddress = getTokenAddressFromConfig(tickerForRoute, route.origin.toString(), config);
          const reservation = await inventory.createReservation({
            chainId: route.origin.toString(),
            asset: tickerAddress || route.asset,
            amount: amountToBridge.toString(),
            operationType: 'REBALANCE_THRESHOLD',
            operationId: `threshold-${route.origin}-${route.destination}-${Date.now()}`,
            requestedBy: 'mark',
            ttlSeconds: 3600,
            metadata: {
              bridge: bridgeType,
              origin: route.origin.toString(),
              destination: route.destination.toString(),
            },
          });
          if (reservation) {
            thresholdReservationId = reservation.id;
            await inventory.updateReservationStatus(reservation.id, 'EXECUTING');
          } else {
            // Inventory service rejected the reservation (insufficient balance or unavailable).
            // Skip this bridge attempt — another service may have reserved the funds.
            logger.warn('Inventory reservation failed for threshold rebalance, skipping bridge', {
              requestId,
              route,
              bridgeType,
              amountToBridge: amountToBridge.toString(),
            });
            continue;
          }
        }

        const result = await executeEvmBridge({
          context,
          adapter,
          route,
          amount: amountToBridge,
          sender,
          recipient,
          slippageTolerance: BigInt(route.slippagesDbps[bridgeIndex]),
          slippageMultiplier: DBPS_MULTIPLIER,
          chainService,
          zodiacConfig: originZodiacConfig,
          dbRecord: {
            earmarkId: null,
            tickerHash: getTickerForAsset(route.asset, route.origin, config) || route.asset,
            bridgeTag: bridgeType,
            status: RebalanceOperationStatus.PENDING,
          },
          label: `route ${route.origin}->${route.destination}`,
        });

        if (result.actions.length > 0) {
          rebalanceOperations.push(...result.actions);
          rebalanceSuccessful = true;
          // Mark reservation as completed
          if (inventory && thresholdReservationId) {
            await inventory.updateReservationStatus(thresholdReservationId, 'COMPLETED');
          }
          break; // Exit the bridge preference loop for this route
        }
        // Empty actions means quote/slippage failure — release reservation and try next preference
        if (inventory && thresholdReservationId) {
          await inventory.updateReservationStatus(thresholdReservationId, 'FAILED', {
            reason: 'quote_slippage_failure',
          });
        }
        continue;
      } catch (error) {
        // Release reservation on bridge execution failure
        if (inventory && thresholdReservationId) {
          await inventory.updateReservationStatus(thresholdReservationId, 'FAILED', {
            reason: 'bridge_execution_error',
          });
        }
        logger.error('Failed to execute bridge, trying next preference', {
          requestId,
          route,
          bridgeType,
          amountToBridge: amountToBridge.toString(),
          error: jsonifyError(error),
        });
        continue;
      }
    } // End of bridge preference loop

    // Log overall route success/failure
    if (rebalanceSuccessful) {
      logger.info('Rebalance successful for route', {
        requestId,
        route,
        finalBalance: currentBalance,
        amountToBridge: amountToBridge,
      });
    } else {
      logger.warn('Failed to rebalance route with any preferred bridge', {
        requestId,
        route,
        amountToBridge: amountToBridge,
        bridgesAttempted: route.preferences,
      });
    }
  } // End of route loop

  logger.info('Completed rebalancing inventory', { requestId });
  return rebalanceOperations;
}
