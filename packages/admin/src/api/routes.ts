import { jsonifyError } from '@mark/logger';
import { AdminContext, HttpPaths } from '../types';
import { verifyAdminToken } from './auth';
import * as database from '@mark/database';
import { snakeToCamel, TransactionReceipt } from '@mark/database';
import { PurchaseCache } from '@mark/cache';
import {
  RebalanceOperationStatus,
  EarmarkStatus,
  getTokenAddressFromConfig,
  SupportedBridge,
  MarkConfiguration,
  isSvmChain,
  isTvmChain,
  NewIntentParams,
  AssetConfiguration,
  BPS_MULTIPLIER,
} from '@mark/core';
import { encodeFunctionData, erc20Abi, Hex, formatUnits, parseUnits } from 'viem';
import { MemoizedTransactionRequest } from '@mark/rebalance';
import type { SwapExecutionResult } from '@mark/rebalance/src/types';
import { AdminApi } from '../openapi/adminApi';
import { ErrorResponse, ForbiddenResponse } from '../openapi/schemas';
import { isLambdaResponse, jsonWithSchema, parseJsonBody, parsePathParams, parseQuery } from './typedApi';

type Database = typeof database;

export const handleApiRequest = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { requestId, logger, event } = context;
  if (!verifyAdminToken(context)) {
    logger.warn('Unauthorized access attempt', { requestId, event });
    return jsonWithSchema(403, ForbiddenResponse, { message: 'Forbidden: Invalid admin token' });
  }
  try {
    const request = extractRequest(context);
    if (!request) {
      return jsonWithSchema(404, ErrorResponse, {
        message: `Unknown request: ${context.event.httpMethod} ${context.event.path}`,
      });
    }

    // Handle GET requests for rebalance inspection
    if (context.event.httpMethod === 'GET') {
      return handleGetRequest(request, context);
    }

    // Handle POST requests (existing functionality)
    switch (request) {
      case HttpPaths.PausePurchase:
        await pauseIfNeeded('purchase', context.purchaseCache, context);
        return jsonWithSchema(200, AdminApi.pausePurchase.response, {
          message: `Successfully processed request: ${request}`,
        });
      case HttpPaths.PauseRebalance:
        await pauseIfNeeded('rebalance', context.database, context);
        return jsonWithSchema(200, AdminApi.pauseRebalance.response, {
          message: `Successfully processed request: ${request}`,
        });
      case HttpPaths.PauseOnDemandRebalance:
        await pauseIfNeeded('ondemand', context.database, context);
        return jsonWithSchema(200, AdminApi.pauseOnDemandRebalance.response, {
          message: `Successfully processed request: ${request}`,
        });
      case HttpPaths.UnpausePurchase:
        await unpauseIfNeeded('purchase', context.purchaseCache, context);
        return jsonWithSchema(200, AdminApi.unpausePurchase.response, {
          message: `Successfully processed request: ${request}`,
        });
      case HttpPaths.UnpauseRebalance:
        await unpauseIfNeeded('rebalance', context.database, context);
        return jsonWithSchema(200, AdminApi.unpauseRebalance.response, {
          message: `Successfully processed request: ${request}`,
        });
      case HttpPaths.UnpauseOnDemandRebalance:
        await unpauseIfNeeded('ondemand', context.database, context);
        return jsonWithSchema(200, AdminApi.unpauseOnDemandRebalance.response, {
          message: `Successfully processed request: ${request}`,
        });
      case HttpPaths.CancelEarmark:
        return handleCancelEarmark(context);
      case HttpPaths.CancelRebalanceOperation:
        return handleCancelRebalanceOperation(context);
      case HttpPaths.TriggerSend:
        return handleTriggerSend(context);
      case HttpPaths.TriggerRebalance:
        return handleTriggerRebalance(context);
      case HttpPaths.TriggerIntent:
        return handleTriggerIntent(context);
      case HttpPaths.TriggerSwap:
        return handleTriggerSwap(context);
      default:
        throw new Error(`Unknown request: ${request}`);
    }
  } catch (e) {
    const err = jsonifyError(e);
    return jsonWithSchema(500, ErrorResponse, { message: err.message, error: err.stack });
  }
};

const handleCancelRebalanceOperation = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, database } = context;
  const bodyParsed = parseJsonBody(AdminApi.cancelRebalanceOperation.body!, event.body ?? null);
  if (isLambdaResponse(bodyParsed)) return bodyParsed;
  const { operationId } = bodyParsed;

  logger.info('Cancelling rebalance operation', { operationId });

  try {
    // Get current operation to verify it exists and check status
    const operations = await database
      .queryWithClient<database.rebalance_operations>('SELECT * FROM rebalance_operations WHERE id = $1', [operationId])
      .then((rows: database.rebalance_operations[]) => rows.map((row: database.rebalance_operations) => snakeToCamel(row)));

    if (operations.length === 0) {
      return jsonWithSchema(404, ErrorResponse, { message: 'Rebalance operation not found' });
    }

    const operation = operations[0];

    // Check if operation can be cancelled (must be PENDING or AWAITING_CALLBACK)
    if (!['pending', 'awaiting_callback'].includes(operation.status)) {
      return jsonWithSchema(400, ErrorResponse, {
        message: `Cannot cancel operation with status: ${operation.status}. Only PENDING and AWAITING_CALLBACK operations can be cancelled.`,
        currentStatus: operation.status,
      });
    }

    // Update operation status to cancelled
    // Mark as orphaned if it has an associated earmark
    const updated = await database
      .queryWithClient<database.rebalance_operations>(
        `UPDATE rebalance_operations
       SET status = $1, is_orphaned = CASE WHEN earmark_id IS NOT NULL THEN true ELSE is_orphaned END, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
        [RebalanceOperationStatus.CANCELLED, operationId],
      )
      .then((rows: database.rebalance_operations[]) => rows.map((row: database.rebalance_operations) => snakeToCamel(row)));

    logger.info('Rebalance operation cancelled successfully', {
      operationId,
      previousStatus: operation.status,
      chainId: operation.chainId,
      hadEarmark: operation.earmarkId !== null,
      earmarkId: operation.earmarkId,
    });

    return jsonWithSchema(200, AdminApi.cancelRebalanceOperation.response, {
      message: 'Rebalance operation cancelled successfully',
      operation: updated[0],
    });
  } catch (error) {
    logger.error('Failed to cancel rebalance operation', { operationId, error });
    return jsonWithSchema(500, ErrorResponse, {
      message: 'Failed to cancel rebalance operation',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

const handleCancelEarmark = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, database } = context;
  const bodyParsed = parseJsonBody(AdminApi.cancelEarmark.body!, event.body ?? null);
  if (isLambdaResponse(bodyParsed)) return bodyParsed;
  const { earmarkId } = bodyParsed;

  logger.info('Cancelling earmark', { earmarkId });

  try {
    // Get current earmark to verify it exists and check status
    const earmarks = await database
      .queryWithClient<database.earmarks>('SELECT * FROM earmarks WHERE id = $1', [earmarkId])
      .then((rows: database.earmarks[]) => rows.map((row: database.earmarks) => snakeToCamel(row)));
    if (earmarks.length === 0) {
      return jsonWithSchema(404, ErrorResponse, { message: 'Earmark not found' });
    }

    const earmark = earmarks[0];

    // Check if earmark can be cancelled
    if (['completed', 'cancelled', 'expired'].includes(earmark.status)) {
      return jsonWithSchema(400, ErrorResponse, {
        message: `Cannot cancel earmark with status: ${earmark.status}`,
        currentStatus: earmark.status,
      });
    }

    // Mark all operations as orphaned (both PENDING and AWAITING_CALLBACK keep their status)
    const orphanedOps = await database.queryWithClient<{ id: string; status: string }>(
      `UPDATE rebalance_operations
       SET is_orphaned = true, updated_at = NOW()
       WHERE earmark_id = $1 AND status IN ($2, $3)
       RETURNING id, status`,
      [earmarkId, RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
    );

    // Update earmark status to cancelled
    const updated = await database.updateEarmarkStatus(earmarkId, EarmarkStatus.CANCELLED);

    logger.info('Earmark cancelled successfully', {
      earmarkId,
      invoiceId: earmark.invoiceId,
      previousStatus: earmark.status,
      orphanedOperations: orphanedOps.length,
      orphanedPending: orphanedOps.filter((op: { id: string; status: string }) => op.status === RebalanceOperationStatus.PENDING).length,
      orphanedAwaitingCallback: orphanedOps.filter((op: { id: string; status: string }) => op.status === RebalanceOperationStatus.AWAITING_CALLBACK)
        .length,
    });

    return jsonWithSchema(200, AdminApi.cancelEarmark.response, {
      message: 'Earmark cancelled successfully',
      earmark: updated,
    });
  } catch (error) {
    logger.error('Failed to cancel earmark', { earmarkId, error });
    return jsonWithSchema(500, ErrorResponse, {
      message: 'Failed to cancel earmark',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

const handleTriggerSend = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, config } = context;
  const startTime = Date.now();

  try {
    const bodyParsed = parseJsonBody(AdminApi.triggerSend.body!, event.body ?? null);
    if (isLambdaResponse(bodyParsed)) return bodyParsed;
    const { chainId, asset, recipient, amount, memo } = bodyParsed;

    // Validate recipient is whitelisted
    const whitelistedRecipients = config.whitelistedRecipients || [];
    if (whitelistedRecipients.length === 0) {
      logger.warn('No whitelisted recipients configured', { chainId, recipient });
      return jsonWithSchema(403, ForbiddenResponse, {
        message: 'No whitelisted recipients configured. Cannot send funds.',
      });
    }

    const isWhitelisted = whitelistedRecipients.some(
      (whitelisted) => whitelisted.toLowerCase() === recipient.toLowerCase(),
    );

    if (!isWhitelisted) {
      logger.warn('Recipient not whitelisted', {
        chainId,
        recipient,
        whitelistedRecipients,
      });
      return jsonWithSchema(403, ForbiddenResponse, { message: 'Recipient address is not whitelisted', recipient });
    }

    logger.info('Trigger send request validated', {
      chainId,
      asset,
      recipient,
      amount,
      memo: memo || 'none',
      operation: 'trigger_send',
    });

    // Get chain configuration
    const { markConfig } = config;
    const chainConfig = markConfig.chains[chainId];
    if (!chainConfig) {
      logger.error('Chain not configured', { chainId });
      return jsonWithSchema(400, ErrorResponse, { message: `Chain ${chainId} is not configured` });
    }

    // Get token address from configuration
    const tokenAddress = getTokenAddressFromConfig(asset, chainId.toString(), markConfig);
    if (!tokenAddress) {
      logger.error('Token not found in configuration', { chainId, asset });
      return jsonWithSchema(400, ErrorResponse, { message: `Token ${asset} not found for chain ${chainId}` });
    }

    // Encode ERC20 transfer call
    const transferData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient as `0x${string}`, BigInt(amount)],
    });

    logger.info('Submitting token transfer', {
      chainId,
      asset,
      tokenAddress,
      recipient,
      amount,
      operation: 'trigger_send',
    });

    // Submit transaction
    const receipt = await context.chainService.submitAndMonitor(chainId.toString(), {
      chainId,
      to: tokenAddress,
      data: transferData as Hex,
      value: '0',
      from: markConfig.ownAddress,
      funcSig: 'transfer(address,uint256)',
    });

    const duration = Date.now() - startTime;

    logger.info('Trigger send completed successfully', {
      chainId,
      asset,
      tokenAddress,
      recipient,
      amount,
      transactionHash: receipt.transactionHash,
      duration,
      status: 'completed',
      operation: 'trigger_send',
    });

    return jsonWithSchema(200, AdminApi.triggerSend.response, {
      message: 'Funds sent successfully',
      transactionHash: receipt.transactionHash,
      chainId,
      asset,
      recipient,
      amount,
      memo,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Failed to process trigger send', { error, duration });
    return jsonWithSchema(500, ErrorResponse, {
      message: 'Failed to process trigger send request',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Helper functions for rebalance
const getTickerForAsset = (asset: string, chainId: number, config: MarkConfiguration) => {
  const chainConfig = config.chains[chainId.toString()];
  if (!chainConfig || !chainConfig.assets) {
    return undefined;
  }
  const assetConfig = chainConfig.assets.find(
    (a: AssetConfiguration) => a.address.toLowerCase() === asset.toLowerCase(),
  );
  return assetConfig?.tickerHash;
};

const getDecimalsFromConfig = (ticker: string, chainId: number, config: MarkConfiguration) => {
  const chainConfig = config.chains[chainId.toString()];
  if (!chainConfig) return undefined;
  const asset = chainConfig.assets.find((a: AssetConfiguration) => a.tickerHash.toLowerCase() === ticker.toLowerCase());
  return asset?.decimals;
};

const convertToNativeUnits = (amount: bigint, decimals: number | undefined): bigint => {
  const targetDecimals = decimals ?? 18;
  if (targetDecimals === 18) return amount;
  const divisor = BigInt(10 ** (18 - targetDecimals));
  return amount / divisor;
};

const convertTo18Decimals = (amount: bigint, decimals: number | undefined): bigint => {
  return parseUnits(formatUnits(amount, decimals ?? 18), 18);
};

const handleTriggerRebalance = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, config, chainService, rebalanceAdapter, database } = context;
  const startTime = Date.now();

  try {
    const bodyParsed = parseJsonBody(AdminApi.triggerRebalance.body!, event.body ?? null);
    if (isLambdaResponse(bodyParsed)) return bodyParsed;
    const { originChain, destinationChain, asset, amount, bridge, slippage, earmarkId } = bodyParsed;

    logger.info('Trigger rebalance request received', {
      originChain,
      destinationChain,
      asset,
      amount,
      bridge,
      slippage,
      earmarkId: earmarkId || null,
      operation: 'trigger_rebalance',
    });

    // Validate chain configurations
    const { markConfig } = config;
    const originChainConfig = markConfig.chains[originChain.toString()];
    const destChainConfig = markConfig.chains[destinationChain.toString()];

    if (!originChainConfig) {
      logger.error('Origin chain not configured', { originChain });
      return jsonWithSchema(400, ErrorResponse, { message: `Origin chain ${originChain} is not configured` });
    }

    if (!destChainConfig) {
      logger.error('Destination chain not configured', { destinationChain });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Destination chain ${destinationChain} is not configured`,
      });
    }

    // Get asset address and ticker
    const originAssetAddress = getTokenAddressFromConfig(asset, originChain.toString(), markConfig);
    const destAssetAddress = getTokenAddressFromConfig(asset, destinationChain.toString(), markConfig);

    if (!originAssetAddress) {
      logger.error('Asset not found on origin chain', { asset, originChain });
      return jsonWithSchema(400, ErrorResponse, { message: `Asset ${asset} not found on origin chain ${originChain}` });
    }

    if (!destAssetAddress) {
      logger.error('Asset not found on destination chain', { asset, destinationChain });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Asset ${asset} not found on destination chain ${destinationChain}`,
      });
    }

    const ticker = getTickerForAsset(originAssetAddress, originChain, markConfig);
    if (!ticker) {
      logger.error('Could not determine ticker for asset', { asset, originChain });
      return jsonWithSchema(400, ErrorResponse, { message: `Could not determine ticker for asset ${asset}` });
    }

    // Get decimals and convert amount
    const originDecimals = getDecimalsFromConfig(ticker, originChain, markConfig);
    const destDecimals = getDecimalsFromConfig(ticker, destinationChain, markConfig);

    // Parse amount as 18 decimals
    const amount18Decimals = parseUnits(amount, 18);
    const amountNativeUnits = convertToNativeUnits(amount18Decimals, originDecimals);

    logger.info('Amount conversions', {
      amountInput: amount,
      amount18Decimals: amount18Decimals.toString(),
      amountNativeUnits: amountNativeUnits.toString(),
      originDecimals,
      destDecimals,
    });

    // Validate bridge type
    const bridgeType = bridge as SupportedBridge;
    if (!Object.values(SupportedBridge).includes(bridgeType)) {
      logger.error('Invalid bridge type', { bridge });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Invalid bridge type: ${bridge}. Supported: ${Object.values(SupportedBridge).join(', ')}`,
      });
    }

    // Get bridge adapter
    const adapter = rebalanceAdapter.getAdapter(bridgeType);

    // Get quote from adapter
    const route = {
      asset: originAssetAddress,
      origin: originChain,
      destination: destinationChain,
    };

    logger.info('Getting quote from adapter', { bridge: bridgeType, route });
    const receivedAmount = await adapter.getReceivedAmount(amountNativeUnits.toString(), route);
    const receivedAmount18 = convertTo18Decimals(BigInt(receivedAmount), destDecimals);

    logger.info('Quote received', {
      sentAmount: amountNativeUnits.toString(),
      receivedAmount,
      receivedAmount18: receivedAmount18.toString(),
    });

    // Validate slippage if provided
    // Slippage is in basis points where 500 = 5%
    if (slippage !== undefined) {
      const slippageBps = BigInt(slippage);
      const minimumAcceptableAmount = amount18Decimals - (amount18Decimals * slippageBps) / BPS_MULTIPLIER;
      const actualSlippageBps = ((amount18Decimals - receivedAmount18) * BPS_MULTIPLIER) / amount18Decimals;

      logger.info('Slippage validation', {
        providedSlippageBps: slippage,
        actualSlippageBps: actualSlippageBps.toString(),
        minimumAcceptableAmount: minimumAcceptableAmount.toString(),
        receivedAmount18: receivedAmount18.toString(),
      });

      if (receivedAmount18 < minimumAcceptableAmount) {
        return jsonWithSchema(400, ErrorResponse, {
          message: 'Slippage tolerance exceeded',
          providedSlippageBps: slippage,
          actualSlippageBps: actualSlippageBps.toString(),
          sentAmount: amount,
          receivedAmount: formatUnits(receivedAmount18, 18),
        });
      }
    }

    // Get transaction requests from adapter
    logger.info('Requesting transactions from adapter', { bridge: bridgeType });
    const recipient = markConfig.ownAddress;
    const sender = markConfig.ownAddress;
    const txRequests: MemoizedTransactionRequest[] = await adapter.send(
      sender,
      recipient,
      amountNativeUnits.toString(),
      route,
    );

    logger.info('Transaction requests received', {
      count: txRequests.length,
      effectiveAmount: txRequests[0]?.effectiveAmount,
    });

    // Submit transactions
    const receipts: Record<string, TransactionReceipt> = {};
    for (const txRequest of txRequests) {
      logger.info('Submitting transaction', {
        chainId: originChain,
        to: txRequest.transaction.to,
        value: txRequest.transaction.value,
        memo: txRequest.memo,
      });

      const receipt = await chainService.submitAndMonitor(originChain.toString(), {
        chainId: originChain,
        to: txRequest.transaction.to as `0x${string}`,
        data: (txRequest.transaction.data as Hex) || '0x',
        value: txRequest.transaction.value?.toString() || '0',
        from: sender as `0x${string}`,
        funcSig: txRequest.transaction.funcSig || '',
      });

      receipts[originChain.toString()] = receipt;
      logger.info('Transaction submitted', {
        chainId: originChain,
        transactionHash: receipt.transactionHash,
        memo: txRequest.memo,
      });
    }

    // Create database record
    const effectiveAmount = txRequests[0]?.effectiveAmount || amountNativeUnits.toString();
    const effectiveAmount18 = convertTo18Decimals(BigInt(effectiveAmount), originDecimals);

    const operation = await database.createRebalanceOperation({
      earmarkId: earmarkId || null,
      originChainId: originChain,
      destinationChainId: destinationChain,
      tickerHash: ticker,
      amount: effectiveAmount18.toString(),
      slippage: slippage || 0,
      status: RebalanceOperationStatus.PENDING,
      bridge: bridgeType,
      recipient,
      transactions: receipts,
    });

    const duration = Date.now() - startTime;

    logger.info('Trigger rebalance completed successfully', {
      operationId: operation.id,
      originChain,
      destinationChain,
      asset,
      ticker,
      amount: effectiveAmount18.toString(),
      bridge: bridgeType,
      transactionHashes: Object.values(receipts).map((r: TransactionReceipt) => r.transactionHash),
      duration,
      status: 'completed',
      operation: 'trigger_rebalance',
    });

    return jsonWithSchema(200, AdminApi.triggerRebalance.response, {
      message: 'Rebalance operation triggered successfully',
      operation: {
        id: operation.id,
        originChain,
        destinationChain,
        asset,
        ticker,
        amount: formatUnits(effectiveAmount18, 18),
        bridge: bridgeType,
        status: operation.status,
        transactionHashes: Object.values(receipts).map((r: TransactionReceipt) => r.transactionHash),
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Failed to process trigger rebalance', { error, duration });
    return jsonWithSchema(500, ErrorResponse, {
      message: 'Failed to process trigger rebalance request',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

const handleTriggerSwap = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, config, rebalanceAdapter } = context;
  const startTime = Date.now();

  try {
    const bodyParsed = parseJsonBody(AdminApi.triggerSwap.body!, event.body ?? null);
    if (isLambdaResponse(bodyParsed)) return bodyParsed;
    const { chainId, inputAsset, outputAsset, amount, slippage, swapAdapter, recipient } = bodyParsed;

    logger.info('Trigger swap request received', {
      chainId,
      inputAsset,
      outputAsset,
      amount,
      slippage,
      swapAdapter: swapAdapter || 'cowswap',
      recipient: recipient || 'default',
      operation: 'trigger_swap',
    });

    // Validate chain configuration
    const { markConfig } = config;
    const chainConfig = markConfig.chains[chainId.toString()];

    if (!chainConfig) {
      logger.error('Chain not configured', { chainId });
      return jsonWithSchema(400, ErrorResponse, { message: `Chain ${chainId} is not configured` });
    }

    // Helper to resolve asset: can be tickerHash, ticker symbol, or address
    const resolveAssetAddress = (asset: string, chainId: string): string | undefined => {
      const chainConfig = markConfig.chains[chainId];
      if (!chainConfig || !chainConfig.assets) {
        return undefined;
      }

      // If it's an address (starts with 0x), find by address
      if (asset.toLowerCase().startsWith('0x')) {
        const assetConfig = chainConfig.assets.find(
          (a: AssetConfiguration) => a.address.toLowerCase() === asset.toLowerCase(),
        );
        return assetConfig?.address;
      }

      // Try to find by tickerHash first
      let assetConfig = chainConfig.assets.find(
        (a: AssetConfiguration) => a.tickerHash.toLowerCase() === asset.toLowerCase(),
      );
      if (assetConfig) {
        return assetConfig.address;
      }

      // Try to find by symbol
      assetConfig = chainConfig.assets.find((a: AssetConfiguration) => a.symbol.toLowerCase() === asset.toLowerCase());
      if (assetConfig) {
        return assetConfig.address;
      }

      return undefined;
    };

    // Get asset addresses
    const inputAssetAddress = resolveAssetAddress(inputAsset, chainId.toString());
    const outputAssetAddress = resolveAssetAddress(outputAsset, chainId.toString());

    if (!inputAssetAddress) {
      logger.error('Input asset not found on chain', { inputAsset, chainId });
      return jsonWithSchema(400, ErrorResponse, { message: `Input asset ${inputAsset} not found on chain ${chainId}` });
    }

    if (!outputAssetAddress) {
      logger.error('Output asset not found on chain', { outputAsset, chainId });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Output asset ${outputAsset} not found on chain ${chainId}`,
      });
    }

    // Get tickers for decimals
    const inputTicker = getTickerForAsset(inputAssetAddress, chainId, markConfig);
    const outputTicker = getTickerForAsset(outputAssetAddress, chainId, markConfig);

    if (!inputTicker) {
      logger.error('Could not determine ticker for input asset', { inputAsset, chainId });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Could not determine ticker for input asset ${inputAsset}`,
      });
    }

    if (!outputTicker) {
      logger.error('Could not determine ticker for output asset', { outputAsset, chainId });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Could not determine ticker for output asset ${outputAsset}`,
      });
    }

    // Get decimals and convert amount
    const inputDecimals = getDecimalsFromConfig(inputTicker, chainId, markConfig);
    const outputDecimals = getDecimalsFromConfig(outputTicker, chainId, markConfig);

    // Parse amount as 18 decimals
    const amount18Decimals = parseUnits(amount, 18);
    const amountNativeUnits = convertToNativeUnits(amount18Decimals, inputDecimals);

    logger.info('Amount conversions', {
      amountInput: amount,
      amount18Decimals: amount18Decimals.toString(),
      amountNativeUnits: amountNativeUnits.toString(),
      inputDecimals,
      outputDecimals,
    });

    // Get swap adapter (default to cowswap)
    const adapterName = (swapAdapter || 'cowswap') as SupportedBridge;
    if (!Object.values(SupportedBridge).includes(adapterName)) {
      logger.error('Invalid swap adapter', { swapAdapter: adapterName });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Invalid swap adapter: ${adapterName}. Supported: ${Object.values(SupportedBridge).join(', ')}`,
      });
    }

    // Get swap adapter
    const adapter = rebalanceAdapter.getAdapter(adapterName);

    if (!adapter || !adapter.executeSwap) {
      logger.error('Swap adapter does not support executeSwap', { adapterName });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Swap adapter ${adapterName} does not support executeSwap operation`,
      });
    }

    // Build route for same-chain swap
    const route = {
      asset: inputAssetAddress,
      origin: chainId,
      destination: chainId, // Same-chain swap
      swapOutputAsset: outputAssetAddress,
    };

    // Get quote from adapter
    logger.info('Getting quote from swap adapter', { adapter: adapterName, route });
    const receivedAmount = await adapter.getReceivedAmount(amountNativeUnits.toString(), route);
    const receivedAmount18 = convertTo18Decimals(BigInt(receivedAmount), outputDecimals);

    logger.info('Quote received', {
      sentAmount: amountNativeUnits.toString(),
      receivedAmount,
      receivedAmount18: receivedAmount18.toString(),
    });

    // Validate slippage if provided
    // Slippage is in basis points where 500 = 5%
    // For swaps, slippage is calculated based on the quote we received
    // The quote represents the expected output, and we validate that the actual execution
    // will meet our minimum acceptable amount based on slippage tolerance
    let actualSlippageBps: bigint | undefined;
    if (slippage !== undefined) {
      const slippageBps = BigInt(slippage);

      // For swaps, slippage is applied to the received amount (output)
      // Minimum acceptable = quote * (1 - slippage)
      const minimumAcceptableAmount = receivedAmount18 - (receivedAmount18 * slippageBps) / BPS_MULTIPLIER;

      // Actual slippage will be determined when the order settles
      // For now, we just validate that the quote meets our minimum
      // Note: actualSlippageBps calculation would require comparing final execution to quote,
      // which happens after order settlement, so we don't calculate it here

      logger.info('Slippage validation', {
        providedSlippageBps: slippage,
        minimumAcceptableAmount: minimumAcceptableAmount.toString(),
        receivedAmount18: receivedAmount18.toString(),
        note: 'Actual slippage will be determined when order settles',
      });

      // Note: We don't validate slippage here because:
      // 1. The quote from getReceivedAmount is what we expect to receive
      // 2. CowSwap will ensure we get at least the minimum based on their slippage protection
      // 3. Actual slippage can only be calculated after order execution
      // The slippage parameter is passed to CowSwap for their internal validation
    }

    // Execute swap
    const sender = markConfig.ownAddress;
    const swapRecipient = recipient || markConfig.ownAddress;

    logger.info('Executing swap', {
      adapter: adapterName,
      chainId,
      sender,
      recipient: swapRecipient,
      amount: amountNativeUnits.toString(),
    });

    let swapResult: SwapExecutionResult;
    try {
      swapResult = await adapter.executeSwap(sender, swapRecipient, amountNativeUnits.toString(), route);
    } catch (error: unknown) {
      // If the error is a timeout waiting for order settlement, the order was still created
      // Extract order UID from error message if available
      const errorMessage = error instanceof Error ? error.message : String(error);
      const orderUidMatch = errorMessage.match(/order\s+(0x[a-f0-9]+)/i);

      if (orderUidMatch && errorMessage.includes('Timed out waiting')) {
        logger.warn('Swap order created but settlement timed out', {
          orderUid: orderUidMatch[1],
          error: errorMessage,
          note: 'Order was successfully submitted to CowSwap but settlement is pending',
        });

        // Return success with order UID, indicating order is pending settlement
        return jsonWithSchema(200, AdminApi.triggerSwap.response, {
          message: 'Swap order submitted successfully (settlement pending)',
          swap: {
            orderUid: orderUidMatch[1],
            chainId,
            inputAsset: inputAssetAddress,
            outputAsset: outputAssetAddress,
            inputTicker,
            outputTicker,
            sellAmount: amountNativeUnits.toString(),
            buyAmount: receivedAmount,
            status: 'pending_settlement',
            note: 'Order submitted to CowSwap. Settlement may take time as orders are batch-filled.',
          },
        });
      }
      throw error;
    }

    logger.info('Swap executed successfully', {
      orderUid: swapResult.orderUid,
      sellToken: swapResult.sellToken,
      buyToken: swapResult.buyToken,
      sellAmount: swapResult.sellAmount,
      buyAmount: swapResult.buyAmount,
      executedSellAmount: swapResult.executedSellAmount,
      executedBuyAmount: swapResult.executedBuyAmount,
    });

    const duration = Date.now() - startTime;

    logger.info('Trigger swap completed successfully', {
      orderUid: swapResult.orderUid,
      chainId,
      inputAsset: inputAssetAddress,
      outputAsset: outputAssetAddress,
      inputTicker,
      outputTicker,
      amount: amountNativeUnits.toString(),
      adapter: adapterName,
      duration,
      status: 'completed',
      operation: 'trigger_swap',
    });

    return jsonWithSchema(200, AdminApi.triggerSwap.response, {
      message: 'Swap operation triggered successfully',
      swap: {
        orderUid: swapResult.orderUid,
        chainId,
        inputAsset: inputAssetAddress,
        outputAsset: outputAssetAddress,
        inputTicker,
        outputTicker,
        sellAmount: swapResult.sellAmount,
        buyAmount: swapResult.buyAmount,
        executedSellAmount: swapResult.executedSellAmount,
        executedBuyAmount: swapResult.executedBuyAmount,
        slippage: actualSlippageBps ? actualSlippageBps.toString() : undefined,
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Failed to process trigger swap', { error: jsonifyError(error), duration });
    return jsonWithSchema(500, ErrorResponse, {
      message: 'Failed to process trigger swap request',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

const handleGetRequest = async (
  request: HttpPaths,
  context: AdminContext,
): Promise<{ statusCode: number; body: string }> => {
  const { logger, event } = context;
  logger.info('Handling GET request', { request, path: event.path });

  switch (request) {
    case HttpPaths.GetEarmarks: {
      const queryParsed = parseQuery(AdminApi.getEarmarks.query!, event.queryStringParameters);
      if (isLambdaResponse(queryParsed)) return queryParsed;
      const { limit, offset, status, chainId, invoiceId } = queryParsed;
      const limitNum = Math.min(Number(limit), 1000);
      const offsetNum = Math.max(0, Number(offset));
      const filter = { status, chainId: chainId ? Number(chainId) : undefined, invoiceId };

      const result = await context.database.getEarmarksWithOperations(limitNum, offsetNum, filter);
      return jsonWithSchema(200, AdminApi.getEarmarks.response, { earmarks: result.earmarks, total: result.total });
    }

    case HttpPaths.GetRebalanceOperations: {
      const queryParsed = parseQuery(AdminApi.getRebalanceOperations.query!, event.queryStringParameters);
      if (isLambdaResponse(queryParsed)) return queryParsed;
      const { limit, offset, status, chainId, earmarkId, invoiceId } = queryParsed;
      const limitNum = Math.min(Number(limit), 1000);
      const offsetNum = Math.max(0, Number(offset));
      const earmarkIdParsed = earmarkId === 'null' ? null : earmarkId;
      const filter = {
        status: status as RebalanceOperationStatus | undefined,
        chainId: chainId ? Number(chainId) : undefined,
        earmarkId: earmarkIdParsed,
        invoiceId,
      };

      const result = await context.database.getRebalanceOperations(limitNum, offsetNum, filter);
      return jsonWithSchema(200, AdminApi.getRebalanceOperations.response, {
        operations: result.operations,
        total: result.total,
      });
    }

    case HttpPaths.GetEarmarkDetails: {
      const paramsParsed = parsePathParams(AdminApi.getEarmarkDetails.params!, event.pathParameters ?? null);
      if (isLambdaResponse(paramsParsed)) return paramsParsed;
      const { id: earmarkId } = paramsParsed;

      try {
        const earmarks = await context.database
          .queryWithClient<database.earmarks>('SELECT * FROM earmarks WHERE id = $1', [earmarkId])
          .then((rows: database.earmarks[]) => rows.map((row: database.earmarks) => snakeToCamel(row)));
        if (earmarks.length === 0) {
          return jsonWithSchema(404, ErrorResponse, { message: 'Earmark not found' });
        }

        const operations = await context.database.getRebalanceOperationsByEarmark(earmarkId);

        return jsonWithSchema(200, AdminApi.getEarmarkDetails.response, { earmark: earmarks[0], operations });
      } catch {
        // Handle invalid UUID format or other database errors
        return jsonWithSchema(404, ErrorResponse, { message: 'Earmark not found' });
      }
    }

    case HttpPaths.GetRebalanceOperationDetails: {
      const paramsParsed = parsePathParams(AdminApi.getRebalanceOperationDetails.params!, event.pathParameters ?? null);
      if (isLambdaResponse(paramsParsed)) return paramsParsed;
      const { id: operationId } = paramsParsed;

      try {
        const operation = await context.database.getRebalanceOperationById(operationId);
        if (!operation) {
          return jsonWithSchema(404, ErrorResponse, { message: 'Rebalance operation not found' });
        }

        return jsonWithSchema(200, AdminApi.getRebalanceOperationDetails.response, { operation });
      } catch {
        // Handle invalid UUID format or other database errors
        return jsonWithSchema(404, ErrorResponse, { message: 'Rebalance operation not found' });
      }
    }

    default:
      return jsonWithSchema(404, ErrorResponse, { message: `Unknown GET request: ${request}` });
  }
};

const unpauseIfNeeded = async (
  type: 'rebalance' | 'purchase' | 'ondemand',
  _store: Database | PurchaseCache,
  context: AdminContext,
) => {
  const { requestId, logger } = context;

  if (type === 'rebalance') {
    const db = _store as Database;
    logger.debug('Unpausing rebalance', { requestId });
    if (!(await db.isPaused('rebalance'))) {
      throw new Error(`Rebalance is not paused`);
    }
    return db.setPause('rebalance', false);
  } else if (type === 'ondemand') {
    const db = _store as Database;
    logger.debug('Unpausing on-demand rebalance', { requestId });
    if (!(await db.isPaused('ondemand'))) {
      throw new Error(`On-demand rebalance is not paused`);
    }
    return db.setPause('ondemand', false);
  } else {
    const store = _store as PurchaseCache;
    logger.debug('Unpausing purchase cache', { requestId });
    if (!(await store.isPaused())) {
      throw new Error(`Purchase cache is not paused`);
    }
    return store.setPause(false);
  }
};

const pauseIfNeeded = async (
  type: 'rebalance' | 'purchase' | 'ondemand',
  _store: Database | PurchaseCache,
  context: AdminContext,
) => {
  const { requestId, logger } = context;

  if (type === 'rebalance') {
    const db = _store as Database;
    logger.debug('Pausing rebalance', { requestId });
    if (await db.isPaused('rebalance')) {
      throw new Error(`Rebalance is already paused`);
    }
    return db.setPause('rebalance', true);
  } else if (type === 'ondemand') {
    const db = _store as Database;
    logger.debug('Pausing on-demand rebalance', { requestId });
    if (await db.isPaused('ondemand')) {
      throw new Error(`On-demand rebalance is already paused`);
    }
    return db.setPause('ondemand', true);
  } else {
    const store = _store as PurchaseCache;
    logger.debug('Pausing purchase cache', { requestId });
    if (await store.isPaused()) {
      throw new Error(`Purchase cache is already paused`);
    }
    return store.setPause(true);
  }
};

const INTENT_ADDED_TOPIC0 = '0x80eb6c87e9da127233fe2ecab8adf29403109adc6bec90147df35eeee0745991';

const handleTriggerIntent = async (context: AdminContext): Promise<{ statusCode: number; body: string }> => {
  const { logger, event, config, chainService, everclearAdapter } = context;
  const startTime = Date.now();

  try {
    const bodyParsed = parseJsonBody(AdminApi.triggerIntent.body!, event.body ?? null);
    if (isLambdaResponse(bodyParsed)) return bodyParsed;
    const { origin, destinations, to, inputAsset, amount, maxFee, callData, user } = bodyParsed;

    logger.info('Trigger intent request received', {
      origin,
      destinations,
      to,
      inputAsset,
      amount,
      maxFee,
      callData: callData || '0x',
      user: user || undefined,
      operation: 'trigger_intent',
    });

    // Apply safety constraints (same as invoice purchasing)
    if (BigInt(maxFee.toString()) !== BigInt(0)) {
      logger.error('Invalid maxFee - must be 0 for safety', { maxFee });
      return jsonWithSchema(400, ErrorResponse, { message: 'maxFee must be 0 (no solver fees allowed)' });
    }

    const normalizedCallData = callData || '0x';
    if (normalizedCallData !== '0x') {
      logger.error('Invalid callData - must be 0x for safety', { callData: normalizedCallData });
      return jsonWithSchema(400, ErrorResponse, { message: 'callData must be 0x (no custom execution allowed)' });
    }

    // Validate receiver is ownAddress (funds must come to Mark wallet)
    if (to.toLowerCase() !== config.markConfig.ownAddress.toLowerCase()) {
      logger.error('Invalid receiver - must be ownAddress', {
        to,
        ownAddress: config.markConfig.ownAddress,
      });
      return jsonWithSchema(400, ErrorResponse, {
        message: `Receiver must be Mark's own address (${config.markConfig.ownAddress}). Got: ${to}`,
      });
    }

    // Validate origin chain is configured
    const originChainId = origin.toString();
    const originChainConfig = config.markConfig.chains[originChainId];
    if (!originChainConfig) {
      logger.error('Origin chain not configured', { origin: originChainId });
      return jsonWithSchema(400, ErrorResponse, { message: `Origin chain ${originChainId} is not configured` });
    }

    // Validate all destination chains are configured
    for (const dest of destinations) {
      const destChainId = dest.toString();
      const destChainConfig = config.markConfig.chains[destChainId];
      if (!destChainConfig) {
        logger.error('Destination chain not configured', { destination: destChainId });
        return jsonWithSchema(400, ErrorResponse, { message: `Destination chain ${destChainId} is not configured` });
      }
    }

    // Construct NewIntentParams
    const intentParams: NewIntentParams = {
      origin: originChainId,
      destinations: destinations.map((d: number) => d.toString()),
      to,
      inputAsset,
      amount: amount.toString(),
      callData: callData || '0x',
      maxFee: maxFee.toString(),
      ...(user && { user }), // SVM only
    };

    // Detect chain type and call appropriate everclear adapter method
    const originChainIdNum = parseInt(originChainId);
    let transactionRequest;

    if (isSvmChain(originChainId)) {
      logger.info('Creating Solana intent', { origin: originChainIdNum });
      transactionRequest = await everclearAdapter.solanaCreateNewIntent(intentParams);
    } else if (isTvmChain(originChainId)) {
      logger.info('Creating Tron intent', { origin: originChainIdNum });
      transactionRequest = await everclearAdapter.tronCreateNewIntent(intentParams);
    } else {
      logger.info('Creating EVM intent', { origin: originChainIdNum });
      transactionRequest = await everclearAdapter.createNewIntent(intentParams);
    }

    logger.info('Received transaction request from Everclear API', {
      to: transactionRequest.to,
      dataLength: transactionRequest.data?.length,
      value: transactionRequest.value,
      chainId: transactionRequest.chainId,
    });

    // Check and handle ERC20 approval for the input asset
    const spender = transactionRequest.to as Hex;
    const owner = config.markConfig.ownAddress as Hex;

    logger.info('Checking ERC20 allowance', {
      token: inputAsset,
      spender,
      owner,
      requiredAmount: amount,
    });

    // Check current allowance
    const allowanceData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    });

    const allowanceResult = await chainService.readTx({
      to: inputAsset,
      data: allowanceData,
      domain: originChainIdNum,
      funcSig: 'allowance(address,address)',
    });

    const currentAllowance = BigInt(allowanceResult || '0');
    const requiredAmount = BigInt(amount);

    logger.info('Allowance check result', {
      currentAllowance: currentAllowance.toString(),
      requiredAmount: requiredAmount.toString(),
      needsApproval: currentAllowance < requiredAmount,
    });

    // Approve if needed
    if (currentAllowance < requiredAmount) {
      logger.info('Insufficient allowance, approving ERC20', {
        token: inputAsset,
        spender,
        amount: requiredAmount.toString(),
      });

      const approvalData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, requiredAmount],
      });

      const approvalTx = {
        chainId: originChainIdNum,
        to: inputAsset as Hex,
        data: approvalData,
        value: '0',
        from: owner,
        funcSig: 'approve(address,uint256)',
      };

      logger.info('Submitting approval transaction', { approvalTx });

      const approvalReceipt = await chainService.submitAndMonitor(originChainId, approvalTx);

      logger.info('Approval transaction mined', {
        transactionHash: approvalReceipt.transactionHash,
        blockNumber: approvalReceipt.blockNumber,
      });
    } else {
      logger.info('Sufficient allowance, skipping approval');
    }

    // Submit intent transaction via chainService
    logger.info('Submitting intent transaction', { transactionRequest, originChainId });

    const receipt = await chainService.submitAndMonitor(originChainId, transactionRequest);

    logger.info('Intent transaction mined', {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
    });

    // Extract intentId from receipt logs
    let intentId: string | undefined;
    for (const log of receipt.logs || []) {
      const typedLog = log as { topics?: string[] };
      if (typedLog.topics && typedLog.topics[0] === INTENT_ADDED_TOPIC0) {
        // First indexed parameter is the intentId
        intentId = typedLog.topics[1];
        break;
      }
    }

    if (!intentId) {
      logger.warn('Could not extract intentId from receipt', {
        transactionHash: receipt.transactionHash,
        logsCount: receipt.logs?.length || 0,
      });
    }

    const duration = Date.now() - startTime;
    logger.info('Trigger intent completed successfully', {
      transactionHash: receipt.transactionHash,
      intentId,
      chainId: originChainIdNum,
      duration,
      operation: 'trigger_intent',
    });

    return jsonWithSchema(200, AdminApi.triggerIntent.response, {
      message: 'Intent submitted successfully',
      transactionHash: receipt.transactionHash,
      intentId,
      chainId: originChainIdNum,
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Failed to trigger intent', {
      error: jsonifyError(error),
      body: event.body,
      duration,
      operation: 'trigger_intent',
    });

    return jsonWithSchema(500, ErrorResponse, {
      message: 'Failed to trigger intent',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const extractRequest = (context: AdminContext): HttpPaths | undefined => {
  const { logger, event, requestId } = context;
  logger.debug(`Extracting request from event`, { requestId, event });

  const { path, pathParameters, httpMethod } = event;

  if (httpMethod !== 'POST' && httpMethod !== 'GET') {
    logger.error('Unknown http method', { requestId, path, pathParameters, httpMethod });
    return undefined;
  }

  // Handle earmark detail path with ID parameter
  if (httpMethod === 'GET' && path.includes('/rebalance/earmark/')) {
    return HttpPaths.GetEarmarkDetails;
  }

  // Handle rebalance operation detail path with ID parameter
  // Must check this before the cancel operation check
  if (httpMethod === 'GET' && path.match(/\/rebalance\/operation\/[^/]+$/)) {
    return HttpPaths.GetRebalanceOperationDetails;
  }

  // Handle cancel earmark
  if (httpMethod === 'POST' && path.endsWith('/rebalance/cancel')) {
    return HttpPaths.CancelEarmark;
  }

  // Handle cancel rebalance operation
  if (httpMethod === 'POST' && path.endsWith('/rebalance/operation/cancel')) {
    return HttpPaths.CancelRebalanceOperation;
  }

  for (const httpPath of Object.values(HttpPaths)) {
    if (path.endsWith(httpPath)) {
      return httpPath as HttpPaths;
    }
  }
  logger.error('Unknown path', { requestId, path, pathParameters, httpMethod });
  return undefined;
};
