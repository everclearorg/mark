import { createPublicClient, encodeFunctionData, erc20Abi, http, fallback } from 'viem';
import {
  ChainConfiguration,
  PostBridgeActionConfig,
  PostBridgeActionType,
  DexSwapActionConfig,
  axiosPost,
} from '@mark/core';
import { Logger } from '@mark/logger';
import { MemoizedTransactionRequest, RebalanceTransactionMemo } from '../types';
import { PostBridgeActionHandler } from './types';

interface QuoteTx {
  action: 'Approve' | 'Swap';
  to: string;
  data: string;
  value: string;
}

interface QuoteItem {
  provider: string;
  order: { priceRank: number };
  estOutput: { raw: string; units: string };
  txs: QuoteTx[];
}

interface QuoteServiceResponse {
  success: boolean;
  data?: {
    quotes: QuoteItem[];
  };
  error?: string;
}

export class DexSwapActionHandler implements PostBridgeActionHandler {
  constructor(
    private readonly chains: Record<string, ChainConfiguration>,
    private readonly logger: Logger,
    private readonly quoteServiceUrl: string,
  ) {}

  async buildTransactions(
    sender: string,
    amount: string,
    destinationChainId: number,
    actionConfig: PostBridgeActionConfig,
  ): Promise<MemoizedTransactionRequest[]> {
    if (actionConfig.type !== PostBridgeActionType.DexSwap) {
      throw new Error(`DexSwapActionHandler received unexpected action type: ${actionConfig.type}`);
    }

    const config = actionConfig as DexSwapActionConfig;
    const { sellToken, buyToken, slippageBps } = config;

    const txs: MemoizedTransactionRequest[] = [];

    // Create a public client for the destination chain
    const providers = this.chains[destinationChainId.toString()]?.providers ?? [];
    if (!providers.length) {
      throw new Error(`No providers found for destination chain ${destinationChainId}`);
    }

    const client = createPublicClient({
      transport: fallback(providers.map((provider: string) => http(provider))),
    });

    // Read the actual token balance of sellToken
    const balance = await client.readContract({
      address: sellToken as `0x${string}`,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [sender as `0x${string}`],
    });

    const requestedAmount = BigInt(amount);
    const swapAmount = balance < requestedAmount ? balance : requestedAmount;

    this.logger.info('DexSwap: resolved swap amount', {
      sellToken,
      buyToken,
      sender,
      balance: balance.toString(),
      requestedAmount: amount,
      swapAmount: swapAmount.toString(),
      destinationChainId,
    });

    if (swapAmount === BigInt(0)) {
      this.logger.warn('DexSwap: zero balance, skipping transactions', {
        sellToken,
        sender,
        destinationChainId,
      });
      return txs;
    }

    // Call quote-service for swap quote
    const quoteUrl = `${this.quoteServiceUrl}/quote`;
    this.logger.info('DexSwap: requesting quote', {
      quoteUrl,
      sellToken,
      buyToken,
      amount: swapAmount.toString(),
      sender,
      destinationChainId,
      slippageBps,
    });

    const response = await axiosPost<QuoteServiceResponse>(quoteUrl, {
      sellToken,
      buyToken,
      amount: swapAmount.toString(),
      sender,
      receiver: sender,
      destinationChain: destinationChainId,
      slippageBps,
      options: ['excludeApproves'],
    });

    const quoteResult = response.data;
    if (!quoteResult?.success || !quoteResult.data?.quotes?.length) {
      throw new Error(
        `DexSwap: quote-service returned no quotes for ${sellToken} -> ${buyToken} on chain ${destinationChainId}: ${quoteResult?.error || 'no quotes available'}`,
      );
    }

    // Pick best quote (sorted by priceRank, first is best)
    const bestQuote = quoteResult.data.quotes[0];
    const swapTx = bestQuote.txs.find((t) => t.action === 'Swap');
    if (!swapTx) {
      throw new Error(`DexSwap: best quote from ${bestQuote.provider} has no Swap transaction`);
    }

    this.logger.info('DexSwap: selected best quote', {
      provider: bestQuote.provider,
      estOutput: bestQuote.estOutput.raw,
      swapTo: swapTx.to,
      destinationChainId,
    });

    // The spender for approval is the swap contract (swapTx.to)
    const spender = swapTx.to;

    // Check allowance of sellToken for the spender
    const allowance = await client.readContract({
      address: sellToken as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [sender as `0x${string}`, spender as `0x${string}`],
    });

    if (allowance < swapAmount) {
      this.logger.info('DexSwap: building approval transaction', {
        sellToken,
        spender,
        currentAllowance: allowance.toString(),
        requiredAmount: swapAmount.toString(),
        destinationChainId,
      });

      txs.push({
        memo: RebalanceTransactionMemo.Approval,
        transaction: {
          to: sellToken as `0x${string}`,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender as `0x${string}`, swapAmount],
          }),
          value: BigInt(0),
        },
      });
    } else {
      this.logger.info('DexSwap: sufficient allowance, skipping approval', {
        sellToken,
        spender,
        currentAllowance: allowance.toString(),
        requiredAmount: swapAmount.toString(),
        destinationChainId,
      });
    }

    // Build swap transaction
    txs.push({
      memo: RebalanceTransactionMemo.DexSwap,
      transaction: {
        to: swapTx.to as `0x${string}`,
        data: swapTx.data as `0x${string}`,
        value: BigInt(swapTx.value || '0'),
      },
      effectiveAmount: bestQuote.estOutput.raw,
    });

    this.logger.info('DexSwap: built transactions', {
      transactionCount: txs.length,
      sellToken,
      buyToken,
      swapAmount: swapAmount.toString(),
      estOutput: bestQuote.estOutput.raw,
      provider: bestQuote.provider,
      destinationChainId,
    });

    return txs;
  }
}
