import {
  TransactionReceipt,
  createPublicClient,
  createWalletClient,
  http,
  Address,
  zeroAddress,
  defineChain,
  erc20Abi,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { SupportedBridge, RebalanceRoute, ChainConfiguration, fromEnv } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, SwapExecutionResult } from '../../types';
import { USDC_USDT_PAIRS, COWSWAP_VAULT_RELAYER_ADDRESSES, SUPPORTED_NETWORKS } from './types';

// CowSwap SDK imports
import {
  OrderBookApi,
  SupportedChainId,
  OrderQuoteRequest,
  OrderQuoteResponse,
  OrderCreation,
  SigningScheme,
  OrderKind,
  OrderQuoteSideKindSell,
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
} from '@cowprotocol/cow-sdk';

interface WalletContext {
  account: PrivateKeyAccount;
  walletClient: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  rpcUrl: string;
  chain: ReturnType<typeof defineChain>;
}

type CowSwapOrderStatus = {
  uid: string;
  status: string;
  executedSellAmount?: string;
  executedBuyAmount?: string;
  sellAmount?: string;
  buyAmount?: string;
  sellToken?: string;
  buyToken?: string;
};

export class CowSwapBridgeAdapter implements BridgeAdapter {
  private readonly orderBookApi: Map<number, OrderBookApi>;
  private readonly walletContexts: Map<number, Promise<WalletContext>>;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.orderBookApi = new Map();
    this.walletContexts = new Map();
    this.logger.debug('Initializing CowSwapBridgeAdapter with production setup');
  }

  async executeSwap(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<SwapExecutionResult> {
    try {
      if (route.origin !== route.destination) {
        throw new Error('CowSwap executeSwap is only supported for same-chain routes');
      }

      this.validateSameChainSwap(route);

      const { sellToken, buyToken } = this.determineSwapDirection(route);
      const orderBookApi = this.getOrderBookApi(route.origin);
      const { account, walletClient } = await this.getWalletContext(route.origin);

      if (account.address.toLowerCase() !== sender.toLowerCase()) {
        this.logger.warn(
          'CowSwap adapter sender does not match configured account, proceeding with configured account',
          {
            expectedSender: sender,
            accountAddress: account.address,
          },
        );
      }

      const quoteRequest: OrderQuoteRequest = {
        sellToken,
        buyToken,
        from: account.address,
        receiver: recipient,
        sellAmountBeforeFee: amount,
        kind: OrderQuoteSideKindSell.SELL,
      };

      const quoteResponse: OrderQuoteResponse = await orderBookApi.getQuote(quoteRequest);
      const quote = quoteResponse.quote;

      const totalSellAmount = (BigInt(quote.sellAmount) + BigInt(quote.feeAmount)).toString();

      // Ensure we have approval for the VaultRelayer to transfer the sell token
      // We approve the total amount (sell amount + fees) to ensure we have enough
      try {
        await this.ensureTokenApproval(
          route.origin,
          sellToken as Address,
          account.address as Address,
          BigInt(totalSellAmount),
        );
      } catch (error) {
        this.logger.error('Failed to ensure token approval for CowSwap', {
          chainId: route.origin,
          sellToken,
          owner: account.address,
          amount: totalSellAmount,
          error: jsonifyError(error),
        });
        throw error;
      }

      const domain = {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId: route.origin,
        verifyingContract: COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[route.origin as SupportedChainId] as Address,
      } as const;

      const unsignedOrder: OrderCreation = {
        sellToken: quote.sellToken as Address,
        buyToken: quote.buyToken as Address,
        sellAmount: totalSellAmount,
        buyAmount: quote.buyAmount,
        validTo: quote.validTo,
        appData: quote.appData as `0x${string}`,
        feeAmount: '0',
        kind: OrderKind.SELL,
        partiallyFillable: quote.partiallyFillable,
        sellTokenBalance: quote.sellTokenBalance,
        buyTokenBalance: quote.buyTokenBalance,
        from: account.address as Address,
        receiver: (recipient || account.address) as Address,
        signingScheme: SigningScheme.EIP712,
        signature: '0x',
      };

      const orderStructForSignature = {
        sellToken: unsignedOrder.sellToken as Address,
        buyToken: unsignedOrder.buyToken as Address,
        receiver: (unsignedOrder.receiver ?? account.address) as Address,
        sellAmount: BigInt(unsignedOrder.sellAmount),
        buyAmount: BigInt(unsignedOrder.buyAmount),
        validTo: unsignedOrder.validTo,
        appData: unsignedOrder.appData as `0x${string}`,
        feeAmount: BigInt(unsignedOrder.feeAmount),
        kind: unsignedOrder.kind,
        partiallyFillable: unsignedOrder.partiallyFillable,
        sellTokenBalance: unsignedOrder.sellTokenBalance ?? 'erc20',
        buyTokenBalance: unsignedOrder.buyTokenBalance ?? 'erc20',
      };

      const orderTypes = {
        Order: [
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'receiver', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'buyAmount', type: 'uint256' },
          { name: 'validTo', type: 'uint32' },
          { name: 'appData', type: 'bytes32' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'kind', type: 'string' },
          { name: 'partiallyFillable', type: 'bool' },
          { name: 'sellTokenBalance', type: 'string' },
          { name: 'buyTokenBalance', type: 'string' },
        ],
      } as const;

      const signature = await walletClient.signTypedData({
        account,
        domain,
        types: orderTypes,
        primaryType: 'Order',
        message: orderStructForSignature as {
          sellToken: Address;
          buyToken: Address;
          receiver: Address;
          sellAmount: bigint;
          buyAmount: bigint;
          validTo: number;
          appData: `0x${string}`;
          feeAmount: bigint;
          kind: string;
          partiallyFillable: boolean;
          sellTokenBalance: string;
          buyTokenBalance: string;
        },
      });

      const order = {
        ...unsignedOrder,
        signature,
      } as OrderCreation;

      // Double-check allowance right before submitting order to catch any issues
      const { publicClient } = await this.getWalletContext(route.origin);
      const vaultRelayerAddress = COWSWAP_VAULT_RELAYER_ADDRESSES[route.origin];
      const finalAllowanceCheck = await publicClient.readContract({
        address: sellToken as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address as Address, vaultRelayerAddress as Address],
      });

      this.logger.info('Final allowance check before order submission', {
        chainId: route.origin,
        sellToken,
        owner: account.address,
        vaultRelayer: vaultRelayerAddress,
        allowance: finalAllowanceCheck.toString(),
        requiredAmount: totalSellAmount,
        orderSellAmount: order.sellAmount,
      });

      if (finalAllowanceCheck < BigInt(totalSellAmount)) {
        throw new Error(
          `Insufficient allowance before order submission: have ${finalAllowanceCheck.toString()}, need ${totalSellAmount}`,
        );
      }

      this.logger.info('Submitting CowSwap same-chain order', {
        chainId: route.origin,
        sellToken,
        buyToken,
        sellAmount: order.sellAmount,
        buyAmount: order.buyAmount,
        allowance: finalAllowanceCheck.toString(),
        orderFrom: order.from,
        accountAddress: account.address,
        vaultRelayer: vaultRelayerAddress,
      });

      let orderUid: string;
      try {
        orderUid = await orderBookApi.sendOrder(order);
        this.logger.info('CowSwap order submitted successfully', { orderUid, chainId: route.origin });
      } catch (orderError: unknown) {
        // Log detailed error information
        const errorRecord = orderError as Record<string, unknown>;
        this.logger.error('Failed to submit CowSwap order', {
          chainId: route.origin,
          sellToken,
          buyToken,
          orderFrom: order.from,
          accountAddress: account.address,
          vaultRelayer: vaultRelayerAddress,
          allowance: finalAllowanceCheck.toString(),
          requiredAmount: totalSellAmount,
          error: jsonifyError(orderError),
          errorMessage: errorRecord?.message,
          errorBody: errorRecord?.body,
          errorResponse: (errorRecord?.response as { data?: unknown })?.data,
        });
        throw orderError;
      }
      const settledOrder = await this.waitForOrderFulfillment(orderBookApi, orderUid);

      this.logger.info('CowSwap order fulfilled', {
        chainId: route.origin,
        orderUid,
        executedSellAmount: settledOrder.executedSellAmount,
        executedBuyAmount: settledOrder.executedBuyAmount,
        status: settledOrder.status,
      });

      return {
        orderUid,
        sellToken,
        buyToken,
        sellAmount: totalSellAmount,
        buyAmount: settledOrder.buyAmount ?? order.buyAmount,
        executedSellAmount: settledOrder.executedSellAmount ?? totalSellAmount,
        executedBuyAmount: settledOrder.executedBuyAmount ?? settledOrder.buyAmount ?? order.buyAmount,
      };
    } catch (error) {
      this.handleError(error, 'execute CowSwap swap', {
        sender,
        recipient,
        amount,
        route,
      });
    }
  }

  private getOrderBookApi(chainId: number): OrderBookApi {
    if (!this.orderBookApi.has(chainId)) {
      // Check if chain is supported by CowSwap SDK
      if (!SUPPORTED_NETWORKS[chainId]) {
        throw new Error(
          `Chain ${chainId} is not supported by CowSwap SDK. Supported chains: ${Object.keys(SUPPORTED_NETWORKS).join(', ')}`,
        );
      }

      // Map chain ID to SupportedChainId enum value
      const supportedChainId = this.mapChainIdToSupportedChainId(chainId);
      if (!supportedChainId) {
        throw new Error(
          `Chain ${chainId} is not supported by CowSwap SDK. Supported chains: ${Object.keys(SUPPORTED_NETWORKS).join(', ')}`,
        );
      }

      this.logger.debug('Initializing CowSwap OrderBookApi', { chainId, supportedChainId });
      const api = new OrderBookApi({ chainId: supportedChainId });
      this.orderBookApi.set(chainId, api);
    }
    return this.orderBookApi.get(chainId)!;
  }

  private mapChainIdToSupportedChainId(chainId: number): SupportedChainId | null {
    // Map numeric chain IDs to SupportedChainId enum values
    switch (chainId) {
      case 1:
        return SupportedChainId.MAINNET;
      case 100:
        return SupportedChainId.GNOSIS_CHAIN;
      case 137:
        return SupportedChainId.POLYGON;
      case 42161:
        return SupportedChainId.ARBITRUM_ONE;
      case 8453:
        return SupportedChainId.BASE;
      case 11155111:
        return SupportedChainId.SEPOLIA;
      default:
        return null;
    }
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

    // Check if chain is supported by CowSwap SDK before attempting to get token pair
    if (!SUPPORTED_NETWORKS[route.origin]) {
      throw new Error(
        `Chain ${route.origin} is not supported by CowSwap SDK. Supported chains: ${Object.keys(SUPPORTED_NETWORKS).join(', ')}`,
      );
    }

    const pair = this.getTokenPair(route.origin);
    const validAssets = [pair.usdc.toLowerCase(), pair.usdt.toLowerCase()];

    // Validate that both asset and swapOutputAsset (if provided) are in the USDC/USDT pair
    if (!validAssets.includes(route.asset.toLowerCase())) {
      throw new Error(`CowSwap adapter only supports USDC/USDT swaps. Got asset: ${route.asset}`);
    }

    // If swapOutputAsset is provided, validate it's also in the pair and different from asset
    if (route.swapOutputAsset) {
      const destAssetLower = route.swapOutputAsset.toLowerCase();
      if (!validAssets.includes(destAssetLower)) {
        throw new Error(`CowSwap adapter only supports USDC/USDT swaps. Got swapOutputAsset: ${route.swapOutputAsset}`);
      }
      if (route.asset.toLowerCase() === destAssetLower) {
        throw new Error(`CowSwap adapter requires different assets for swap. Got same asset for both: ${route.asset}`);
      }
    }
  }

  private determineSwapDirection(route: RebalanceRoute): { sellToken: string; buyToken: string } {
    const pair = this.getTokenPair(route.origin);
    const asset = route.asset.toLowerCase();

    // If swapOutputAsset is explicitly provided, use it to determine direction
    if (route.swapOutputAsset) {
      const destAsset = route.swapOutputAsset.toLowerCase();
      // Validate that we have a valid USDC/USDT swap pair
      if (asset === pair.usdc.toLowerCase() && destAsset === pair.usdt.toLowerCase()) {
        return { sellToken: pair.usdc, buyToken: pair.usdt };
      } else if (asset === pair.usdt.toLowerCase() && destAsset === pair.usdc.toLowerCase()) {
        return { sellToken: pair.usdt, buyToken: pair.usdc };
      } else {
        throw new Error(`Invalid USDC/USDT swap pair: asset=${route.asset}, swapOutputAsset=${route.swapOutputAsset}`);
      }
    }

    // Fallback: determine direction based on asset only (backward compatibility)
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

      this.logger.debug('Requesting CowSwap quote', {
        chainId: route.origin,
        sellToken,
        buyToken,
        sellAmount: amount,
      });

      const quoteRequest: OrderQuoteRequest = {
        sellToken: sellToken,
        buyToken: buyToken,
        from: zeroAddress,
        receiver: zeroAddress,
        sellAmountBeforeFee: amount,
        kind: OrderQuoteSideKindSell.SELL,
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

  private normalizePrivateKey(key: string): `0x${string}` {
    const normalized = key.startsWith('0x') ? key : `0x${key}`;
    return normalized as `0x${string}`;
  }

  private async resolvePrivateKey(chainId: number): Promise<`0x${string}`> {
    const chainConfig = this.chains[chainId.toString()];
    if (chainConfig?.privateKey) {
      return this.normalizePrivateKey(chainConfig.privateKey);
    }

    const envKey = process.env.PRIVATE_KEY ?? process.env.WEB3_SIGNER_PRIVATE_KEY;
    if (envKey) {
      return this.normalizePrivateKey(envKey);
    }

    const ssmKey = await fromEnv('WEB3_SIGNER_PRIVATE_KEY', true);
    if (ssmKey) {
      return this.normalizePrivateKey(ssmKey);
    }

    throw new Error(`CowSwap adapter requires a private key for chain ${chainId}`);
  }

  private async getWalletContext(chainId: number): Promise<WalletContext> {
    if (!this.walletContexts.has(chainId)) {
      this.walletContexts.set(chainId, this.createWalletContext(chainId));
    }

    return this.walletContexts.get(chainId)!;
  }

  /**
   * Ensures the VaultRelayer has sufficient allowance to transfer the token
   * Handles approval transaction if needed, including special case for USDT
   */
  private async ensureTokenApproval(
    chainId: number,
    tokenAddress: Address,
    ownerAddress: Address,
    requiredAmount: bigint,
  ): Promise<void> {
    let vaultRelayerAddress = COWSWAP_VAULT_RELAYER_ADDRESSES[chainId];
    if (!vaultRelayerAddress) {
      throw new Error(`VaultRelayer address not found for chain ${chainId}`);
    }

    // Log the VaultRelayer address being used for debugging
    this.logger.debug('Using VaultRelayer address for approval', {
      chainId,
      vaultRelayerAddress,
      tokenAddress,
      ownerAddress,
    });

    const { publicClient, walletClient } = await this.getWalletContext(chainId);

    // Check current allowance
    const currentAllowance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [ownerAddress, vaultRelayerAddress as Address],
    });

    this.logger.debug('Checking token allowance for CowSwap', {
      chainId,
      tokenAddress,
      ownerAddress,
      vaultRelayerAddress,
      currentAllowance: currentAllowance.toString(),
      requiredAmount: requiredAmount.toString(),
    });

    // If allowance is sufficient, no approval needed
    if (currentAllowance >= requiredAmount) {
      this.logger.debug('Sufficient allowance already available for CowSwap', {
        chainId,
        tokenAddress,
        allowance: currentAllowance.toString(),
        requiredAmount: requiredAmount.toString(),
      });
      return;
    }

    // Check if this is USDT (requires zero approval first if current allowance > 0)
    const pair = this.getTokenPair(chainId);
    const isUSDT = tokenAddress.toLowerCase() === pair.usdt.toLowerCase();

    if (isUSDT && currentAllowance > 0n) {
      this.logger.info('USDT has non-zero allowance, setting to zero first', {
        chainId,
        tokenAddress,
        currentAllowance: currentAllowance.toString(),
      });

      // Set allowance to zero first (USDT requirement)
      const zeroApprovalHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vaultRelayerAddress as Address, 0n],
        account: null,
        chain: null,
      });

      this.logger.info('Zero approval transaction sent for USDT', {
        chainId,
        tokenAddress,
        txHash: zeroApprovalHash,
      });

      // Wait for zero approval to be confirmed
      await publicClient.waitForTransactionReceipt({
        hash: zeroApprovalHash,
      });

      this.logger.info('Zero approval confirmed for USDT', {
        chainId,
        tokenAddress,
        txHash: zeroApprovalHash,
      });
    }

    // Now approve the required amount
    this.logger.info('Approving token for CowSwap VaultRelayer', {
      chainId,
      tokenAddress,
      vaultRelayerAddress,
      amount: requiredAmount.toString(),
      isUSDT,
    });

    const approvalHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [vaultRelayerAddress as Address, requiredAmount],
      account: null,
      chain: null,
    });

    this.logger.info('Approval transaction sent for CowSwap', {
      chainId,
      tokenAddress,
      txHash: approvalHash,
      amount: requiredAmount.toString(),
    });

    // Wait for approval to be confirmed with multiple confirmations to ensure it's fully propagated
    const approvalReceipt = await publicClient.waitForTransactionReceipt({
      hash: approvalHash,
      confirmations: 2, // Wait for 2 confirmations to ensure it's fully propagated
    });

    if (approvalReceipt.status !== 'success') {
      throw new Error(`Approval transaction failed: ${approvalHash}`);
    }

    // Wait a bit more to ensure the state is fully propagated across all nodes
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify the approval was actually set
    const newAllowance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [ownerAddress, vaultRelayerAddress as Address],
    });

    if (newAllowance < requiredAmount) {
      throw new Error(
        `Approval verification failed: expected at least ${requiredAmount.toString()}, got ${newAllowance.toString()}`,
      );
    }

    this.logger.info('Approval confirmed and verified for CowSwap', {
      chainId,
      tokenAddress,
      txHash: approvalHash,
      amount: requiredAmount.toString(),
      verifiedAllowance: newAllowance.toString(),
      blockNumber: approvalReceipt.blockNumber.toString(),
      confirmations: 2,
    });
  }

  private async createWalletContext(chainId: number): Promise<WalletContext> {
    const chainConfig = this.chains[chainId.toString()];
    if (!chainConfig || !chainConfig.providers?.length) {
      throw new Error(`No providers configured for chain ${chainId}`);
    }

    const rpcUrl = chainConfig.providers[0];
    const privateKey = await this.resolvePrivateKey(chainId);
    const account = privateKeyToAccount(privateKey);

    const chain = defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      network: `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    });

    const transport = http(rpcUrl);

    const walletClient = createWalletClient({
      account,
      chain,
      transport,
    });

    const publicClient = createPublicClient({
      chain,
      transport,
    });

    this.logger.debug('Initialized CowSwap wallet context', {
      chainId,
      rpcUrl,
      address: account.address,
    });

    return {
      account,
      walletClient,
      publicClient,
      rpcUrl,
      chain,
    };
  }

  private async waitForOrderFulfillment(orderBookApi: OrderBookApi, orderUid: string): Promise<CowSwapOrderStatus> {
    const timeoutMs = 5 * 60 * 1000; // 5 minutes
    const pollIntervalMs = 10_000; // 10 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const order = (await orderBookApi.getOrder(orderUid)) as unknown as CowSwapOrderStatus | undefined;

      if (!order) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      if (order.status === 'fulfilled' || order.status === 'expired' || order.status === 'cancelled') {
        return order;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timed out waiting for CowSwap order ${orderUid} to settle`);
  }

  async send(): Promise<MemoizedTransactionRequest[]> {
    this.logger.warn('CowSwap send() invoked; synchronous swaps do not require pre-signed transactions');
    return [];
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
    this.logger.debug('CowSwap destinationCallback invoked - no action required for synchronous swaps', {
      transactionHash: originTransaction.transactionHash,
      route,
    });
    return;
  }

  private handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    const enrichedMetadata: Record<string, unknown> = { ...metadata };

    if (error && typeof error === 'object') {
      const errorRecord = error as Record<string, unknown>;
      if ('response' in errorRecord && errorRecord.response) {
        const response = errorRecord.response as { status?: number; statusText?: string };
        if (response?.status !== undefined) {
          enrichedMetadata.cowSwapStatus = response.status;
        }
        if (response?.statusText) {
          enrichedMetadata.cowSwapStatusText = response.statusText;
        }
      }

      if ('body' in errorRecord) {
        const body = errorRecord.body;
        if (body !== undefined) {
          try {
            enrichedMetadata.cowSwapBody = typeof body === 'string' ? body : JSON.stringify(body);
          } catch {
            enrichedMetadata.cowSwapBody = String(body);
          }
        }
      }
    }

    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...enrichedMetadata,
    });
    throw new Error(`Failed to ${context}: ${(error as unknown as Error)?.message ?? 'Unknown error'}`);
  }
}
