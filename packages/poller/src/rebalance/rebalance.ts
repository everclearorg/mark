import { getMarkBalances, getERC20Contract, safeStringToBigInt, getTickerForAsset } from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import { ProcessingContext } from '../init';
import { executeDestinationCallbacks } from './callbacks';
import { zeroAddress, encodeFunctionData, TransactionRequest } from 'viem';
import { RebalanceAction } from '@mark/cache';
import { providers } from 'ethers';

export async function rebalanceInventory(context: ProcessingContext): Promise<void> {
  const { logger, requestId, rebalanceCache, config, chainService, rebalance } = context;
  const isPaused = await rebalanceCache.isPaused();
  if (isPaused) {
    logger.warn('Rebalance loop is paused');
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

    // --- Route Level Checks (Synchronous or handled internally) ---
    const ticker = getTickerForAsset(route.asset, route.origin, config);
    if (!ticker) {
      logger.error(`Ticker not found for asset, check config`, {
        config: config.chains[route.origin],
        route,
      });
      continue;
    }
    const tickerBalances = balances.get(ticker);
    if (!tickerBalances) {
      logger.warn('No balances found for ticker, skipping route', { requestId, route, ticker });
      continue; // Skip to next route
    }
    const currentBalance = tickerBalances.get(route.origin.toString()) ?? 0n;
    logger.debug('Current balance for route', { requestId, route, currentBalance: currentBalance.toString() });

    const maximumBalance = BigInt(route.maximum);
    if (currentBalance <= maximumBalance) {
      logger.info('Balance is at or below maximum, skipping route', {
        requestId,
        route,
        currentBalance: currentBalance.toString(),
        maximum: route.maximum,
      });
      continue; // Skip to next route
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
        receivedAmountStr = await adapter.getReceivedAmount(currentBalance.toString(), route);
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
        currentBalance - (currentBalance * slippageScaled) / (scaleFactor * dbpsDenominator);

      if (receivedAmount < minimumAcceptableAmount) {
        logger.warn('Quote does not meet slippage requirements, trying next preference', {
          requestId,
          route,
          bridgeType,
          receivedAmount: receivedAmount.toString(),
          minimumAcceptableAmount: minimumAcceptableAmount.toString(),
          amountToBridge: currentBalance.toString(),
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

      // Step 3: Get Bridge Transaction Request (before approval)
      let bridgeTxRequest;
      try {
        bridgeTxRequest = await adapter.send(config.ownAddress, config.ownAddress, currentBalance.toString(), route);
        logger.info('Prepared bridge transaction request from adapter', {
          requestId,
          route,
          bridgeType,
          bridgeTxRequest,
        });
        if (!bridgeTxRequest.to) {
          throw new Error(`Failed to populate 'to' in bridge transaction request`);
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
      const spenderAddress = bridgeTxRequest.to! as `0x${string}`; // Safe due to check above

      // Step 4: ERC20 Approval Logic (if needed)
      const isNativeAsset = route.asset.toLowerCase() === zeroAddress;
      if (!isNativeAsset) {
        logger.info('Asset is not native, checking ERC20 approval', {
          requestId,
          route,
          bridgeType,
          spenderAddress,
          asset: route.asset,
        });
        let tokenContract;
        try {
          tokenContract = await getERC20Contract(config, route.origin.toString(), route.asset as `0x${string}`);
        } catch (contractError) {
          logger.error('Failed to get ERC20 contract instance, trying next preference', {
            requestId,
            route,
            bridgeType,
            asset: route.asset,
            error: jsonifyError(contractError),
          });
          continue; // Skip to next bridge preference
        }

        let currentAllowance: bigint;
        try {
          currentAllowance = (await tokenContract.read.allowance([
            config.ownAddress as `0x${string}`,
            spenderAddress,
          ])) as bigint;
          logger.info('Current token allowance', {
            requestId,
            route,
            bridgeType,
            spenderAddress,
            owner: config.ownAddress,
            asset: route.asset,
            allowance: currentAllowance.toString(),
            requiredAmount: currentBalance.toString(),
          });
        } catch (allowanceError) {
          logger.error('Failed to get token allowance, trying next preference', {
            requestId,
            route,
            bridgeType,
            spenderAddress,
            asset: route.asset,
            error: jsonifyError(allowanceError),
          });
          continue; // Skip to next bridge preference
        }

        if (currentAllowance < currentBalance) {
          logger.info('Allowance is less than required amount. Attempting to approve.', {
            requestId,
            route,
            bridgeType,
            spenderAddress,
            requiredAmount: currentBalance.toString(),
            currentAllowance: currentAllowance.toString(),
          });
          try {
            const approveData = encodeFunctionData({
              abi: tokenContract.abi,
              functionName: 'approve',
              args: [spenderAddress, currentBalance],
            });
            const approvalTxRequest: TransactionRequest = {
              to: route.asset as `0x${string}`,
              data: approveData,
              value: 0n,
              from: config.ownAddress as `0x${string}`,
            };
            logger.info('Prepared ERC20 approval transaction request', {
              requestId,
              route,
              bridgeType,
              approvalTxRequest,
            });

            const approvalReceipt = await chainService.submitAndMonitor(
              route.origin.toString(),
              approvalTxRequest as providers.TransactionRequest, // Still needs type alignment
            );
            logger.info('Successfully submitted and confirmed ERC20 approval transaction', {
              requestId,
              route,
              bridgeType,
              spenderAddress,
              approvalTxHash: approvalReceipt.transactionHash,
            });
          } catch (approvalError) {
            logger.error('ERC20 token approval transaction failed, trying next preference', {
              requestId,
              route,
              bridgeType,
              spenderAddress,
              asset: route.asset,
              error: jsonifyError(approvalError),
            });
            continue; // Skip to next bridge preference
          }
        } else {
          logger.info('Sufficient allowance already exists for token', {
            requestId,
            route,
            bridgeType,
            spenderAddress,
          });
        }
      } else {
        logger.info('Asset is native, no ERC20 approval needed.', { requestId, route, bridgeType });
      }

      // Step 5: Submit the original bridge transaction
      let originTxReceipt;
      try {
        logger.info('Submitting the original bridge transaction', { requestId, route, bridgeType, bridgeTxRequest });
        const bridgeTxForSubmit: TransactionRequest = {
          ...(bridgeTxRequest as unknown as TransactionRequest),
          to: bridgeTxRequest.to!, // Already checked non-null
          from: config.ownAddress as `0x${string}`,
        };
        const submittedTx = await chainService.submitAndMonitor(
          route.origin.toString(),
          bridgeTxForSubmit as providers.TransactionRequest, // Still needs type alignment
        );
        originTxReceipt = submittedTx;
        logger.info('Successfully submitted and confirmed origin bridge transaction', {
          requestId,
          route,
          bridgeType,
          transactionHash: originTxReceipt.transactionHash,
        });
      } catch (finalSendError) {
        logger.error('Failed to send or monitor final bridge transaction, trying next preference', {
          requestId,
          route,
          bridgeType,
          bridgeTxRequest,
          error: jsonifyError(finalSendError),
        });
        continue; // Skip to next bridge preference
      }

      // Step 6: Add rebalance action to cache
      const rebalanceAction: RebalanceAction = {
        bridge: adapter.type(),
        amount: currentBalance.toString(),
        origin: route.origin,
        destination: route.destination,
        asset: route.asset,
        transaction: originTxReceipt.transactionHash,
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
          transactionHash: originTxReceipt.transactionHash,
          error: jsonifyError(cacheError),
          rebalanceAction,
        });
        // Consider this a success for the route as funds were moved. Exit bridge loop.
        rebalanceSuccessful = true;
        break; // Exit the bridge preference loop for this route
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
