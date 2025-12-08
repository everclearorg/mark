import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  erc20Abi,
  fallback,
  type PublicClient,
  pad,
  decodeEventLog,
} from 'viem';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, axiosGet } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { STARGATE_OFT_ABI } from './abi';
import {
  STARGATE_USDT_POOL_ETH,
  USDT_ETH,
  LZ_ENDPOINT_ID_TON,
  StargateSendParam,
  StargateMessagingFee,
  LzMessageStatus,
  LzScanMessageResponse,
  STARGATE_API_URL,
  StargateApiQuoteResponse,
  STARGATE_CHAIN_NAMES,
  tonAddressToBytes32,
  USDT_TON_STARGATE,
} from './types';

// LayerZero Scan API base URL
const LZ_SCAN_API_URL = 'https://scan.layerzero-api.com';

/**
 * Stargate Bridge Adapter for bridging assets via LayerZero OFT
 *
 * This adapter handles Leg 1 of TAC USDT rebalancing:
 * Ethereum Mainnet → TON via Stargate OFT
 *
 * Reference:
 * - Stargate Docs: https://stargateprotocol.gitbook.io/stargate/v2/
 * - Stargate API: https://docs.stargate.finance/developers/api-docs/overview
 * - LayerZero Docs: https://docs.layerzero.network/
 */
export class StargateBridgeAdapter implements BridgeAdapter {
  protected readonly publicClients = new Map<number, PublicClient>();

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing StargateBridgeAdapter', { apiUrl: STARGATE_API_URL });
  }

  type(): SupportedBridge {
    return SupportedBridge.Stargate;
  }

  /**
   * Get the expected amount received after bridging via Stargate
   *
   * First tries the Stargate API, falls back to on-chain quote
   */
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      // Try API quote first
      const apiQuote = await this.getApiQuote(amount, route);
      if (apiQuote) {
        this.logger.debug('Got Stargate API quote', {
          amount,
          route,
          receivedAmount: apiQuote,
        });
        return apiQuote;
      }
    } catch (error) {
      this.logger.warn('Stargate API quote failed, falling back to on-chain', {
        error: jsonifyError(error),
        amount,
        route,
      });
    }

    // Fall back to on-chain quote
    return this.getOnChainQuote(amount, route);
  }

  /**
   * Get quote from Stargate API
   * Uses the Stargate frontend API at stargate.finance/api/v1/quotes
   */
  protected async getApiQuote(amount: string, route: RebalanceRoute): Promise<string | null> {
    try {
      const srcChain = STARGATE_CHAIN_NAMES[route.origin];
      const dstChain = STARGATE_CHAIN_NAMES[route.destination];

      if (!srcChain || !dstChain) {
        this.logger.warn('Chain not supported in Stargate API', { route });
        return null;
      }

      // For TON destination, use the Stargate-specific token address format
      const dstToken = route.destination === 30826 ? USDT_TON_STARGATE : route.asset;

      // Use a placeholder address for quote - actual address will be used in send()
      const placeholderAddress = '0x1234567890abcdef1234567890abcdef12345678';
      const placeholderTonAddress = 'EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t';

      const params = new URLSearchParams({
        srcToken: route.asset,
        srcChainKey: srcChain,
        dstToken: dstToken,
        dstChainKey: dstChain,
        srcAddress: placeholderAddress,
        dstAddress: dstChain === 'ton' ? placeholderTonAddress : placeholderAddress,
        srcAmount: amount,
        dstAmountMin: '0', // No minimum for quote
      });

      const url = `${STARGATE_API_URL}/quotes?${params.toString()}`;

      this.logger.debug('Fetching Stargate API quote', { url });

      const response = await axiosGet<StargateApiQuoteResponse>(url);

      // Check for API-level error
      if (response.data.error) {
        this.logger.debug('Stargate API returned error', { error: response.data.error });
        return null;
      }

      // Check if we got a valid quote
      const quotes = response.data.quotes;
      if (!quotes || quotes.length === 0) {
        this.logger.debug('Stargate API returned no quotes');
        return null;
      }

      const quote = quotes[0];
      if (!quote.route || quote.error) {
        this.logger.debug('Stargate API quote has no route', { error: quote.error });
        return null;
      }

      return quote.dstAmount;
    } catch (error) {
      this.logger.debug('Stargate API quote error', { error: jsonifyError(error) });
      return null;
    }
  }

  /**
   * Get quote from on-chain contract
   *
   * Uses quoteOFT to get the expected received amount after fees.
   * Falls back to assuming 1:1 if quoteOFT is not available.
   */
  protected async getOnChainQuote(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      const client = this.getPublicClient(route.origin);
      const poolAddress = this.getPoolAddress(route.asset, route.origin);

      // Prepare send parameters for quote
      const sendParam: StargateSendParam = {
        dstEid: LZ_ENDPOINT_ID_TON,
        to: pad('0x0000000000000000000000000000000000000000' as `0x${string}`, { size: 32 }),
        amountLD: BigInt(amount),
        minAmountLD: BigInt(0), // Will be calculated after quote
        extraOptions: '0x' as `0x${string}`,
        composeMsg: '0x' as `0x${string}`,
        oftCmd: '0x' as `0x${string}`,
      };

      // Try to get actual received amount via quoteOFT (if available on the contract)
      try {
        const oftQuote = (await client.readContract({
          address: poolAddress,
          abi: STARGATE_OFT_ABI,
          functionName: 'quoteOFT',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: [sendParam] as any,
        })) as { amountSentLD: bigint; amountReceivedLD: bigint };

        this.logger.debug('Stargate OFT quote obtained', {
          amount,
          route,
          amountSent: oftQuote.amountSentLD.toString(),
          amountReceived: oftQuote.amountReceivedLD.toString(),
        });

        return oftQuote.amountReceivedLD.toString();
      } catch {
        // quoteOFT not available, fall through to quoteSend
        this.logger.debug('quoteOFT not available, using quoteSend', { route });
      }

      // Call quoteSend on the Stargate pool (for messaging fee calculation)
      const result = (await client.readContract({
        address: poolAddress,
        abi: STARGATE_OFT_ABI,
        functionName: 'quoteSend',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: [sendParam, false] as any,
      })) as { nativeFee: bigint; lzTokenFee: bigint };

      this.logger.debug('Stargate on-chain quote obtained', {
        amount,
        route,
        messagingFee: {
          nativeFee: result.nativeFee.toString(),
          lzTokenFee: result.lzTokenFee.toString(),
        },
      });

      // For Stargate V2 OFT pools, transfers are typically 1:1 minus any small protocol fee.
      // Apply a conservative 0.1% fee estimate if quoteOFT is not available
      const estimatedFeeRate = 10n; // 0.1% in basis points
      const estimatedReceived = BigInt(amount) - (BigInt(amount) * estimatedFeeRate) / 10000n;

      return estimatedReceived.toString();
    } catch (error) {
      this.handleError(error, 'get Stargate on-chain quote', { amount, route });
    }
  }

  /**
   * Returns the minimum rebalance amount for Stargate.
   * Stargate doesn't have a strict minimum, but we use a reasonable default.
   */
  async getMinimumAmount(route: RebalanceRoute): Promise<string | null> {
    // Stargate has no strict minimum but very small amounts are not economical
    // Return null to use the caller's default minimum
    // Stargate minimums are not contract enforced but depend on pool/chain realities.
    // For most cases, returning null is fine to defer to the caller's config,
    // but edge cases exist: if the route token or chain has unusual dust-limits or
    // constraints, it is safer to enforce a low minimum, e.g. 1 unit, to avoid
    // zero-amount or dust transactions that waste fees.

    // If you want to be maximally defensive, you could:
    // return '1';
    // But by convention, return null to let the caller decide.
    return null;
  }

  /**
   * Build transactions needed to bridge via Stargate
   * Uses the Stargate API to get optimal routing and transaction data
   * Falls back to manual contract calls if API fails
   *
   * @param sender - Address sending the tokens
   * @param recipient - Address receiving on TON (can be TON address format)
   * @param amount - Amount to bridge
   * @param route - Bridge route configuration
   */
  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    // Try API first for best routing and transaction data
    try {
      const apiTransactions = await this.getApiTransactions(sender, recipient, amount, route);
      if (apiTransactions && apiTransactions.length > 0) {
        this.logger.info('Using Stargate API for bridge transactions', {
          sender,
          recipient,
          amount,
          route,
          transactionCount: apiTransactions.length,
        });
        return apiTransactions;
      }
    } catch (error) {
      this.logger.warn('Stargate API transaction build failed, falling back to manual', {
        error: jsonifyError(error),
        sender,
        recipient,
        amount,
        route,
      });
    }

    // Fall back to manual contract calls
    return this.getManualTransactions(sender, recipient, amount, route);
  }

  /**
   * Get transactions from Stargate API
   * This uses the same endpoint as the Stargate frontend
   */
  protected async getApiTransactions(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[] | null> {
    const srcChain = STARGATE_CHAIN_NAMES[route.origin];
    const dstChain = STARGATE_CHAIN_NAMES[route.destination];

    if (!srcChain || !dstChain) {
      this.logger.warn('Chain not supported in Stargate API', { route });
      return null;
    }

    // For TON destination, use the Stargate-specific token address format
    const dstToken = route.destination === 30826 ? USDT_TON_STARGATE : route.asset;

    // Calculate minimum amount with slippage (0.5%)
    const slippageBps = 50n;
    const minAmount = (BigInt(amount) * (10000n - slippageBps)) / 10000n;

    const params = new URLSearchParams({
      srcToken: route.asset,
      srcChainKey: srcChain,
      dstToken: dstToken,
      dstChainKey: dstChain,
      srcAddress: sender,
      dstAddress: recipient,
      srcAmount: amount,
      dstAmountMin: minAmount.toString(),
    });

    const url = `${STARGATE_API_URL}/quotes?${params.toString()}`;

    this.logger.debug('Fetching Stargate API quote', { url, params: Object.fromEntries(params) });

    const response = await axiosGet<StargateApiQuoteResponse>(url);

    // Check for API-level error
    if (response.data.error) {
      this.logger.warn('Stargate API returned error', { error: response.data.error });
      return null;
    }

    // Check if we got a valid quote
    const quotes = response.data.quotes;
    if (!quotes || quotes.length === 0) {
      this.logger.warn('Stargate API returned no quotes');
      return null;
    }

    const quote = quotes[0];
    if (!quote.route || quote.error) {
      this.logger.warn('Stargate API quote has no route', {
        error: quote.error,
        quote,
      });
      return null;
    }

    // Convert API steps to our transaction format
    const transactions: MemoizedTransactionRequest[] = [];

    for (const step of quote.steps) {
      if (step.type === 'approve') {
        transactions.push({
          memo: RebalanceTransactionMemo.Approval,
          transaction: {
            to: step.transaction.to as `0x${string}`,
            data: step.transaction.data as `0x${string}`,
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
        });
      } else if (step.type === 'bridge') {
        transactions.push({
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: step.transaction.to as `0x${string}`,
            data: step.transaction.data as `0x${string}`,
            value: BigInt(step.transaction.value || '0'),
            funcSig: 'stargate-bridge',
          },
        });
      }
    }

    this.logger.info('Built Stargate transactions from API', {
      sender,
      recipient,
      amount,
      route: quote.route,
      dstAmount: quote.dstAmount,
      duration: quote.duration?.estimated,
      fees: quote.fees,
      transactionCount: transactions.length,
    });

    return transactions;
  }

  /**
   * Build transactions manually using direct contract calls
   * Used as fallback when API is unavailable
   */
  protected async getManualTransactions(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      const client = this.getPublicClient(route.origin);
      const poolAddress = this.getPoolAddress(route.asset, route.origin);

      // Convert recipient to bytes32
      // For TON, this needs to be the TON address encoded properly
      let recipientBytes32: `0x${string}`;
      if (recipient.startsWith('0x')) {
        recipientBytes32 = pad(recipient as `0x${string}`, { size: 32 });
      } else {
        // Assume it's a TON address
        recipientBytes32 = tonAddressToBytes32(recipient);
      }

      // Calculate minimum amount with slippage (0.5%)
      const slippageBps = 50n; // 0.5%
      const minAmount = (BigInt(amount) * (10000n - slippageBps)) / 10000n;

      // Prepare send parameters
      const sendParam: StargateSendParam = {
        dstEid: LZ_ENDPOINT_ID_TON,
        to: recipientBytes32,
        amountLD: BigInt(amount),
        minAmountLD: minAmount,
        extraOptions: '0x' as `0x${string}`,
        composeMsg: '0x' as `0x${string}`,
        oftCmd: '0x' as `0x${string}`,
      };

      // Get quote for messaging fee
      const fee = (await client.readContract({
        address: poolAddress,
        abi: STARGATE_OFT_ABI,
        functionName: 'quoteSend',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: [sendParam, false] as any,
      })) as { nativeFee: bigint; lzTokenFee: bigint };

      // Build transactions
      const transactions: MemoizedTransactionRequest[] = [];

      // 1. Check and add approval transaction if needed
      const tokenAddress = route.asset as `0x${string}`;
      const allowance = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [sender as `0x${string}`, poolAddress],
      });

      if (allowance < BigInt(amount)) {
        transactions.push({
          memo: RebalanceTransactionMemo.Approval,
          transaction: {
            to: tokenAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [poolAddress, BigInt(amount)],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
        });
      }

      // 2. Build send transaction
      const messagingFee: StargateMessagingFee = {
        nativeFee: fee.nativeFee,
        lzTokenFee: BigInt(0),
      };

      transactions.push({
        memo: RebalanceTransactionMemo.Rebalance,
        transaction: {
          to: poolAddress,
          data: encodeFunctionData({
            abi: STARGATE_OFT_ABI,
            functionName: 'send',
            args: [sendParam, messagingFee, sender as `0x${string}`],
          }),
          value: fee.nativeFee, // Pay LayerZero messaging fee in ETH
          funcSig: 'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
        },
      });

      this.logger.info('Prepared Stargate bridge transactions (manual fallback)', {
        sender,
        recipient,
        amount,
        route,
        poolAddress,
        messagingFee: {
          nativeFee: fee.nativeFee.toString(),
          lzTokenFee: fee.lzTokenFee.toString(),
        },
        transactionCount: transactions.length,
      });

      return transactions;
    } catch (error) {
      this.handleError(error, 'prepare Stargate bridge transaction (manual)', { amount, route });
    }
  }

  /**
   * Stargate OFT bridges don't require destination callbacks
   * The tokens are minted automatically on destination
   */
  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    this.logger.debug('Stargate destinationCallback invoked - no action required', {
      transactionHash: originTransaction.transactionHash,
      route,
    });
    return;
  }

  /**
   * Check if the LayerZero message has been delivered to TON
   */
  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    this.logger.debug('Checking if Stargate transfer is ready on destination', {
      amount,
      route,
      transactionHash: originTransaction.transactionHash,
    });

    try {
      // Extract GUID from OFTSent event
      const guid = this.extractGuidFromReceipt(originTransaction);
      if (!guid) {
        this.logger.warn('Could not extract GUID from transaction receipt', {
          transactionHash: originTransaction.transactionHash,
        });
        return false;
      }

      // Check LayerZero message status via API
      const status = await this.getLayerZeroMessageStatus(originTransaction.transactionHash, route.origin);

      if (!status) {
        this.logger.debug('LayerZero message status not found', {
          transactionHash: originTransaction.transactionHash,
          guid,
        });
        return false;
      }

      const isReady = status.status === LzMessageStatus.DELIVERED;
      this.logger.debug('LayerZero message status', {
        status: status.status,
        isReady,
        guid,
        dstTxHash: status.dstTxHash,
      });

      return isReady;
    } catch (error) {
      this.logger.error('Failed to check Stargate transfer status', {
        error: jsonifyError(error),
        amount,
        route,
        transactionHash: originTransaction.transactionHash,
      });
      return false;
    }
  }

  /**
   * Get the TON destination info after a successful Stargate bridge
   * Returns the TON transaction hash if available
   */
  async getDestinationTxHash(originTxHash: string, originChainId: number): Promise<string | undefined> {
    try {
      const status = await this.getLayerZeroMessageStatus(originTxHash, originChainId);
      return status?.dstTxHash;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract the GUID from OFTSent event in the transaction receipt
   */
  protected extractGuidFromReceipt(receipt: TransactionReceipt): `0x${string}` | undefined {
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: STARGATE_OFT_ABI,
          eventName: 'OFTSent',
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName === 'OFTSent') {
          return decoded.args.guid;
        }
      } catch {
        // Not the event we're looking for
        continue;
      }
    }
    return undefined;
  }

  /**
   * Query LayerZero Scan API for message status
   * API docs: https://scan.layerzero-api.com
   */
  protected async getLayerZeroMessageStatus(
    txHash: string,
    srcChainId: number,
  ): Promise<LzScanMessageResponse | undefined> {
    try {
      const url = `${LZ_SCAN_API_URL}/v1/messages/tx/${txHash}`;

      // New API response format uses 'data' array with nested structure
      interface LzScanApiResponse {
        data: Array<{
          pathway: { srcEid: number; dstEid: number };
          source: { tx: { txHash: string; blockNumber: string } };
          destination: { tx?: { txHash: string; blockNumber?: number } };
          status: { name: string; message?: string };
        }>;
      }

      const { data: response } = await axiosGet<LzScanApiResponse>(url);

      if (!response.data || response.data.length === 0) {
        return undefined;
      }

      // Get the first message (usually only one per tx)
      const msg = response.data[0];

      // Map the new API response format to our internal type
      const result: LzScanMessageResponse = {
        status: msg.status.name as LzMessageStatus,
        srcTxHash: msg.source.tx.txHash,
        dstTxHash: msg.destination.tx?.txHash,
        srcChainId: msg.pathway.srcEid,
        dstChainId: msg.pathway.dstEid,
        srcBlockNumber: parseInt(msg.source.tx.blockNumber, 10),
        dstBlockNumber: msg.destination.tx?.blockNumber,
      };

      this.logger.debug('LayerZero message status retrieved', {
        txHash,
        status: result.status,
        dstTxHash: result.dstTxHash,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to query LayerZero Scan API', {
        error: jsonifyError(error),
        txHash,
        srcChainId,
      });
      return undefined;
    }
  }

  /**
   * Get the Stargate pool address for an asset
   */
  protected getPoolAddress(asset: string, chainId: number): `0x${string}` {
    // For USDT on Ethereum mainnet
    if (asset.toLowerCase() === USDT_ETH.toLowerCase() && chainId === 1) {
      return STARGATE_USDT_POOL_ETH;
    }

    // Add more pool addresses as needed
    throw new Error(`No Stargate pool found for asset ${asset} on chain ${chainId}`);
  }

  /**
   * Get or create a public client for a chain
   */
  protected getPublicClient(chainId: number): PublicClient {
    if (this.publicClients.has(chainId)) {
      return this.publicClients.get(chainId)!;
    }

    const providers = this.chains[chainId.toString()]?.providers ?? [];
    if (!providers.length) {
      throw new Error(`No providers found for chain ${chainId}`);
    }

    const client = createPublicClient({
      transport: fallback(providers.map((provider: string) => http(provider))),
    });

    this.publicClients.set(chainId, client);
    return client;
  }

  /**
   * Logs and rethrows errors with consistent context
   */
  protected handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(`Failed to ${context}: ${(error as any)?.message ?? ''}`);
  }
}
