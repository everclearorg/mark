import { TransactionReceipt, createPublicClient, http, Address, Hex, zeroAddress, encodeFunctionData, decodeFunctionData } from 'viem';
import { SupportedBridge, RebalanceRoute, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { USDC_USDT_PAIRS } from './types';

// CowSwap SDK imports
import {
  OrderBookApi,
  SupportedChainId,
  OrderQuoteRequest,
  OrderQuoteResponse,
  OrderCreation,
  SigningScheme,
  computeOrderUid,
  GPV2SettlementAbi,
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
  OrderBalance,
} from '@cowprotocol/cow-sdk';

interface CowSwapOrderData {
  orderCreation: OrderCreation;
  orderUid: Hex;
  route: RebalanceRoute;
  timestamp: number;
}

export class CowSwapBridgeAdapter implements BridgeAdapter {
  private readonly orderBookApi: Map<number, OrderBookApi>;
  private readonly orderCache: Map<string, CowSwapOrderData>;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
    private readonly rebalanceCache?: RebalanceCache,
  ) {
    this.orderBookApi = new Map();
    this.orderCache = new Map();
    this.logger.debug('Initializing CowSwapBridgeAdapter with production setup');
  }

  private getOrderBookApi(chainId: number): OrderBookApi {
    if (!this.orderBookApi.has(chainId)) {
      const api = new OrderBookApi({ chainId: chainId as SupportedChainId });
      this.orderBookApi.set(chainId, api);
    }
    return this.orderBookApi.get(chainId)!;
  }

  type(): SupportedBridge {
    return 'cowswap' as SupportedBridge;
  }

  private getTokenPair(chainId: number): { usdc: string; usdt: string } {
    const pair = USDC_USDT_PAIRS[chainId];
    if (!pair) {
      throw new Error(`USDC/USDT pair not configured for chain ${chainId}`);
    }
    return pair;
  }

  private validateSameChainSwap(route: RebalanceRoute): void {
    if (route.origin !== route.destination) {
      throw new Error('CowSwap adapter only supports same-chain swaps');
    }

    const pair = this.getTokenPair(route.origin);
    const validAssets = [pair.usdc.toLowerCase(), pair.usdt.toLowerCase()];

    if (!validAssets.includes(route.asset.toLowerCase())) {
      throw new Error(`CowSwap adapter only supports USDC/USDT swaps. Got asset: ${route.asset}`);
    }
  }

  private determineSwapDirection(route: RebalanceRoute): { sellToken: string; buyToken: string } {
    const pair = this.getTokenPair(route.origin);
    const asset = route.asset.toLowerCase();

    if (asset === pair.usdc.toLowerCase()) {
      return { sellToken: pair.usdc, buyToken: pair.usdt };
    } else if (asset === pair.usdt.toLowerCase()) {
      return { sellToken: pair.usdt, buyToken: pair.usdc };
    } else {
      throw new Error(`Invalid asset for USDC/USDT swap: ${route.asset}`);
    }
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      this.validateSameChainSwap(route);

      const { sellToken, buyToken } = this.determineSwapDirection(route);
      const orderBookApi = this.getOrderBookApi(route.origin);

      const quoteRequest: OrderQuoteRequest = {
        sellToken: sellToken,
        buyToken: buyToken,
        from: zeroAddress,
        receiver: zeroAddress,
        sellAmountBeforeFee: amount,
        kind: 'sell' as any,
      };

      const quoteResponse: OrderQuoteResponse = await orderBookApi.getQuote(quoteRequest);

      this.logger.debug('CowSwap SDK quote obtained', {
        sellAmount: amount,
        buyAmount: quoteResponse.quote.buyAmount,
        feeAmount: quoteResponse.quote.feeAmount,
        route,
      });

      return quoteResponse.quote.buyAmount;
    } catch (error) {
      this.handleError(error, 'get received amount from CowSwap SDK', { amount, route });
    }
  }

  private generateOrderUid(order: OrderCreation, owner: string, chainId: number): Hex {
    // Use CowSwap SDK to generate proper order UID
    const domain = {
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: chainId,
      verifyingContract: COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[chainId as SupportedChainId],
    };

    // Convert OrderCreation to Order format expected by computeOrderUid
    const orderForUid = {
      ...order,
      receiver: order.receiver || zeroAddress,
      sellTokenBalance: (order.sellTokenBalance as unknown as OrderBalance) || ('erc20' as OrderBalance),
      buyTokenBalance: (order.buyTokenBalance as unknown as OrderBalance) || ('erc20' as OrderBalance),
    };

    return computeOrderUid(domain, orderForUid, owner) as Hex;
  }

  private createPreSignTransaction(orderUid: Hex, chainId: number): { to: Address; data: Hex } {
    // Create transaction to call setPreSignature(bytes32 orderUid, bool signed)
    const settlementAddress = COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[chainId as SupportedChainId];

    const data = encodeFunctionData({
      abi: GPV2SettlementAbi,
      functionName: 'setPreSignature',
      args: [orderUid, true],
    });

    return {
      to: settlementAddress as Address,
      data,
    };
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      this.validateSameChainSwap(route);

      const { sellToken, buyToken } = this.determineSwapDirection(route);
      const orderBookApi = this.getOrderBookApi(route.origin);

      const quoteRequest: OrderQuoteRequest = {
        sellToken: sellToken,
        buyToken: buyToken,
        from: zeroAddress,
        receiver: zeroAddress,
        sellAmountBeforeFee: amount,
        kind: 'sell' as any,
      };

      const quoteResponse: OrderQuoteResponse = await orderBookApi.getQuote(quoteRequest);

      // Create the order that will be pre-signed
      const orderCreation: OrderCreation = {
        ...quoteResponse.quote,
        receiver: recipient,
        from: sender,
        signature: '0x', // Empty signature for pre-signed orders
        signingScheme: SigningScheme.PRESIGN,
      };

      // Generate order UID for pre-signing
      const orderUid = this.generateOrderUid(orderCreation, sender, route.origin);

      this.logger.debug('CowSwap order prepared', {
        orderUid,
        sellAmount: amount,
        buyAmount: quoteResponse.quote.buyAmount,
        feeAmount: quoteResponse.quote.feeAmount,
        route,
      });

      // Store order data for submission in destinationCallback
      const orderData: CowSwapOrderData = {
        orderCreation,
        orderUid,
        route,
        timestamp: Date.now(),
      };

      // Store in local cache for immediate access
      this.orderCache.set(orderUid, orderData);

      // Also store in persistent cache if available
      if (this.rebalanceCache) {
        try {
          // Use the Redis store directly for CowSwap order data
          await (this.rebalanceCache as any).store.set(`cowswap:order:${orderUid}`, JSON.stringify(orderData));
        } catch (error) {
          this.logger.warn('Failed to store order data in cache', {
            error: jsonifyError(error),
            orderUid,
          });
        }
      }

      // Create pre-sign transaction for the order
      const preSignTx = this.createPreSignTransaction(orderUid, route.origin);

      const orderSubmissionTx: MemoizedTransactionRequest = {
        memo: RebalanceTransactionMemo.Rebalance,
        transaction: {
          to: preSignTx.to,
          data: preSignTx.data,
          value: BigInt(0),
          from: sender as Address,
        },
      };

      this.logger.debug('CowSwap order transaction prepared', {
        orderUid,
        orderDataCached: true,
        route,
      });

      return [orderSubmissionTx];
    } catch (error) {
      this.handleError(error, 'prepare CowSwap order', { amount, route });
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    try {
      this.validateSameChainSwap(route);

      const providers = this.chains[route.destination.toString()]?.providers ?? [];
      if (!providers.length) {
        this.logger.error('No providers found for destination chain', { chainId: route.destination });
        return false;
      }

      const client = createPublicClient({ transport: http(providers[0]) });

      // Check if the trading transaction was successful
      const receipt = await client.getTransactionReceipt({
        hash: originTransaction.transactionHash as `0x${string}`,
      });

      if (!receipt || receipt.status !== 'success') {
        this.logger.debug('Trade transaction not successful yet', {
          transactionHash: originTransaction.transactionHash,
          status: receipt?.status,
        });
        return false;
      }

      // With the Trading SDK, the swap should be executed automatically
      // We just need to verify the transaction was successful
      this.logger.debug('CowSwap trade completed', {
        transactionHash: originTransaction.transactionHash,
        route,
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to check if ready on destination', {
        error: jsonifyError(error),
        amount,
        route,
        transactionHash: originTransaction.transactionHash,
      });
      return false;
    }
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    try {
      this.validateSameChainSwap(route);

      // Extract orderUid from the setPreSignature transaction data
      // We need to fetch the full transaction to get the input data
      const providers = this.chains[route.origin.toString()]?.providers ?? [];
      if (!providers.length) {
        this.logger.error('No providers found for origin chain', { chainId: route.origin });
        return;
      }
      
      const client = createPublicClient({ transport: http(providers[0]) });
      
      let orderUid: Hex;
      try {
        // Fetch the full transaction to get input data
        const fullTransaction = await client.getTransaction({
          hash: originTransaction.transactionHash as `0x${string}`,
        });
        
        if (!fullTransaction.input) {
          this.logger.error('No input data found in transaction', {
            transactionHash: originTransaction.transactionHash,
          });
          return;
        }
        
        const decoded = decodeFunctionData({
          abi: GPV2SettlementAbi,
          data: fullTransaction.input,
        });
        
        if (decoded.functionName !== 'setPreSignature') {
          this.logger.error('Transaction is not a setPreSignature call', {
            functionName: decoded.functionName,
            transactionHash: originTransaction.transactionHash,
          });
          return;
        }
        
        if (!decoded.args || decoded.args.length < 1) {
          this.logger.error('Invalid setPreSignature arguments', {
            args: decoded.args,
            transactionHash: originTransaction.transactionHash,
          });
          return;
        }
        
        orderUid = decoded.args[0] as Hex; // First argument is the orderUid
        
        this.logger.debug('Extracted orderUid from pre-sign transaction', {
          orderUid,
          transactionHash: originTransaction.transactionHash,
        });
      } catch (error) {
        this.logger.error('Failed to decode setPreSignature transaction', {
          error: jsonifyError(error),
          transactionHash: originTransaction.transactionHash,
        });
        return;
      }
      
      // Retrieve the cached order data using the extracted orderUid
      let orderData: CowSwapOrderData | undefined;
      
      // First check local cache
      orderData = this.orderCache.get(orderUid);
      
      // If not found in local cache, check persistent cache
      if (!orderData && this.rebalanceCache) {
        try {
          const cachedDataStr = await (this.rebalanceCache as any).store.get(`cowswap:order:${orderUid}`);
          if (cachedDataStr) {
            orderData = JSON.parse(cachedDataStr) as CowSwapOrderData;
            // Store back in local cache for faster access
            this.orderCache.set(orderUid, orderData);
          }
        } catch (error) {
          this.logger.warn('Failed to retrieve order data from persistent cache', {
            error: jsonifyError(error),
            orderUid,
          });
        }
      }
      
      if (!orderData) {
        this.logger.error('No order data found for orderUid', {
          orderUid,
          transactionHash: originTransaction.transactionHash,
        });
        return;
      }

      // We already have orderData from the search above

      const orderBookApi = this.getOrderBookApi(route.origin);

      this.logger.debug('CowSwap destinationCallback - submitting order to orderbook', {
        orderUid,
        route,
        transactionHash: originTransaction.transactionHash,
      });

      try {
        // Submit the order to the orderbook
        const submittedOrderUid = await orderBookApi.sendOrder(orderData.orderCreation);

        this.logger.info('CowSwap order submitted successfully', {
          originalOrderUid: orderUid,
          submittedOrderUid,
          route,
        });

        // Clean up cache after successful submission
        this.orderCache.delete(orderUid);
        if (this.rebalanceCache) {
          await (this.rebalanceCache as any).store.del(`cowswap:order:${orderUid}`);
        }
      } catch (submitError) {
        this.logger.error('Failed to submit order to CowSwap orderbook', {
          error: jsonifyError(submitError),
          orderUid,
          route,
        });
        // Don't throw - let the system retry later
      }

      return;
    } catch (error) {
      this.logger.error('Failed to handle destination callback', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      return;
    }
  }

  private handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    throw new Error(`Failed to ${context}: ${(error as unknown as Error)?.message ?? 'Unknown error'}`);
  }
}
