import { TransactionReceipt, createPublicClient, http, fallback, encodeFunctionData, erc20Abi } from 'viem';
import { SupportedBridge, RebalanceRoute, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import {
  PENDLE_API_BASE_URL,
  PENDLE_SUPPORTED_CHAINS,
  USDC_PTUSDE_PAIRS,
  CCIP_ROUTER_ADDRESSES,
  SOLANA_CHAIN_SELECTOR,
  EVM2AnyMessage,
} from './types';

// Chainlink CCIP Router ABI (minimal for ccipSend and getFee)
const CCIP_ROUTER_ABI = [
  {
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message', type: 'tuple', components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts', type: 'tuple[]', components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' }
            ]
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' }
        ]
      }
    ],
    name: 'getFee',
    outputs: [{ name: 'fee', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message', type: 'tuple', components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts', type: 'tuple[]', components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' }
            ]
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' }
        ]
      }
    ],
    name: 'ccipSend',
    outputs: [{ name: 'messageId', type: 'bytes32' }],
    stateMutability: 'payable',
    type: 'function'
  }
] as const;

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
        throw new Error(`Invalid USDC/ptUSDe swap pair: asset=${route.asset}, swapOutputAsset=${route.swapOutputAsset}`);
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

      if (!quoteData.routes || quoteData.routes.length === 0 || !quoteData.routes[0].outputs || !quoteData.routes[0].outputs[0]?.amount) {
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

      if (!originTransaction || originTransaction.status !== 'success') {
        this.logger.debug('Transaction not successful yet', {
          transactionHash: originTransaction.transactionHash,
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
    try {
      // Check if this route should bridge to Solana via CCIP
      if (!route.swapOutputAsset || route.destination === route.origin) {
        this.logger.debug('No cross-chain bridging needed for Pendle swap', {
          transactionHash: originTransaction.transactionHash,
          route,
        });
        return;
      }

      const chainId = route.origin;
      const ccipRouterAddress = CCIP_ROUTER_ADDRESSES[chainId];

      if (!ccipRouterAddress) {
        this.logger.warn('CCIP Router not available for chain, skipping cross-chain bridge', {
          chainId,
          availableChains: Object.keys(CCIP_ROUTER_ADDRESSES),
        });
        return;
      }

      // Get ptUSDe token address and amount from the swap
      const { tokensOut } = this.determineSwapDirection(route);
      const ptUsdeAddress = tokensOut as `0x${string}`;

      // Extract ptUSDe amount from transaction receipt logs
      const ptUsdeAmount = await this.extractTokenAmountFromLogs(
        originTransaction,
        ptUsdeAddress,
        route.origin
      );

      if (!ptUsdeAmount || ptUsdeAmount === 0n) {
        this.logger.warn('No ptUSDe amount found in transaction logs', {
          transactionHash: originTransaction.transactionHash,
          ptUsdeAddress,
        });
        return;
      }

      // Get Solana recipient address (assume same as EVM recipient for now)
      const solanaRecipient = route.swapOutputAsset; // This should be the Solana address

      this.logger.info('Preparing CCIP bridge transaction for ptUSDe to Solana', {
        chainId,
        ptUsdeAddress,
        ptUsdeAmount: ptUsdeAmount.toString(),
        solanaRecipient,
        ccipRouter: ccipRouterAddress,
      });

      // Create CCIP message
      const ccipMessage: EVM2AnyMessage = {
        receiver: this.encodeSolanaAddress(solanaRecipient) as `0x${string}`, // Encode Solana address to bytes
        data: '0x' as `0x${string}`, // No additional data needed
        tokenAmounts: [{
          token: ptUsdeAddress,
          amount: ptUsdeAmount,
        }],
        extraArgs: '0x' as `0x${string}`, // Default extra args
        feeToken: '0x0000000000000000000000000000000000000000' as `0x${string}`, // Pay fees in native token
      };

      // Get CCIP fee estimate
      const providers = this.chains[chainId.toString()]?.providers ?? [];
      if (!providers.length) {
        throw new Error(`No providers found for chain ${chainId}`);
      }

      const transports = providers.map((p: string) => http(p));
      const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
      const client = createPublicClient({ transport });

      const ccipFee = await client.readContract({
        address: ccipRouterAddress as `0x${string}`,
        abi: CCIP_ROUTER_ABI,
        functionName: 'getFee',
        args: [BigInt(SOLANA_CHAIN_SELECTOR), {
          receiver: ccipMessage.receiver,
          data: ccipMessage.data,
          tokenAmounts: ccipMessage.tokenAmounts,
          extraArgs: ccipMessage.extraArgs,
          feeToken: ccipMessage.feeToken,
        }],
      });

      this.logger.info('CCIP fee calculated', {
        fee: ccipFee.toString(),
        chainId,
      });

      // Check current allowance for CCIP router
      const currentAllowance = await client.readContract({
        address: ptUsdeAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [this.chains[chainId].gnosisSafeAddress as `0x${string}`, ccipRouterAddress as `0x${string}`], // need to verify address here
      });

      // If allowance is insufficient, we need approval first
      if (currentAllowance < ptUsdeAmount) {
        this.logger.info('Insufficient allowance for CCIP router, approval needed', {
          currentAllowance: currentAllowance.toString(),
          requiredAmount: ptUsdeAmount.toString(),
          ccipRouter: ccipRouterAddress,
        });

        // Return approval transaction first - CCIP send will happen on next callback
        const approvalTx: MemoizedTransactionRequest = {
          transaction: {
            to: ptUsdeAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [ccipRouterAddress as `0x${string}`, ptUsdeAmount],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
          memo: RebalanceTransactionMemo.Approval,
        };
        return approvalTx;
      }

      // Create CCIP bridge transaction
      const ccipTx: MemoizedTransactionRequest = {
        transaction: {
          to: ccipRouterAddress as `0x${string}`,
          data: encodeFunctionData({
            abi: CCIP_ROUTER_ABI,
            functionName: 'ccipSend',
            args: [BigInt(SOLANA_CHAIN_SELECTOR), {
              receiver: ccipMessage.receiver,
              data: ccipMessage.data,
              tokenAmounts: ccipMessage.tokenAmounts,
              extraArgs: ccipMessage.extraArgs,
              feeToken: ccipMessage.feeToken,
            }],
          }),
          value: ccipFee,
          funcSig: 'ccipSend(uint64,(bytes,bytes,(address,uint256)[],bytes,address))',
        },
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount: ptUsdeAmount.toString(),
      };

      this.logger.info('CCIP bridge transaction prepared', {
        transactionHash: originTransaction.transactionHash,
        ptUsdeAmount: ptUsdeAmount.toString(),
        ccipFee: ccipFee.toString(),
        solanaRecipient,
        route,
      });

      // Return both approval and bridge transactions
      // Note: For now returning just the bridge tx, but you might want to handle approvals separately
      return ccipTx;

    } catch (error) {
      this.logger.error('Failed to prepare CCIP bridge transaction', {
        error: jsonifyError(error),
        transactionHash: originTransaction.transactionHash,
        route,
      });
      throw error;
    }
  }

  /**
   * Encode Solana address for CCIP message
   */
  private encodeSolanaAddress(solanaAddress: string): `0x${string}` {
    // For now, return the address as hex bytes
    // You might need to implement proper Solana address encoding based on CCIP specs
    return `0x${Buffer.from(solanaAddress, 'utf8').toString('hex')}` as `0x${string}`;
  }

  /**
   * Extract token amount from transaction logs
   */
  private async extractTokenAmountFromLogs(
    receipt: TransactionReceipt,
    tokenAddress: string,
    _chainId: number
  ): Promise<bigint> {
    try {
      // Look for Transfer events in the receipt logs
      const logs = receipt.logs || [];

      for (const log of logs) {
        if (log.address?.toLowerCase() === tokenAddress.toLowerCase()) {
          // This is a Transfer event from the ptUSDe token
          // Transfer event signature: Transfer(address indexed from, address indexed to, uint256 value)
          if (log.topics && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
            // Extract the value (amount) from the log data
            const value = log.data ? BigInt(log.data) : 0n;
            this.logger.debug('Found ptUSDe Transfer event', {
              tokenAddress,
              amount: value.toString(),
              logIndex: log.logIndex,
            });
            return value;
          }
        }
      }

      this.logger.warn('No Transfer events found for ptUSDe token', {
        tokenAddress,
        logsCount: logs.length,
      });
      return 0n;
    } catch (error) {
      this.logger.error('Failed to extract token amount from logs', {
        error: jsonifyError(error),
        tokenAddress,
      });
      return 0n;
    }
  }
}