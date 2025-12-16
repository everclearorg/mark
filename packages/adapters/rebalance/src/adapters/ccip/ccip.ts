import { 
  TransactionReceipt, 
  createPublicClient, 
  http, 
  fallback, 
  encodeFunctionData, 
  erc20Abi,
  Address 
} from 'viem';
import { mainnet } from 'viem/chains';
import { SupportedBridge, RebalanceRoute, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import * as CCIP from '@chainlink/ccip-js';
import { 
  CCIPMessage, 
  CCIPTransferStatus,
  CHAIN_SELECTORS, 
  CCIP_ROUTER_ADDRESSES, 
  CCIP_SUPPORTED_CHAINS
} from './types';

// Chainlink CCIP Router ABI
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

export class CCIPBridgeAdapter implements BridgeAdapter {
  private ccipClient: any;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing CCIPBridgeAdapter');
    this.ccipClient = CCIP.createClient();
  }

  type(): SupportedBridge {
    return SupportedBridge.CCIP;
  }

  async getMinimumAmount(_route: RebalanceRoute): Promise<string | null> {
    // CCIP has no fixed minimum, depends on fee costs
    return null;
  }

  private validateCCIPRoute(route: RebalanceRoute): void {
    const originChainId = route.origin;
    const destinationChainId = route.destination;

    // Check origin chain support
    if (!CCIP_SUPPORTED_CHAINS[originChainId as keyof typeof CCIP_SUPPORTED_CHAINS]) {
      throw new Error(`Origin chain ${originChainId} not supported by CCIP`);
    }

    // For Solana destination, we allow it even though it's not in CCIP_SUPPORTED_CHAINS
    // since CCIP supports Solana as a destination
    if (destinationChainId !== parseInt(CHAIN_SELECTORS.SOLANA) && 
        !CCIP_SUPPORTED_CHAINS[destinationChainId as keyof typeof CCIP_SUPPORTED_CHAINS]) {
      throw new Error(`Destination chain ${destinationChainId} not supported by CCIP`);
    }

    // Check if router is available for origin chain
    const routerAddress = CCIP_ROUTER_ADDRESSES[originChainId];
    if (!routerAddress) {
      throw new Error(`CCIP router not available for origin chain ${originChainId}`);
    }
  }

  private getDestinationChainSelector(chainId: number): string {
    // Special handling for Solana
    if (chainId.toString() === CHAIN_SELECTORS.SOLANA) {
      return CHAIN_SELECTORS.SOLANA;
    }

    // Map standard chain IDs to CCIP selectors
    switch (chainId) {
      case 1: return CHAIN_SELECTORS.ETHEREUM;
      case 42161: return CHAIN_SELECTORS.ARBITRUM;
      case 10: return CHAIN_SELECTORS.OPTIMISM;
      case 137: return CHAIN_SELECTORS.POLYGON;
      case 8453: return CHAIN_SELECTORS.BASE;
      default:
        throw new Error(`Unsupported destination chain ID: ${chainId}`);
    }
  }

  private encodeSolanaAddress(solanaAddress: string): `0x${string}` {
    // Encode Solana base58 address as bytes for CCIP
    // For now, convert string to bytes - may need refinement based on CCIP specs
    const addressBytes = Buffer.from(solanaAddress, 'utf8');
    return `0x${addressBytes.toString('hex')}` as `0x${string}`;
  }

  private encodeRecipientAddress(address: string, destinationChainId: number): `0x${string}` {
    // Check if destination is Solana
    if (destinationChainId.toString() === CHAIN_SELECTORS.SOLANA) {
      return this.encodeSolanaAddress(address);
    }
    
    // For EVM chains, ensure address is properly formatted
    if (!address.startsWith('0x') || address.length !== 42) {
      throw new Error(`Invalid EVM address format: ${address}`);
    }
    
    return address as `0x${string}`;
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      this.validateCCIPRoute(route);

      // CCIP is 1:1 for token transfers (same token on both sides)
      // Fee is paid separately in native token
      this.logger.debug('CCIP 1:1 transfer, no price impact', {
        amount,
        route,
      });

      return amount;
    } catch (error) {
      this.logger.error('Failed to get received amount for CCIP transfer', {
        error: jsonifyError(error),
        amount,
        route,
      });
      throw error;
    }
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      this.validateCCIPRoute(route);

      const originChainId = route.origin;
      const destinationChainSelector = this.getDestinationChainSelector(route.destination);
      const routerAddress = CCIP_ROUTER_ADDRESSES[originChainId];
      const tokenAddress = route.asset as Address;
      const tokenAmount = BigInt(amount);

      this.logger.info('Preparing CCIP cross-chain transfer', {
        originChainId,
        destinationChainId: route.destination,
        destinationChainSelector,
        tokenAddress,
        amount,
        sender,
        recipient,
      });

      // Create CCIP message
      const ccipMessage: CCIPMessage = {
        receiver: this.encodeRecipientAddress(recipient, route.destination),
        data: '0x' as `0x${string}`, // No additional data for simple token transfer
        tokenAmounts: [{
          token: tokenAddress,
          amount: tokenAmount,
        }],
        extraArgs: '0x' as `0x${string}`, // Default args
        feeToken: '0x0000000000000000000000000000000000000000' as Address, // Pay fees in native token
      };

      // Get providers for the origin chain
      const providers = this.chains[originChainId.toString()]?.providers ?? [];
      if (!providers.length) {
        throw new Error(`No providers found for origin chain ${originChainId}`);
      }

      const transports = providers.map((p: string) => http(p));
      const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
      const client = createPublicClient({ transport });

      // Get CCIP fee estimate
      const ccipFee = await client.readContract({
        address: routerAddress,
        abi: CCIP_ROUTER_ABI,
        functionName: 'getFee',
        args: [BigInt(destinationChainSelector), {
          receiver: ccipMessage.receiver,
          data: ccipMessage.data,
          tokenAmounts: ccipMessage.tokenAmounts,
          extraArgs: ccipMessage.extraArgs,
          feeToken: ccipMessage.feeToken,
        }],
      });

      this.logger.info('CCIP fee calculated', {
        fee: ccipFee.toString(),
        originChainId,
      });

      // Check token allowance for CCIP router
      const currentAllowance = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [sender as Address, routerAddress],
      });

      const transactions: MemoizedTransactionRequest[] = [];

      // Add approval transaction if needed
      if (currentAllowance < tokenAmount) {
        this.logger.info('Adding approval transaction for CCIP transfer', {
          originChainId,
          tokenAddress,
          routerAddress,
          currentAllowance: currentAllowance.toString(),
          requiredAmount: tokenAmount.toString(),
        });

        const approvalTx: MemoizedTransactionRequest = {
          transaction: {
            to: tokenAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [routerAddress, tokenAmount],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
          memo: RebalanceTransactionMemo.Approval,
        };
        transactions.push(approvalTx);
      }

      // Add CCIP send transaction
      const ccipTx: MemoizedTransactionRequest = {
        transaction: {
          to: routerAddress,
          data: encodeFunctionData({
            abi: CCIP_ROUTER_ABI,
            functionName: 'ccipSend',
            args: [BigInt(destinationChainSelector), {
              receiver: ccipMessage.receiver,
              data: ccipMessage.data,
              tokenAmounts: ccipMessage.tokenAmounts,
              extraArgs: ccipMessage.extraArgs,
              feeToken: ccipMessage.feeToken,
            }],
          }),
          value: ccipFee, // Pay fee in native token
          funcSig: 'ccipSend(uint64,(bytes,bytes,(address,uint256)[],bytes,address))',
        },
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount: amount,
      };
      transactions.push(ccipTx);

      this.logger.info('CCIP transfer transactions prepared', {
        originChainId,
        totalTransactions: transactions.length,
        needsApproval: currentAllowance < tokenAmount,
        ccipFee: ccipFee.toString(),
        effectiveAmount: amount,
      });

      return transactions;
    } catch (error) {
      this.logger.error('Failed to prepare CCIP transfer transactions', {
        error: jsonifyError(error),
        sender,
        recipient,
        amount,
        route,
      });
      throw error;
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    try {
      this.validateCCIPRoute(route);

      if (!originTransaction || originTransaction.status !== 'success') {
        this.logger.debug('Origin transaction not successful yet', {
          transactionHash: originTransaction?.transactionHash,
          status: originTransaction?.status,
        });
        return false;
      }

      // Use CCIP SDK to check transfer status
      const transferStatus = await this.getTransferStatus(
        originTransaction.transactionHash,
        route.origin,
        route.destination
      );

      const isReady = transferStatus.status === 'SUCCESS';

      this.logger.debug('CCIP transfer readiness check', {
        transactionHash: originTransaction.transactionHash,
        transferStatus,
        isReady,
        route,
      });

      return isReady;
    } catch (error) {
      this.logger.error('Failed to check if CCIP transfer is ready on destination', {
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
    this.logger.debug('CCIP transfers do not require destination callbacks', {
      transactionHash: originTransaction.transactionHash,
      route,
    });
    // CCIP handles the cross-chain transfer automatically
    // No additional destination callback needed
    return;
  }

  /**
   * Get CCIP transfer status using the official SDK
   */
  async getTransferStatus(
    transactionHash: string,
    originChainId: number,
    destinationChainId: number
  ): Promise<CCIPTransferStatus> {
    try {
      this.logger.debug('Checking CCIP transfer status', {
        transactionHash,
        originChainId,
        destinationChainId,
      });

      // Create a public client for the destination chain to check status
      let destinationClient;
      
      if (destinationChainId === parseInt(CHAIN_SELECTORS.SOLANA)) {
        // For Solana destination, use Ethereum mainnet client (CCIP hub)
        destinationClient = createPublicClient({
          chain: mainnet,
          transport: http(),
        });
      } else {
        // For EVM destinations, create client for that specific chain
        const providers = this.chains[destinationChainId.toString()]?.providers ?? [];
        if (!providers.length) {
          throw new Error(`No providers found for destination chain ${destinationChainId}`);
        }

        const transports = providers.map((p: string) => http(p));
        const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
        destinationClient = createPublicClient({ transport });
      }

      const destinationRouterAddress = CCIP_ROUTER_ADDRESSES[destinationChainId] || 
                                     '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D'; // Default to Ethereum router for Solana

      const sourceChainSelector = this.getDestinationChainSelector(originChainId);

      // Use transaction hash directly as message ID
      const transferStatus = await this.ccipClient.getTransferStatus({
        client: destinationClient as any, // Type compatibility
        destinationRouterAddress,
        sourceChainSelector,
        messageId: transactionHash as `0x${string}`,
      });

      this.logger.debug('CCIP SDK transfer status response', {
        transactionHash,
        transferStatus,
        sourceChainSelector,
        destinationRouterAddress,
      });

      if (transferStatus === null) {
        return {
          status: 'PENDING',
          message: 'Transfer not yet found on destination chain',
        };
      }

      // TransferStatus enum: Untouched = 0, InProgress = 1, Success = 2, Failure = 3
      switch (transferStatus) {
        case 2: // Success
          return {
            status: 'SUCCESS',
            message: 'CCIP transfer completed successfully',
            destinationTransactionHash: transactionHash,
          };
        case 3: // Failure
          return {
            status: 'FAILURE',
            message: 'CCIP transfer failed',
          };
        case 1: // InProgress
          return {
            status: 'PENDING',
            message: 'CCIP transfer in progress',
          };
        case 0: // Untouched
        default:
          return {
            status: 'PENDING',
            message: 'CCIP transfer pending or not yet started',
          };
      }
    } catch (error) {
      this.logger.error('Failed to check CCIP transfer status', {
        error: jsonifyError(error),
        transactionHash,
        originChainId,
        destinationChainId,
      });
      
      // Return pending on error to avoid blocking
      return {
        status: 'PENDING',
        message: `Error checking status: ${(error as Error).message}`,
      };
    }
  }
}