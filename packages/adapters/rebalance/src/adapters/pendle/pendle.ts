import { TransactionReceipt, createPublicClient, http, fallback, encodeFunctionData, erc20Abi } from 'viem';
import { SupportedBridge, RebalanceRoute, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { PENDLE_API_BASE_URL, PENDLE_SUPPORTED_CHAINS, USDC_PTUSDE_PAIRS } from './types';

export class PendleBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing PendleBridgeAdapter');
  }

  type(): SupportedBridge {
    return SupportedBridge.Pendle;
  }

  async getMinimumAmount(_route: RebalanceRoute): Promise<string | null> {
    return null;
  }

  private validateSameChainSwap(route: RebalanceRoute): void {
    if (route.origin !== route.destination) {
      throw new Error('Pendle adapter only supports same-chain swaps');
    }

    const chainId = route.origin as keyof typeof PENDLE_SUPPORTED_CHAINS;
    if (!PENDLE_SUPPORTED_CHAINS[chainId]) {
      throw new Error(
        `Chain ${route.origin} is not supported by Pendle SDK. Supported chains: ${Object.keys(PENDLE_SUPPORTED_CHAINS).join(', ')}`,
      );
    }

    const pair = this.getTokenPair(route.origin);
    if (!pair) {
      throw new Error(`USDC/ptUSDe pair not configured for chain ${route.origin}`);
    }

    const validAssets = [pair.usdc.toLowerCase(), pair.ptUSDe.toLowerCase()];
    if (!validAssets.includes(route.asset.toLowerCase())) {
      throw new Error(`Pendle adapter only supports USDC/ptUSDe swaps. Got asset: ${route.asset}`);
    }

    if (route.swapOutputAsset && !validAssets.includes(route.swapOutputAsset.toLowerCase())) {
      throw new Error(`Pendle adapter only supports USDC/ptUSDe swaps. Got swapOutputAsset: ${route.swapOutputAsset}`);
    }
  }

  private getTokenPair(chainId: number): { usdc: string; ptUSDe: string } | null {
    return USDC_PTUSDE_PAIRS[chainId] || null;
  }

  private determineSwapDirection(route: RebalanceRoute): { tokensIn: string; tokensOut: string } {
    const pair = this.getTokenPair(route.origin);
    if (!pair) {
      throw new Error(`Token pair not found for chain ${route.origin}`);
    }

    const asset = route.asset.toLowerCase();

    if (route.swapOutputAsset) {
      const destAsset = route.swapOutputAsset.toLowerCase();
      if (asset === pair.usdc.toLowerCase() && destAsset === pair.ptUSDe.toLowerCase()) {
        return { tokensIn: pair.usdc, tokensOut: pair.ptUSDe };
      } else if (asset === pair.ptUSDe.toLowerCase() && destAsset === pair.usdc.toLowerCase()) {
        return { tokensIn: pair.ptUSDe, tokensOut: pair.usdc };
      } else {
        throw new Error(
          `Invalid USDC/ptUSDe swap pair: asset=${route.asset}, swapOutputAsset=${route.swapOutputAsset}`,
        );
      }
    }

    if (asset === pair.usdc.toLowerCase()) {
      return { tokensIn: pair.usdc, tokensOut: pair.ptUSDe };
    } else if (asset === pair.ptUSDe.toLowerCase()) {
      return { tokensIn: pair.ptUSDe, tokensOut: pair.usdc };
    } else {
      throw new Error(`Invalid asset for USDC/ptUSDe swap: ${route.asset}`);
    }
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      this.validateSameChainSwap(route);

      const { tokensIn, tokensOut } = this.determineSwapDirection(route);
      const url = `${PENDLE_API_BASE_URL}/${route.origin}/convert`;

      const params = new URLSearchParams({
        receiver: '0x0000000000000000000000000000000000000000',
        slippage: '0.005',
        tokensIn,
        tokensOut,
        amountsIn: amount,
        enableAggregator: 'true',
        aggregators: 'kyberswap',
        additionalData: 'impliedApy,effectiveApy',
      });

      this.logger.debug('Requesting Pendle quote', {
        chainId: route.origin,
        tokensIn,
        tokensOut,
        amountsIn: amount,
        url: `${url}?${params.toString()}`,
      });

      const response = await fetch(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Pendle API request failed: ${response.status} ${response.statusText}`);
      }

      const quoteData = await response.json();

      if (
        !quoteData.routes ||
        quoteData.routes.length === 0 ||
        !quoteData.routes[0].outputs ||
        !quoteData.routes[0].outputs[0]?.amount
      ) {
        throw new Error('Invalid quote response from Pendle API');
      }

      const bestRoute = quoteData.routes[0];
      const amountOut = bestRoute.outputs[0].amount;

      this.logger.debug('Pendle quote obtained', {
        chainId: route.origin,
        amountsIn: amount,
        amountOut: amountOut,
        priceImpact: bestRoute.data?.priceImpact,
        swapFee: bestRoute.data?.swapFee,
        route,
      });

      return amountOut;
    } catch (error) {
      this.logger.error('Failed to get received amount from Pendle API', {
        error: jsonifyError(error),
        amount,
        route,
      });
      throw new Error(`Failed to get Pendle quote: ${(error as Error).message}`);
    }
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      this.validateSameChainSwap(route);

      const { tokensIn, tokensOut } = this.determineSwapDirection(route);
      const url = `${PENDLE_API_BASE_URL}/${route.origin}/convert`;

      const params = new URLSearchParams({
        receiver: recipient,
        slippage: '0.005',
        tokensIn,
        tokensOut,
        amountsIn: amount,
        enableAggregator: 'true',
        aggregators: 'kyberswap',
        additionalData: 'impliedApy,effectiveApy',
      });

      this.logger.info('Getting Pendle swap transactions', {
        chainId: route.origin,
        sender,
        recipient,
        tokensIn,
        tokensOut,
        amountsIn: amount,
      });

      const response = await fetch(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Pendle API request failed: ${response.status} ${response.statusText}`);
      }

      const swapData = await response.json();

      if (!swapData.routes || !Array.isArray(swapData.routes) || swapData.routes.length === 0) {
        throw new Error('No routes returned from Pendle API');
      }

      const bestRoute = swapData.routes[0];

      if (!bestRoute.tx || !bestRoute.outputs || !bestRoute.outputs[0]?.amount) {
        throw new Error('Invalid route data from Pendle API');
      }

      const transactions: MemoizedTransactionRequest[] = [];

      const tokenAddress = tokensIn as `0x${string}`;
      const spenderAddress = bestRoute.tx.to as `0x${string}`;
      const requiredAmount = BigInt(amount);

      // Get current allowance
      const providers = this.chains[route.origin.toString()]?.providers ?? [];
      if (!providers.length) {
        throw new Error(`No providers found for origin chain ${route.origin}`);
      }

      const transports = providers.map((p: string) => http(p));
      const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
      const client = createPublicClient({ transport });

      const allowance = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [sender as `0x${string}`, spenderAddress],
      });

      // Add approval transaction if needed
      if (allowance < requiredAmount) {
        this.logger.info('Adding approval transaction for Pendle swap', {
          chainId: route.origin,
          tokenAddress,
          spenderAddress,
          currentAllowance: allowance.toString(),
          requiredAmount: requiredAmount.toString(),
        });

        const approvalTx: MemoizedTransactionRequest = {
          transaction: {
            to: tokenAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [spenderAddress, requiredAmount],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
          memo: RebalanceTransactionMemo.Approval,
        };
        transactions.push(approvalTx);
      }

      // Add the main swap transaction
      const swapTransaction: MemoizedTransactionRequest = {
        transaction: {
          to: bestRoute.tx.to as `0x${string}`,
          data: bestRoute.tx.data as `0x${string}`,
          value: BigInt(bestRoute.tx.value || '0'),
        },
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount: bestRoute.outputs[0].amount,
      };
      transactions.push(swapTransaction);

      this.logger.info('Pendle swap transactions prepared', {
        chainId: route.origin,
        totalTransactions: transactions.length,
        needsApproval: allowance < requiredAmount,
        expectedAmountOut: bestRoute.outputs[0].amount,
        priceImpact: bestRoute.data?.priceImpact,
      });

      return transactions;
    } catch (error) {
      this.logger.error('Failed to prepare Pendle swap transactions', {
        error: jsonifyError(error),
        sender,
        recipient,
        amount,
        route,
      });
      throw new Error(`Failed to prepare Pendle swap: ${(error as Error).message}`);
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    try {
      this.validateSameChainSwap(route);

      // Handle both viem string status ('success') and database numeric status (1)
      const isSuccessful =
        originTransaction && (originTransaction.status === 'success' || (originTransaction.status as unknown) === 1);

      if (!isSuccessful) {
        this.logger.debug('Transaction not successful yet', {
          transactionHash: originTransaction?.transactionHash,
          status: originTransaction?.status,
        });
        return false;
      }

      this.logger.debug('Pendle swap transaction completed', {
        transactionHash: originTransaction.transactionHash,
        blockNumber: originTransaction.blockNumber,
        route,
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to check if ready on destination', {
        error: jsonifyError(error),
        amount,
        route,
        transactionHash: originTransaction?.transactionHash,
      });
      return false;
    }
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    // Pendle adapter handles same-chain swaps only
    // Cross-chain bridging should be handled by dedicated bridge adapters (CCIP, etc.)
    this.logger.debug('Pendle adapter completed same-chain swap', {
      transactionHash: originTransaction.transactionHash,
      route,
    });

    // No destination callback needed for same-chain swaps
    return;
  }
}
