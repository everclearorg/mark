import { getTickerForAsset, convertToNativeUnits, getMarkBalancesForTicker } from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import {
  getDecimalsFromConfig,
  WalletType,
  RebalanceOperationStatus,
  DBPS_MULTIPLIER,
  RebalanceAction,
  MANTLE_CHAIN_ID,
  SupportedBridge,
  MAINNET_CHAIN_ID,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { executeDestinationCallbacks } from './callbacks';
import { getValidatedZodiacConfig, getActualAddress } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { MemoizedTransactionRequest, RebalanceTransactionMemo } from '@mark/rebalance';
import { createRebalanceOperation, TransactionReceipt } from '@mark/database';
import { IntentStatus } from '@mark/everclear';

const METH_ON_MANTLE_ADDRESS = '0xcda86a272531e8640cd7f1a92c01839911b90bb0';
const METH_ON_ETH_ADDRESS = '0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa';
const WETH_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';
const METH_STAKING_CONTRACT_ADDRESS = '0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f';
const MIN_STAKING_AMOUNT = 20000000000000000n; // 0.02 ETH in 18 decimals


export async function rebalanceMantleEth(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, chainService, everclear, rebalance } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  // Always check destination callbacks to ensure operations complete
  await executeDestinationCallbacks(context);

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('Rebalance loop is paused', { requestId });
    return rebalanceOperations;
  }

  logger.info('Starting to rebalance mantle eth', { requestId });

  // Get all of mark balances
  const balances = await getMarkBalancesForTicker(WETH_TICKER_HASH, config, chainService, context.prometheus);
  logger.debug('Retrieved all mark balances for WETH', { balances: jsonifyMap(balances) });
  if(!balances) {
    logger.warn('No balances found for WETH, skipping', { requestId });
    return rebalanceOperations;
  }
  // Get all intents to mantle
  // add parameters to filter intents: status: IntentStatus.SETTLED_AND_COMPLETED, origin: any, destination: MANTLE_CHAINID
  // TODO: check startDate to avoid processing duplicates
  const intents = await everclear.fetchIntents(
    { 
      limit: 20,
      statuses: [ IntentStatus.SETTLED_AND_COMPLETED ],
      destinations: [MANTLE_CHAIN_ID],
      outputAsset: METH_ON_MANTLE_ADDRESS.toLowerCase(),
      tickerHash: WETH_TICKER_HASH,
      isFastPath: true,
    });
  

  // For each intent to mantle chain
  for (const intent of intents) {
    logger.info('Processing intent', { requestId, intent });

    if(!intent.hub_settlement_domain) {
      logger.warn('Intent does not have a hub settlement domain, skipping', { requestId, intent });
      continue;
    }

    if(intent.destinations.length !== 1 || intent.destinations[0] !== MANTLE_CHAIN_ID) {
      logger.warn('Intent does not have exactly one destination, skipping', { requestId, intent });
      continue;
    }


    const origin = Number(intent.hub_settlement_domain);
    const destination = Number(intent.destinations[0]);

    const originChainConfig = config.chains[origin];
    const originZodiacConfig = getValidatedZodiacConfig(originChainConfig, logger, { requestId });

    // --- Route Level Checks (Synchronous or handled internally) ---
    const ticker = getTickerForAsset(intent.input_asset, origin, config);
    if (!ticker) {
      logger.error(`Ticker not found for asset, check config`, {
        config: config.chains[origin],
        intent,
      });
      continue;
    }

    if(ticker.toLowerCase() !== WETH_TICKER_HASH.toLowerCase()) {
      logger.warn('Ticker is not WETH, skipping', { requestId, intent, ticker });
      continue;
    }

    const decimals = getDecimalsFromConfig(ticker, origin.toString(), config);
    
    // Convert min staking amount and intent amount from standardized 18 decimals to asset's native decimals
    const minAmount = convertToNativeUnits(BigInt(MIN_STAKING_AMOUNT), decimals);
    const intentAmount = convertToNativeUnits(BigInt(intent.amount_out_min), decimals);
    if(intentAmount < minAmount) {
      logger.warn('Intent amount is less than min staking amount, skipping', { requestId, intent, intentAmount: intentAmount.toString(), minAmount: minAmount.toString() });
      continue;
    }

    const availableBalance = balances.get(origin.toString()) || 0n;

    // Ticker balances always in 18 units, convert to proper decimals
    const currentBalance = convertToNativeUnits(availableBalance, decimals);
    logger.debug('Current balance.', { requestId, currentBalance: currentBalance.toString() });

    if (currentBalance <= minAmount) {
      logger.info('Balance is at or below min staking amount, skipping route', {
        requestId,
        currentBalance: currentBalance.toString(),
        minAmount: minAmount.toString(),
      });
      continue; // Skip to next route
    }

    // Calculate amount to bridge (min(currentBalance, intentAmount))
    const amountToBridge = currentBalance < intentAmount ? currentBalance : intentAmount;
    
    // --- Bridge Preference Loop ---
    let rebalanceSuccessful = false;
    
    // Send WETH to Mainnet first
    const preferences = [ SupportedBridge.Binance, SupportedBridge.Across, SupportedBridge.CowSwap ];
    const route = {
      asset: intent.input_asset,
      origin: origin,
      destination: Number(MAINNET_CHAIN_ID),
      maximum: amountToBridge.toString(),
      slippagesDbps: [1000], // Slippage tolerance in decibasis points (1000 = 1%). Array indices match preferences
      preferences: preferences, // Priority ordered platforms
      reserve: '0' // Amount to keep on origin chain during rebalancing
    }
    
    for (let bridgeIndex = 0; bridgeIndex < preferences.length; bridgeIndex++) {
      const bridgeType = preferences[bridgeIndex];
      logger.info('Attempting to bridge', {
        requestId,
        bridgeType,
        amountToBridge: amountToBridge.toString(),
      });

      // Get Adapter (Synchronous)
      const adapter = rebalance.getAdapter(bridgeType);
      if (!adapter) {
        logger.warn('Adapter not found for bridge type, trying next preference', {
          requestId,
          bridgeType,
        });
        continue; // Skip to next bridge preference
      } 

      let bridgeTxRequests: MemoizedTransactionRequest[] = [];
      let receivedAmount: bigint = amountToBridge;
      const sender = getActualAddress(route.origin, config, logger, { requestId });

      if(String(origin) !== MAINNET_CHAIN_ID) {
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
        receivedAmount = BigInt(receivedAmountStr);
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
        try {
          bridgeTxRequests = await adapter.send(sender, sender, amountToBridge.toString(), route);
          logger.info('Prepared bridge transaction request from adapter', {
            requestId,
            route,
            bridgeType,
            bridgeTxRequests,
            amountToBridge: amountToBridge,
            receiveAmount: receivedAmount,
            transactionCount: bridgeTxRequests.length,
            sender,
            recipient: sender
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
      }

      // Step 4: Submit the bridge transactions in order
      // TODO: Use multisend for zodiac-enabled origin transactions
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
            amountToBridge: amountToBridge
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
            zodiacConfig: originZodiacConfig,
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
            useZodiac: originZodiacConfig.walletType,
          });

          if (memo !== RebalanceTransactionMemo.Rebalance) {
            continue;
          }
          receipt = result.receipt! as unknown as TransactionReceipt;
          // Use the effective bridged amount if provided (e.g., for Near caps or Binance rounding)
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
            tickerHash: getTickerForAsset(route.asset, route.origin, config) || route.asset,
            amount: effectiveBridgedAmount,
            slippage: route.slippagesDbps[bridgeIndex],
            status: RebalanceOperationStatus.PENDING,
            bridge: bridgeType,
            transactions: receipt ? { [route.origin]: receipt } : undefined,
            recipient: sender,
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
            recipient: sender,
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
