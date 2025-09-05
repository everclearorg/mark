import { getMarkBalances, getTickerForAsset, convertToNativeUnits } from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import { getDecimalsFromConfig, isSvmChain, isTvmChain, DBPS_MULTIPLIER, RebalanceOperationStatus } from '@mark/core';
import { ProcessingContext } from '../init';
import { executeDestinationCallbacks } from './callbacks';
import { RebalanceAction } from '@mark/cache';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { RebalanceTransactionMemo } from '@mark/rebalance';
import { getAvailableBalanceLessEarmarks } from './onDemand';
import { createRebalanceOperation, TransactionReceipt } from '@mark/database';

export async function rebalanceInventory(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, purchaseCache, config, chainService, rebalance } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('Rebalance loop is paused', { requestId });
    return rebalanceOperations;
  }

  logger.info('Starting to rebalance inventory', { requestId });

  // Only execute callbacks if purchase cache is paused
  const isPurchasePaused = await purchaseCache.isPaused();
  if (isPurchasePaused) {
    await executeDestinationCallbacks(context);
  }

  // Get all of mark balances
  const balances = await getMarkBalances(config, chainService, context.prometheus);
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

    // Get balance minus earmarked funds
    const availableBalance = await getAvailableBalanceLessEarmarks(route.origin, ticker, context);

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

      // Step 1: Get Quote
      let receivedAmountStr: string;
      try {
        receivedAmountStr = await adapter.getReceivedAmount(amountToBridge.toString(), route);
        logger.info('Received quote from adapter', {
          requestId,
          route,
          bridgeType,
          amountToBridge: amountToBridge.toString(),
          receivedAmount: receivedAmountStr,
        });
      } catch (quoteError) {
        logger.error('Failed to get quote from adapter, trying next preference', {
          requestId,
          route,
          bridgeType,
          amountToBridge: amountToBridge.toString(),
          error: jsonifyError(quoteError),
        });
        continue; // Skip to next bridge preference
      }

      // Step 2: Check Slippage
      const receivedAmount = BigInt(receivedAmountStr);
      const slippageDbps = BigInt(route.slippagesDbps[bridgeIndex]);
      const minimumAcceptableAmount = amountToBridge - (amountToBridge * slippageDbps) / DBPS_MULTIPLIER;

      const actualSlippageDbps = ((amountToBridge - receivedAmount) * DBPS_MULTIPLIER) / amountToBridge;

      if (receivedAmount < minimumAcceptableAmount) {
        logger.warn('Quote does not meet slippage requirements, trying next preference', {
          requestId,
          route,
          bridgeType,
          amountToBridge: amountToBridge.toString(),
          receivedAmount: receivedAmount.toString(),
          minimumAcceptableAmount: minimumAcceptableAmount.toString(),
          slippageDbps: slippageDbps.toString(),
          actualSlippageDbps: actualSlippageDbps.toString(),
          configuredSlippageDBPS: slippageDbps.toString(),
        });
        continue; // Skip to next bridge preference
      }

      logger.info('Quote meets slippage requirements', {
        requestId,
        route,
        bridgeType,
        amountToBridge: amountToBridge.toString(),
        receivedAmount: receivedAmount.toString(),
        minimumAcceptableAmount: minimumAcceptableAmount.toString(),
        slippageDbps: slippageDbps.toString(),
        actualSlippageDbps: actualSlippageDbps.toString(),
        configuredSlippageDBPS: slippageDbps.toString(),
      });

      // Step 3: Get Bridge Transaction Requests
      let bridgeTxRequests = [];
      const addresses = await chainService.getAddress();
      const sender = isTvmChain(`${route.origin}`)
        ? addresses[`${route.origin}`]
        : isSvmChain(`${route.origin}`)
          ? config.ownSolAddress
          : config.ownAddress;
      const recipient = isTvmChain(`${route.destination}`)
        ? addresses[`${route.destination}`]
        : isSvmChain(`${route.destination}`)
          ? config.ownSolAddress
          : config.ownAddress;
      try {
        bridgeTxRequests = await adapter.send(sender, recipient, amountToBridge.toString(), route);
        logger.info('Prepared bridge transaction request from adapter', {
          requestId,
          route,
          bridgeType,
          bridgeTxRequests,
          amountToBridge: amountToBridge,
          receiveAmount: receivedAmount,
          transactionCount: bridgeTxRequests.length,
          sender,
          recipient,
        });
        if (!bridgeTxRequests.length) {
          throw new Error(`Failed to retrieve any bridge transaction requests`);
        }
      } catch (sendError) {
        logger.error('Failed to get bridge transaction request from adapter, trying next preference', {
          requestId,
          route,
          bridgeType,
          amountToBridge: amountToBridge,
          error: jsonifyError(sendError),
        });
        continue; // Skip to next bridge preference
      }

      // Step 4: Submit the bridge transactions in order
      let idx = -1;
      let effectiveBridgedAmount = amountToBridge.toString(); // Default to original amount
      try {
        let receipt: TransactionReceipt | undefined = undefined;
        for (const { transaction, memo, effectiveAmount } of bridgeTxRequests) {
          idx++;
          logger.info('Submitting bridge transaction', {
            requestId,
            route,
            bridgeType,
            transactionIndex: idx,
            totalTransactions: bridgeTxRequests.length,
            transaction,
            memo,
            amountToBridge: amountToBridge,
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
              funcSig: transaction.funcSig || '',
            },
            context: { requestId, route, bridgeType, transactionType: memo },
          });

          logger.info('Successfully submitted and confirmed origin bridge transaction', {
            requestId,
            route,
            bridgeType,
            transactionIndex: idx,
            totalTransactions: bridgeTxRequests.length,
            transactionHash: result.hash,
            memo,
            amountToBridge: amountToBridge,
          });

          if (memo !== RebalanceTransactionMemo.Rebalance) {
            continue;
          }
          receipt = result.receipt! as unknown as TransactionReceipt;
          // Use the effective bridged amount if provided (e.g., for Near caps)
          if (effectiveAmount) {
            effectiveBridgedAmount = effectiveAmount;
            logger.info('Using effective bridged amount from adapter', {
              requestId,
              originalAmount: amountToBridge.toString(),
              effectiveAmount: effectiveBridgedAmount,
              bridgeType,
            });
          }
        }

        // Step 5: Create database record
        try {
          await createRebalanceOperation({
            earmarkId: null, // NULL indicates regular rebalancing
            originChainId: route.origin,
            destinationChainId: route.destination,
            tickerHash: route.asset,
            amount: effectiveBridgedAmount,
            slippage: route.slippagesDbps[bridgeIndex],
            status: RebalanceOperationStatus.PENDING,
            bridge: bridgeType,
            transactions: receipt ? { [route.origin]: receipt } : undefined,
          });

          logger.info('Successfully created rebalance operation in database', {
            requestId,
            route,
            bridgeType,
            originTxHash: receipt?.transactionHash,
            amountToBridge: effectiveBridgedAmount,
            originalRequestedAmount: amountToBridge.toString(),
            receiveAmount: receivedAmount,
          });

          // Add for tracking
          const rebalanceAction: RebalanceAction = {
            bridge: adapter.type(),
            amount: amountToBridge.toString(),
            origin: route.origin,
            destination: route.destination,
            asset: route.asset,
            transaction: receipt!.transactionHash,
            recipient,
          };
          rebalanceOperations.push(rebalanceAction);

          rebalanceSuccessful = true;
          // If we got here, the rebalance for this route was successful with this bridge.
          break; // Exit the bridge preference loop for this route
        } catch (error) {
          logger.error('Failed to confirm transaction or create database record', {
            requestId,
            route,
            bridgeType,
            transactionHash: receipt?.transactionHash,
            amountToBridge: amountToBridge,
            receiveAmount: receivedAmount,
            error: jsonifyError(error),
          });

          // Don't consider this a success if we can't confirm or record it
          continue; // Try next bridge
        }
      } catch (sendError) {
        logger.error('Failed to send or monitor bridge transaction, trying next preference', {
          requestId,
          route,
          bridgeType,
          transaction: bridgeTxRequests[idx],
          transactionIndex: idx,
          amountToBridge: amountToBridge,
          error: jsonifyError(sendError),
        });
        continue; // Skip to next bridge preference
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
