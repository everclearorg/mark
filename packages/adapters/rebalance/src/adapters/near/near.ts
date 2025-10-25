// bridgeAdapters/near.ts
import {
  encodeFunctionData,
  erc20Abi,
  PublicClient,
  TransactionReceipt,
  zeroAddress,
  TransactionRequestBase,
  http,
  createPublicClient,
} from 'viem';
import { AssetConfiguration, ChainConfiguration, RebalanceRoute, SupportedBridge } from '@mark/core';
import {
  GetExecutionStatusResponse,
  OneClickService,
  OpenAPI,
  Quote,
  QuoteRequest,
  QuoteResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { DepositStatusResponse } from './types';
import { EOA_ADDRESS, NEAR_IDENTIFIER_MAP } from './constants';
import { getDepositFromLogs, parseDepositLogs } from './utils';
import { findAssetByAddress, findMatchingDestinationAsset } from '../../shared/asset';

const wethAbi = [
  ...erc20Abi,
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;

// Structure to hold callback info
interface CallbackInfo {
  needsCallback: boolean;
  amount?: bigint;
  recipient?: string;
  asset?: AssetConfiguration;
}

export class NearBridgeAdapter implements BridgeAdapter {
  // Maximum amounts per asset symbol to send in a single rebalance operation
  private readonly ASSET_CAPS: Record<string, bigint> = {
    WETH: BigInt('1000000000000000000'), // 1 WETH
    USDC: BigInt('50000000000'), // 50,000 USDC
    USDT: BigInt('50000000000'), // 50,000 USDT
  };

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    private readonly jwtToken: string | undefined,
    private readonly baseUrl: string,
    private readonly logger: Logger,
  ) {
    this.logger.debug('Initializing NearBridgeAdapter');

    if (!this.jwtToken) {
      throw new Error('NEAR JWT token is required. Please set NEAR_JWT_TOKEN environment variable.');
    }

    OpenAPI.BASE = this.baseUrl;
    OpenAPI.TOKEN = this.jwtToken;
    this.logger.debug('NEAR API configured with JWT auth', {
      apiBase: OpenAPI.BASE,
    });
  }

  type(): SupportedBridge {
    return SupportedBridge.Near;
  }

  private getCappedAmount(amount: string, assetSymbol: string | undefined): string {
    if (!assetSymbol || !this.ASSET_CAPS[assetSymbol]) {
      return amount;
    }

    const cap = this.ASSET_CAPS[assetSymbol];
    const amountBigInt = BigInt(amount);

    if (amountBigInt > cap) {
      this.logger.warn(`Capping: ${assetSymbol} amount exceeds maximum, applying cap`, {
        originalAmount: amount,
        cappedAmount: cap.toString(),
        assetSymbol,
      });
      return cap.toString();
    }

    return amount;
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    let _amount = amount;
    try {
      const originAsset = this.getAsset(route.asset, route.origin);
      _amount = this.getCappedAmount(amount, originAsset?.symbol);

      // Log if amount was capped for visibility
      if (_amount !== amount) {
        this.logger.info('Near bridge amount was capped', {
          originalAmount: amount,
          cappedAmount: _amount,
          assetSymbol: originAsset?.symbol,
          route,
        });
      }

      const { quote } = await this.getSuggestedFees(route, EOA_ADDRESS, EOA_ADDRESS, _amount);
      return quote.amountOut;
    } catch (error) {
      this.handleError(error, 'get received amount from Near failed', { _amount, route });
    }
  }

  async send(
    refundTo: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      const originAsset = this.getAsset(route.asset, route.origin);
      const _amount = this.getCappedAmount(amount, originAsset?.symbol);

      // If origin is WETH then we need to unwrap
      const needsUnwrap = originAsset?.symbol === 'WETH';

      const quote = await this.getSuggestedFees(route, refundTo, recipient, _amount);

      if (needsUnwrap) {
        this.logger.debug('Preparing WETH unwrap transaction before Near bridge deposit', {
          wethAddress: route.asset,
          amount: _amount,
        });

        const unwrapTx = {
          memo: RebalanceTransactionMemo.Unwrap,
          transaction: {
            to: route.asset as `0x${string}`,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: 'withdraw',
              args: [BigInt(_amount)],
            }) as `0x${string}`,
            value: BigInt(0),
          },
        };

        const depositTx = this.buildDepositTx(zeroAddress, quote.quote, _amount);
        return [unwrapTx, depositTx].filter((x) => !!x);
      } else {
        // For all other cases, just build the deposit transaction
        const depositTx = this.buildDepositTx(route.asset, quote.quote, _amount);
        return [depositTx].filter((x) => !!x);
      }
    } catch (err) {
      this.logger.error('OneClick send failed', { error: err });
      throw err;
    }
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    try {
      const provider = this.chains[route.origin]?.providers?.[0];
      const value = await this.getTransactionValue(provider, originTransaction);
      const depositAddress = this.extractDepositAddress(route.origin, originTransaction, value);
      if (!depositAddress) {
        throw new Error('No deposit address found in transaction receipt');
      }

      const statusData = await this.getDepositStatusFromApi(depositAddress);
      if (!statusData || statusData.status !== GetExecutionStatusResponse.status.SUCCESS) {
        throw new Error(`Transaction (depositAddress: ${depositAddress}}) is not yet filled`);
      }

      // Extract fillTx if available - it might not be immediately available even for SUCCESS status
      const destinationTxHashes = statusData?.swapDetails.destinationChainTxHashes;
      const fillTx = destinationTxHashes && destinationTxHashes.length > 0 ? destinationTxHashes[0].hash : undefined;

      if (!fillTx) {
        // If no fill transaction hash is available but status is SUCCESS,
        // we can skip the callback check as the bridge has completed
        this.logger.info('Transaction succeeded but no fill transaction hash available, skipping callback', {
          depositAddress,
          status: statusData.status,
        });
        return;
      }

      const callbackInfo = await this.requiresCallback(
        route,
        depositAddress,
        BigInt(statusData.swapDetails.amountIn!),
        fillTx,
      );
      if (!callbackInfo.needsCallback) {
        return;
      }

      const originAsset = findAssetByAddress(route.asset, route.origin, this.chains, this.logger);
      if (!originAsset) {
        throw new Error('Could not find origin asset');
      }

      // Only WETH transfers need wrapping callbacks
      if (originAsset.symbol.toLowerCase() !== 'weth') {
        this.logger.debug('Asset is not WETH, no callback needed', { route, originAsset });
        return;
      }

      this.logger.debug('Found WETH origin asset', { route, originAsset });
      const destinationWETH = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        this.chains,
        this.logger,
        route.destinationAsset,
      );
      if (!destinationWETH) {
        throw new Error('Failed to find destination WETH');
      }

      const callbackTx: TransactionRequestBase = {
        to: destinationWETH.address as `0x${string}`,
        data: '0xd0e30db0' as `0x${string}`, // deposit() function selector
        value: callbackInfo.amount!,
      };

      this.logger.debug('Destination callback transaction prepared', {
        callbackTx,
        depositTxHash: fillTx,
        originTxHash: originTransaction.transactionHash,
      });

      return { transaction: callbackTx, memo: RebalanceTransactionMemo.Wrap };
    } catch (error) {
      this.logger.error('destinationCallback failed', {
        error: jsonifyError(error),
        route,
        originTxHash: originTransaction.transactionHash,
        originChain: route.origin,
        destinationChain: route.destination,
        errorMessage: (error as Error)?.message,
        errorStack: (error as Error)?.stack,
      });

      this.handleError(error, 'prepare destination callback', {
        route,
        transactionHash: originTransaction.transactionHash,
        originChain: route.origin,
        destinationChain: route.destination,
      });
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    this.logger.debug('readyOnDestination called', {
      amount,
      route,
      transactionHash: originTransaction.transactionHash,
    });

    try {
      // Get deposit status from shared helper method
      const statusData = await this.getDepositStatus(route, originTransaction);

      // If no status found, return false
      if (!statusData) {
        return false;
      }

      // Return true if the deposit is filled
      const isReady = statusData.status === GetExecutionStatusResponse.status.SUCCESS;
      this.logger.debug('Deposit ready status determined', {
        isReady,
        statusData,
      });

      return isReady;
    } catch (error) {
      this.logger.error('Failed to check if transaction is ready on destination', {
        error: jsonifyError(error),
        amount,
        route,
        transactionHash: originTransaction.transactionHash,
      });
      return false;
    }
  }
  protected async getTransactionValue(provider: string, originTransaction: TransactionReceipt): Promise<bigint> {
    const client = createPublicClient({ transport: http(provider) });
    const transaction = await client.getTransaction({
      hash: originTransaction.transactionHash as `0x${string}`,
    });
    return transaction.value;
  }

  protected async getDepositStatus(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<DepositStatusResponse | undefined> {
    try {
      // Finding the deposit value
      const provider = this.chains[route.origin]?.providers?.[0];
      const value = await this.getTransactionValue(provider, originTransaction);
      // Note: value can be 0n for ERC20 token transfers (USDC, USDT, etc.)
      // Only warn if value retrieval fails completely (null/undefined)
      if (value === null || value === undefined) {
        this.logger.warn('Failed to retrieve transaction value', {
          transactionHash: originTransaction.transactionHash,
        });
        return undefined;
      }

      // Extract deposit address from the transaction receipt
      const depositAddress = this.extractDepositAddress(route.origin, originTransaction, value);

      if (!depositAddress) {
        this.logger.warn('No deposit ID found in transaction receipt', {
          transactionHash: originTransaction.transactionHash,
        });
        return undefined;
      }

      this.logger.debug('Extracted deposit address from transaction receipt', {
        depositAddress,
        transactionHash: originTransaction.transactionHash,
      });

      // Check deposit status
      this.logger.debug('Checking deposit status via OneClick API', {
        originChainId: route.origin,
        depositAddress,
      });

      const statusData = await this.getDepositStatusFromApi(depositAddress);
      if (!statusData) {
        this.logger.warn('No deposit status found', {
          depositAddress,
        });
        return undefined;
      }

      this.logger.debug('Received deposit status from OneClick API', {
        statusData,
      });

      const destinationTxHashes = statusData.swapDetails.destinationChainTxHashes;

      // If status is SUCCESS, return the status data even if destination hashes aren't available yet
      if (statusData.status === GetExecutionStatusResponse.status.SUCCESS) {
        const fillTx = destinationTxHashes && destinationTxHashes.length > 0 ? destinationTxHashes[0].hash : undefined;

        if (!fillTx) {
          this.logger.warn('NEAR reports SUCCESS but no destination transaction hashes available yet', {
            status: statusData.status,
            depositAddress,
            originTxHash: originTransaction.transactionHash,
            note: 'Transaction completed successfully, fill hash will be available later',
          });
        }

        return {
          status: statusData.status,
          originChainId: route.origin,
          depositId: depositAddress,
          depositTxHash: originTransaction.transactionHash,
          fillTx: fillTx || '', // Empty string if not yet available
          destinationChainId: route.destination,
          depositRefundTxHash: '',
        };
      }

      // For non-SUCCESS statuses, require destination hashes
      if (!destinationTxHashes || destinationTxHashes.length === 0) {
        this.logger.debug('No destination transaction hashes available yet', {
          status: statusData.status,
        });
        return undefined;
      }

      const fillTx = destinationTxHashes[0].hash;
      if (!fillTx) {
        this.logger.warn('No fill transaction hash found', {
          statusData,
        });
        return undefined;
      }

      return {
        status: statusData.status,
        originChainId: route.origin,
        depositId: depositAddress,
        depositTxHash: originTransaction.transactionHash,
        fillTx: fillTx,
        destinationChainId: route.destination,
        depositRefundTxHash: '',
      };
    } catch (error) {
      this.logger.error('Failed to get deposit status', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      throw error;
    }
  }

  protected getAsset(asset: string, chain: number): AssetConfiguration | undefined {
    this.logger.debug('Finding matching asset', { asset, chain });

    const chainConfig = this.chains[chain.toString()];
    if (!chainConfig) {
      this.logger.warn(`Chain configuration not found`, { asset, chain });
      return undefined;
    }

    return chainConfig.assets.find((a: AssetConfiguration) => a.address.toLowerCase() === asset.toLowerCase());
  }

  // Helper method to find the matching destination token address
  protected findMatchingDestinationAsset(
    asset: string,
    origin: number,
    destination: number,
  ): AssetConfiguration | undefined {
    this.logger.debug('Finding matching destination asset', { asset, origin, destination });

    const destinationChainConfig = this.chains[destination.toString()];

    if (!destinationChainConfig) {
      this.logger.warn(`Destination chain configuration not found`, { asset, origin, destination });
      return undefined;
    }

    // Find the asset in the origin chain
    const originAsset = this.getAsset(asset, origin);
    if (!originAsset) {
      this.logger.warn(`Asset not found on origin chain`, { asset, origin });
      return undefined;
    }

    this.logger.debug('Found asset in origin chain', {
      asset,
      origin,
      originAsset,
    });

    // Find the matching asset in the destination chain by symbol
    const destinationAsset = destinationChainConfig.assets.find(
      (a: AssetConfiguration) => a.symbol.toLowerCase() === originAsset.symbol.toLowerCase(),
    );

    if (!destinationAsset) {
      this.logger.warn(`Matching asset not found in destination chain`, {
        asset: originAsset,
        destination,
      });
      return undefined;
    }

    this.logger.debug('Found matching asset in destination chain', {
      originAsset,
      destinationAsset,
    });

    return destinationAsset;
  }

  protected extractDepositAddress(origin: number, receipt: TransactionReceipt, value: bigint): string | undefined {
    this.logger.debug('Extracting deposit address from transaction receipt', {
      transactionHash: receipt.transactionHash,
      logsCount: receipt.logs.length,
    });

    try {
      if (receipt.logs.length > 0) {
        const logs = getDepositFromLogs({ originChainId: origin, receipt, value });
        return logs.receiverAddress;
      } else {
        return receipt.to as `0x${string}`;
      }
    } catch (error) {
      this.logger.error('Error extracting deposit ID from receipt', {
        error: jsonifyError(error),
        transactionHash: receipt.transactionHash,
      });

      return undefined;
    }
  }

  /**
   * Determines if a callback is needed for a transaction and returns relevant information
   * @param route The rebalance route
   * @param fillTxHash The hash of the fill transaction
   * @returns Object with needsCallback flag and fill information if available
   */
  protected async requiresCallback(
    route: RebalanceRoute,
    depositAddress: string,
    inputAmount: bigint,
    fillTxHash: string,
  ): Promise<CallbackInfo> {
    const originAsset = this.getAsset(route.asset, route.origin);
    if (!originAsset) {
      throw new Error('Could not find origin asset');
    }

    const destinationNative = this.findMatchingDestinationAsset(zeroAddress, 1, route.destination);
    if (!destinationNative || destinationNative.symbol !== 'ETH') {
      return { needsCallback: false };
    }

    const provider = this.chains[route.destination]?.providers?.[0];
    if (!provider) {
      return { needsCallback: false };
    }

    const client = createPublicClient({ transport: http(provider) });

    const fillTransaction = await client.getTransaction({
      hash: fillTxHash as `0x${string}`,
    });
    const fillReceipt = await client.getTransactionReceipt({ hash: fillTxHash as `0x${string}` });

    const decodedEvent = parseDepositLogs(fillReceipt, fillTransaction.value, {
      depositAddress: depositAddress as `0x${string}`,
      inputAmount: inputAmount,
    });

    if (!decodedEvent) {
      throw new Error(`Failed to find fill logs from receipt`);
    }

    const outputAmount = decodedEvent.amount;
    const recipient = decodedEvent.receiverAddress;
    const balance = await this.getTokenBalance(zeroAddress, decodedEvent.receiverAddress, client);

    if (decodedEvent.tokenAddress === zeroAddress) {
      return { needsCallback: balance >= outputAmount, amount: outputAmount, recipient };
    }

    // NOTE: The origin tx would be sending ETH and destination would need to find WETH to wrap it
    const destinationWeth = this.findMatchingDestinationAsset(originAsset.address, route.origin, route.destination);
    if (!destinationWeth) {
      this.logger.debug('No destination WETH found, no callback', { route, event: decodedEvent });
      return { needsCallback: false };
    }

    if (decodedEvent.tokenAddress.toLowerCase() !== destinationWeth.address.toLowerCase()) {
      this.logger.debug('Output token is not weth', { route, event: decodedEvent });
      return { needsCallback: false, amount: outputAmount, recipient };
    }

    return {
      needsCallback: balance >= outputAmount,
      amount: outputAmount,
      recipient,
      asset: destinationWeth,
    };
  }

  protected async getTokenBalance(tokenAddress: string, owner: string, client: PublicClient): Promise<bigint> {
    const ownerAddress = owner as `0x${string}`;

    if (tokenAddress.toLowerCase() === zeroAddress.toLowerCase()) {
      // Native balance
      const balance = await client.getBalance({ address: ownerAddress });
      this.logger.debug('Fetched native balance', { owner, balance: balance.toString() });
      return balance;
    }
    // ERC20 token balance
    const contractAddress = tokenAddress as `0x${string}`;
    const balance = await client.readContract({
      address: contractAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ownerAddress],
    });
    this.logger.debug('Fetched ERC20 token balance', { owner, tokenAddress, balance: balance.toString() });
    return balance;
  }

  protected async getSuggestedFees(
    route: RebalanceRoute,
    refundTo: string,
    receiver: string,
    amount: string,
  ): Promise<QuoteResponse> {
    const { inputAssetIdentifier, outputAssetIdentifier } = this.getIdentifiers(route);

    const quote = await OneClickService.getQuote({
      dry: false,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: 10,
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      originAsset: inputAssetIdentifier,
      destinationAsset: outputAssetIdentifier,
      amount,
      refundTo: refundTo,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: receiver,
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline: new Date(Date.now() + 5 * 60000).toISOString(), // 5 minutes
    });

    return quote;
  }

  protected async getDepositStatusFromApi(depositAddress: string): Promise<GetExecutionStatusResponse | undefined> {
    try {
      // The SDK's getExecutionStatus uses the wrong endpoint
      // We need to call /v0/status?depositAddress={address} directly
      const url = `${this.baseUrl}/v0/status?depositAddress=${depositAddress}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.jwtToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.debug('Deposit not found', { depositAddress, status: response.status });
          return undefined;
        }
        throw new Error(`API request failed with status ${response.status}`);
      }

      const data = await response.json();

      // Transform the response to match the expected format
      // The /v0/status endpoint returns the data directly with status at the top level
      return data as GetExecutionStatusResponse;
    } catch (error) {
      this.logger.error('Failed to get deposit status', {
        error: jsonifyError(error),
        depositAddress,
        endpoint: '/v0/status',
      });
      return undefined;
    }
  }

  // Helper for error handling
  protected handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(`Failed to ${context}: ${(error as any)?.message ?? ''}`);
  }

  protected buildDepositTx(inputAsset: string, quote: Quote, effectiveAmount?: string): MemoizedTransactionRequest {
    if (inputAsset === zeroAddress) {
      return {
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount,
        transaction: {
          to: quote.depositAddress as `0x${string}`,
          data: '0x',
          value: BigInt(quote.amountIn),
        },
      };
    } else {
      return {
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount,
        transaction: {
          to: inputAsset as `0x${string}`,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [quote.depositAddress as `0x${string}`, BigInt(quote.amountIn)],
          }),
          value: BigInt(0),
        },
      };
    }
  }

  private getIdentifiers(route: RebalanceRoute): { inputAssetIdentifier: string; outputAssetIdentifier: string } {
    // First, get the asset configuration to find the symbol
    const originAsset = this.getAsset(route.asset, route.origin);
    if (!originAsset) {
      throw new Error('Could not find matching input asset');
    }

    // For WETH, we need to use ETH identifier since we unwrap WETH to ETH before bridging
    const inputSymbol = originAsset.symbol === 'WETH' ? 'ETH' : originAsset.symbol;

    // Use the symbol to look up the Near identifier
    const inputAssetIdentifier =
      NEAR_IDENTIFIER_MAP[inputSymbol as keyof typeof NEAR_IDENTIFIER_MAP]?.[
        route.origin as keyof (typeof NEAR_IDENTIFIER_MAP)[keyof typeof NEAR_IDENTIFIER_MAP]
      ];
    if (!inputAssetIdentifier) {
      throw new Error('Could not find matching input identifier');
    }

    const outputAsset = findMatchingDestinationAsset(
      route.asset,
      route.origin,
      route.destination,
      this.chains,
      this.logger,
      route.destinationAsset,
    );
    if (!outputAsset) {
      throw new Error(`Could not find destination asset for route`);
    }

    // For WETH routes, we bridge as ETH and wrap on destination if needed
    const outputSymbol = outputAsset.symbol === 'WETH' ? 'ETH' : outputAsset.symbol;

    const outputAssetIdentifier =
      NEAR_IDENTIFIER_MAP[outputSymbol as keyof typeof NEAR_IDENTIFIER_MAP]?.[
        route.destination as keyof (typeof NEAR_IDENTIFIER_MAP)[keyof typeof NEAR_IDENTIFIER_MAP]
      ];
    if (!outputAssetIdentifier) {
      throw new Error(`Could not find matching output identifier: ${outputSymbol} for ${route.destination}`);
    }

    return { inputAssetIdentifier, outputAssetIdentifier };
  }

  // Helper for asset validation
  protected validateAsset(asset: AssetConfiguration | undefined, expectedSymbol: string, context: string): void {
    if (!asset) {
      throw new Error(`Missing asset configs for ${context}`);
    }
    if (asset.symbol.toLowerCase() !== expectedSymbol.toLowerCase()) {
      throw new Error(`Expected ${expectedSymbol}, but found ${asset.symbol}`);
    }
  }
}
