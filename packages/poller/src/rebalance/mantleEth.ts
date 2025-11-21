import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { getTickerForAsset, convertToNativeUnits, getMarkBalancesForTicker } from '../helpers';
import { jsonifyMap, jsonifyError } from '@mark/logger';
import {
  getDecimalsFromConfig,
  RebalanceOperationStatus,
  DBPS_MULTIPLIER,
  RebalanceAction,
  MANTLE_CHAIN_ID,
  SupportedBridge,
  MAINNET_CHAIN_ID,
  getTokenAddressFromConfig,
  WalletType,
  serializeBigInt,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { getActualAddress } from '../helpers/zodiac';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { MemoizedTransactionRequest, RebalanceTransactionMemo } from '@mark/rebalance';
import { createRebalanceOperation, TransactionEntry, TransactionReceipt } from '@mark/database';
import { IntentStatus } from '@mark/everclear';

const METH_ON_MANTLE_ADDRESS = '0xcda86a272531e8640cd7f1a92c01839911b90bb0';
const METH_ON_ETH_ADDRESS = '0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa';
const WETH_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';

const MIN_STAKING_AMOUNT = 20000000000000000n; // 0.02 ETH in 18 decimals


export async function rebalanceMantleEth(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, chainService, everclear, rebalance } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  // Always check destination callbacks to ensure operations complete
  await executeMethCallbacks(context);

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
  const intents = await everclear.fetchIntents({ 
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
    const preferences = [  SupportedBridge.Across, SupportedBridge.Binance, SupportedBridge.Coinbase ];
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
            zodiacConfig: {
              walletType: WalletType.EOA,
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
            useZodiac: WalletType.EOA,
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
            bridge: `${bridgeType}-mantle`,
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


export const executeMethCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, config, rebalance, chainService, database: db } = context;
  logger.info('Executing destination callbacks', { requestId });

  // Get all pending operations from database
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  logger.debug('Found rebalance operations', {
    count: operations.length,
    requestId,
    statuses: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    if (!operation.bridge) {
      logger.warn('Operation missing bridge type', logContext);
      continue;
    }

    const bridgeType =  operation.bridge.split('-')[0];
    const isToMainnetBridge = operation.bridge.split('-').length === 2 && operation.bridge.split('-')[1] === 'mantle';

    if (bridgeType !== SupportedBridge.Mantle && !isToMainnetBridge) {
      logger.warn('Operation is not a mantle bridge', logContext);
      continue;
    }
    const adapter = rebalance.getAdapter(bridgeType as SupportedBridge);

    // Get origin transaction hash from JSON field
    const txHashes = operation.transactions;
    const originTx = txHashes?.[operation.originChainId] as
      | TransactionEntry<{ receipt: TransactionReceipt }>
      | undefined;
    
    if (!originTx) {
      logger.warn('Operation missing origin transaction', { ...logContext, operation });
      continue;
    }

    // Get the transaction receipt from origin chain
    const receipt = originTx?.metadata?.receipt;
    if (!receipt) {
      logger.info('Origin transaction receipt not found for operation', { ...logContext, operation });
      continue;
    }

    const assetAddress = getTokenAddressFromConfig(operation.tickerHash, operation.originChainId.toString(), config);

    if (!assetAddress) {
      logger.error('Could not find asset address for ticker hash', {
        ...logContext,
        tickerHash: operation.tickerHash,
        originChain: operation.originChainId,
      });
      continue;
    }

    const route = {
      origin: operation.originChainId,
      destination: operation.destinationChainId,
      asset: assetAddress,
    };

    // Check if ready for callback
    if (operation.status === RebalanceOperationStatus.PENDING) {
      try {
        const ready = await adapter.readyOnDestination(
          operation.amount,
          route,
          receipt as unknown as ViemTransactionReceipt,
        );
        if (ready) {
          // Update status to awaiting callback
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
          });
          logger.info('Operation ready for callback, updated status', {
            ...logContext,
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
          });

          // Update the operation object for further processing
          operation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        } else {
          logger.info('Action not ready for destination callback', logContext);
        }
      } catch (e: unknown) {
        logger.error('Failed to check if ready on destination', { ...logContext, error: jsonifyError(e) });
        continue;
      }
    }

    // Execute callback if awaiting
    if (operation.status === RebalanceOperationStatus.AWAITING_CALLBACK) {
      let callback;
      try {
        callback = await adapter.destinationCallback(route, receipt as unknown as ViemTransactionReceipt);
      } catch (e: unknown) {
        logger.error('Failed to retrieve destination callback', { ...logContext, error: jsonifyError(e) });
        continue;
      }

      let amountToBridge = operation.amount.toString();
      if (!callback) {
        // No callback needed, mark as completed
        logger.info('No destination callback required, marking as completed', logContext);
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
        });
      } else {
        logger.info('Retrieved destination callback', {
          ...logContext,
          callback: serializeBigInt(callback),
          receipt: serializeBigInt(receipt),
        });
  
        // Try to execute the destination callback
        try {
          const tx = await submitTransactionWithLogging({
            chainService,
            logger,
            chainId: route.destination.toString(),
            txRequest: {
              chainId: +route.destination,
              to: callback.transaction.to!,
              data: callback.transaction.data!,
              value: (callback.transaction.value || 0).toString(),
              from: config.ownAddress,
              funcSig: callback.transaction.funcSig || '',
            },
            zodiacConfig: {
              walletType: WalletType.EOA,
            },
            context: { ...logContext, callbackType: `destination: ${callback.memo}` },
          });
  
          logger.info('Successfully submitted destination callback', {
            ...logContext,
            callback: serializeBigInt(callback),
            receipt: serializeBigInt(receipt),
            destinationTx: tx.hash,
            walletType: WalletType.EOA,
          });
  
          // Update operation as completed with destination tx hash
          if (!tx || !tx.receipt) {
            logger.error('Destination transaction receipt not found', { ...logContext, tx });
            continue;
          }
  
          try {
            await db.updateRebalanceOperation(operation.id, {
              status: RebalanceOperationStatus.COMPLETED,
              txHashes: {
                [route.destination.toString()]: tx.receipt as TransactionReceipt,
              },
            });
            amountToBridge = (callback.transaction.value as bigint).toString();
          } catch (dbError) {
            logger.error('Failed to update database with destination transaction', {
              ...logContext,
              destinationTx: tx.hash,
              receipt: serializeBigInt(tx.receipt),
              error: jsonifyError(dbError),
              errorMessage: (dbError as Error)?.message,
              errorStack: (dbError as Error)?.stack,
            });
            throw dbError;
          }
        } catch (e) {
          logger.error('Failed to execute destination callback', {
            ...logContext,
            callback: serializeBigInt(callback),
            receipt: serializeBigInt(receipt),
            error: jsonifyError(e),
          });
          continue
        }
      }
      
      try {
        if(isToMainnetBridge) {
          // Stake WETH / ETH to get mEth and bridge to mantle
          const mantleAdapter = rebalance.getAdapter(SupportedBridge.Mantle);
          if(!mantleAdapter) {
            logger.error('Mantle adapter not found', { ...logContext });
            continue;
          }
          
          // TODO: get filled amount from withdrawal transaction. Not the amount we bridged.
          const sender = getActualAddress(route.origin, config, logger, { requestId });
          // Step 1: Get Quote
          let receivedAmountStr: string;
          try {
            receivedAmountStr = await mantleAdapter.getReceivedAmount(amountToBridge, route);
            logger.info('Received quote from mantle adapter', {
              requestId,
              route,
              bridgeType,
              amountToBridge: amountToBridge,
              receivedAmount: receivedAmountStr,
            });
          } catch (quoteError) {
            logger.error('Failed to get quote from adapter, trying next preference', {
              requestId,
              route,
              bridgeType,
              amountToBridge: amountToBridge,
              error: jsonifyError(quoteError),
            });
            continue; // Skip to next bridge preference
          }

          // Step 2: Get Bridge Transaction Requests
          let bridgeTxRequests: MemoizedTransactionRequest[] = [];
          try {
            bridgeTxRequests = await mantleAdapter.send(sender, sender, amountToBridge, route);
            logger.info('Prepared bridge transaction request from adapter', {
              requestId,
              route,
              bridgeType,
              bridgeTxRequests,
              amountToBridge: amountToBridge,
              receiveAmount: receivedAmountStr,
              transactionCount: bridgeTxRequests.length,
              sender,
              recipient: sender
            });
            if (!bridgeTxRequests.length) {
              throw new Error(`Failed to retrieve any bridge transaction requests`);
            }
          } catch (sendError) {
            logger.error('Failed to get bridge transaction request from adapter', {
              requestId,
              route,
              bridgeType,
              amountToBridge: amountToBridge,
              error: jsonifyError(sendError),
            });
            continue; 
          }

          // Step 3: Submit the bridge transactions in order
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
                zodiacConfig: {
                  walletType: WalletType.EOA,
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
                amountToBridge: amountToBridge
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
                slippage: 1000, // 1% slippage
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
                receiveAmount: receivedAmountStr,
              });

              // If we got here, the rebalance for this route was successful with this bridge.
              break; // Exit the bridge preference loop for this route
            } catch (error) {
              logger.error('Failed to confirm transaction or create database record', {
                requestId,
                route,
                bridgeType,
                transactionHash: receipt?.transactionHash,
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
              error: jsonifyError(sendError),
            });
            continue; // Skip to next bridge preference
          }
        }
      } catch (dbError) {
        logger.error('Failed to update database with destination transaction', {
          ...logContext,
          error: jsonifyError(dbError),
          errorMessage: (dbError as Error)?.message,
          errorStack: (dbError as Error)?.stack,
        });
        throw dbError;
      }
    }
  }
};
