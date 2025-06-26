import { getMarkBalances, safeStringToBigInt, getTickerForAsset } from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import { getDecimalsFromConfig, WalletType } from '@mark/core';
import { ProcessingContext } from '../init';
import { executeDestinationCallbacks } from './callbacks';
import { formatUnits } from 'viem';
import { RebalanceAction } from '@mark/cache';
import { getValidatedZodiacConfig, getActualOwner } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { RebalanceTransactionMemo } from '@mark/rebalance';

export async function rebalanceInventory(context: ProcessingContext): Promise<void> {
  const { logger, requestId, rebalanceCache, config, chainService, rebalance } = context;
  const isPaused = await rebalanceCache.isPaused();
  if (isPaused) {
    logger.warn('Rebalance loop is paused', { requestId });
    return;
  }

  logger.info('Starting to rebalance inventory', { requestId });

  // Execute any callbacks from cached actions prior to proceeding
  await executeDestinationCallbacks(context);
  logger.debug('Executed destination callbacks');

  // Get all of mark balances
  const balances = await getMarkBalances(config, context.prometheus);
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
    const normalizedBalance = tickerBalances.get(route.origin.toString()) ?? 0n;
    // Ticker balances always in 18 units, convert to proper decimals
    const decimals = getDecimalsFromConfig(ticker, route.origin.toString(), config);
    const currentBalance = BigInt(formatUnits(normalizedBalance, 18 - (decimals ?? 18)));

    logger.debug('Current balance for route', { requestId, route, currentBalance: currentBalance.toString() });

    // Convert route maximum and reserve from standardized 18 decimals to asset's native decimals
    const maximumBalance = BigInt(formatUnits(BigInt(route.maximum), 18 - (decimals ?? 18)));
    const reserveAmount = BigInt(formatUnits(BigInt(route.reserve ?? '0'), 18 - (decimals ?? 18)));
    if (currentBalance <= maximumBalance) {
      logger.info('Balance is at or below maximum, skipping route', {
        requestId,
        route,
        currentBalance: currentBalance.toString(),
        maximum: route.maximum,
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
    logger.info('Attempting to bridge amount', { requestId, route, currentBalance });
    let rebalanceSuccessful = false;
    for (const bridgeType of route.preferences) {
      logger.info('Trying bridge for route', {
        requestId,
        route,
        bridgeType,
        currentBalance: currentBalance.toString(),
      });

      // Get Adapter (Synchronous)
      const adapter = rebalance.getAdapter(bridgeType);
      if (!adapter) {
        logger.warn('Adapter not found for bridge type, trying next preference', { requestId, bridgeType, route });
        continue; // Skip to next bridge preference
      }

      // Step 1: Get Quote
      let receivedAmountStr: string;
      try {
        receivedAmountStr = await adapter.getReceivedAmount(amountToBridge.toString(), route);
        logger.info('Received quote from adapter', { requestId, route, bridgeType, receivedAmountStr });
      } catch (quoteError) {
        logger.error('Failed to get quote from adapter, trying next preference', {
          requestId,
          route,
          bridgeType,
          error: jsonifyError(quoteError),
        });
        continue; // Skip to next bridge preference
      }

      // Step 2: Check Slippage
      const receivedAmount = BigInt(receivedAmountStr);
      const scaleFactor = BigInt(10_000);
      const dbpsDenominator = BigInt(100_000);
      const slippage = safeStringToBigInt(route.slippage.toString(), scaleFactor);
      const slippageScaled = slippage * scaleFactor;
      const minimumAcceptableAmount =
        amountToBridge - (amountToBridge * slippageScaled) / (scaleFactor * dbpsDenominator);

      if (receivedAmount < minimumAcceptableAmount) {
        logger.warn('Quote does not meet slippage requirements, trying next preference', {
          requestId,
          route,
          bridgeType,
          receivedAmount: receivedAmount.toString(),
          minimumAcceptableAmount: minimumAcceptableAmount.toString(),
          amountToBridge: amountToBridge.toString(),
          slippageBPS: route.slippage.toString(),
        });
        continue; // Skip to next bridge preference
      }
      logger.info('Quote meets slippage requirements', {
        requestId,
        route,
        bridgeType,
        receivedAmount: receivedAmount.toString(),
        minimumAcceptableAmount: minimumAcceptableAmount.toString(),
      });

      // Step 3: Get Bridge Transaction Requests
      let bridgeTxRequests = [];
      const sender = getActualOwner(originZodiacConfig, config.ownAddress);
      const recipient = getActualOwner(destinationZodiacConfig, config.ownAddress);
      try {
        bridgeTxRequests = await adapter.send(sender, recipient, amountToBridge.toString(), route);
        logger.info('Prepared bridge transaction request from adapter', {
          requestId,
          route,
          bridgeType,
          bridgeTxRequests,
          sender,
          recipient,
          useOriginZodiac: originZodiacConfig.walletType,
          useDestinationZodiac: destinationZodiacConfig.walletType,
        });
        if (!bridgeTxRequests.length) {
          throw new Error(`Failed to retrieve any bridge transaction requests`);
        }
      } catch (sendError) {
        logger.error('Failed to get bridge transaction request from adapter, trying next preference', {
          requestId,
          route,
          bridgeType,
          error: jsonifyError(sendError),
        });
        continue; // Skip to next bridge preference
      }

      // Step 4: Submit the bridge transactions in order
      // TODO: Use multisend for zodiac-enabled origin transactions
      let idx = -1;
      try {
        let transactionHash: string = '';
        for (const { transaction, memo } of bridgeTxRequests) {
          idx++;
          logger.info('Submitting rebalance transaction bundle', {
            transaction,
            memo,
            requestId,
            route,
            bridgeType,
            useZodiac: originZodiacConfig.walletType,
          });
          const result = await submitTransactionWithLogging({
            chainService,
            logger,
            chainId: route.origin.toString(),
            txRequest: {
              to: transaction.to!,
              data: transaction.data!,
              value: (transaction.value || 0).toString(),
              chainId: route.origin,
              from: config.ownAddress,
            },
            zodiacConfig: originZodiacConfig,
            context: { requestId, route, bridgeType, transactionType: memo },
          });

          logger.info('Successfully submitted and confirmed origin bridge transaction', {
            requestId,
            route,
            bridgeType,
            transactionHash: result.hash,
            memo,
            useZodiac: originZodiacConfig.walletType,
          });

          if (memo !== RebalanceTransactionMemo.Rebalance) {
            continue;
          }
          transactionHash = result.hash;
        }

        // Step 5: Add rebalance action to cache
        const rebalanceAction: RebalanceAction = {
          bridge: adapter.type(),
          amount: amountToBridge.toString(),
          origin: route.origin,
          destination: route.destination,
          asset: route.asset,
          transaction: transactionHash,
          recipient,
        };

        try {
          await rebalanceCache.addRebalances([rebalanceAction]);
          logger.info('Successfully added rebalance action to cache', {
            requestId,
            route,
            bridgeType,
            action: rebalanceAction,
          });
          rebalanceSuccessful = true;
          // If we got here, the rebalance for this route was successful with this bridge.
          break; // Exit the bridge preference loop for this route
        } catch (cacheError) {
          logger.error('Failed to add rebalance action to cache. Transaction was sent, but caching failed.', {
            requestId,
            route,
            bridgeType,
            transactionHash,
            error: jsonifyError(cacheError),
            rebalanceAction,
            transaction: bridgeTxRequests[idx],
          });
          // Consider this a success for the route as funds were moved. Exit bridge loop.
          rebalanceSuccessful = true;
          break; // Exit the bridge preference loop for this route
        }
      } catch (sendError) {
        logger.error('Failed to send or monitor bridge transaction, trying next preference', {
          requestId,
          route,
          bridgeType,
          transaction: bridgeTxRequests[idx],
          error: jsonifyError(sendError),
        });
        continue; // Skip to next bridge preference
      }
    } // End of bridge preference loop

    // Log overall route success/failure
    if (rebalanceSuccessful) {
      logger.info('Rebalance successful for route', { requestId, route });
    } else {
      logger.warn('Failed to rebalance route with any preferred bridge', { requestId, route });
    }
  } // End of route loop

  logger.info('Completed rebalancing inventory', { requestId });
}
