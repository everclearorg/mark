import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  erc20Abi,
  fallback,
  type PublicClient,
} from 'viem';
import { CrossChainMessenger, MessageStatus } from '@mantlenetworkio/sdk'
import { ChainConfiguration, SupportedBridge, RebalanceRoute } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { MANTLE_BRIDGE_ABI, MANTLE_STAKING_ABI } from './abi';
import { findMatchingDestinationAsset } from '../../shared/asset';
import { METH_STAKING_CONTRACT_ADDRESS, METH_ON_ETH_ADDRESS, METH_ON_MANTLE_ADDRESS, MANTLE_BRIDGE_CONTRACT_ADDRESS } from './types';


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


// Represents whether an on-chain fill requires a follow-up callback
interface CallbackInfo {
  needsCallback: boolean;
  amount?: bigint;
  recipient?: string;
}
export class MantleBridgeAdapter implements BridgeAdapter {
  protected readonly publicClients = new Map<number, PublicClient>();

  constructor(
    protected readonly url: string,
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing MantleBridgeAdapter', { url });
  }

  type(): SupportedBridge {
    return SupportedBridge.Mantle;
  }

  /**
   * Queries the Mantle staking contract for the expected mETH output.
   */
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    const client = this.getPublicClient(route.origin);

    try {
      const minimumStakeBound = await client.readContract({
        address: METH_STAKING_CONTRACT_ADDRESS as `0x${string}`,
        abi: MANTLE_STAKING_ABI,
        functionName: 'minimumStakeBound',
      }) as bigint;

      if (minimumStakeBound > BigInt(amount)) {
        throw new Error(`Amount: ${amount} is less than minimum stake bound: ${minimumStakeBound.toString()}`);
      }

      const mEthAmount = await client.readContract({
        address: METH_STAKING_CONTRACT_ADDRESS as `0x${string}`,
        abi: MANTLE_STAKING_ABI,
        functionName: 'ethToMETH',
        args: [BigInt(amount)],
      }) as bigint;


      this.logger.debug('Mantle staking contract quote obtained', {
        ethAmount: amount,
        methAmount: mEthAmount.toString(),
        route,
      });

      return mEthAmount.toString();
    } catch (error) {
      this.handleError(error, 'get m-eth amount', { amount, route });
    }
  }

  /**
   * Builds the set of transactions required to unwrap WETH, stake into mETH,
   * approve the bridge (when needed), and finally bridge funds to Mantle.
   */
  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      const outputToken = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        this.chains,
        this.logger,
      );
      if (!outputToken) {
        throw new Error('Could not find matching destination asset');
      }
      
      // Unwrap WETH to ETH before staking
      const unwrapTx = {
        memo: RebalanceTransactionMemo.Unwrap,
        effectiveAmount: amount,
        transaction: {
          to: route.asset as `0x${string}`,
          data: encodeFunctionData({
            abi: wethAbi,
            functionName: 'withdraw',
            args: [BigInt(amount)],
          }) as `0x${string}`,
          value: BigInt(0),
          funcSig: 'withdraw(uint256)',
        },
      };

      const mEthAmount = await this.getReceivedAmount(amount, route);

      // Stake ETH to get mETH
      const stakeTx: MemoizedTransactionRequest = {
        memo: RebalanceTransactionMemo.Stake,
        effectiveAmount: mEthAmount,
        transaction: {
          to: METH_STAKING_CONTRACT_ADDRESS as `0x${string}`,
          data: encodeFunctionData({
            abi: MANTLE_STAKING_ABI,
            functionName: 'stake',
            args: [BigInt(mEthAmount)],
          }) as `0x${string}`,
          value: BigInt(0),
          funcSig: 'stake(uint256)',
        },
      }

      let approvalTx: MemoizedTransactionRequest | undefined;
      const client = this.getPublicClient(route.origin);
      const allowance = await client.readContract({
        address: METH_ON_ETH_ADDRESS,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [sender as `0x${string}`, MANTLE_BRIDGE_CONTRACT_ADDRESS],
      });

      if (allowance < BigInt(mEthAmount)) {
        approvalTx = {
          memo: RebalanceTransactionMemo.Approval,
          transaction: {
            to: METH_ON_ETH_ADDRESS as `0x${string}`,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [MANTLE_BRIDGE_CONTRACT_ADDRESS as `0x${string}`, BigInt(mEthAmount)],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
        };
      }
      
      const bridgeTx: MemoizedTransactionRequest = {
        memo: RebalanceTransactionMemo.Rebalance,
        transaction: {
          to: MANTLE_BRIDGE_CONTRACT_ADDRESS,
          data: encodeFunctionData({
            abi: MANTLE_BRIDGE_ABI,
            functionName: 'depositERC20To',
            args: [
              METH_ON_ETH_ADDRESS, // _l1Token
              METH_ON_MANTLE_ADDRESS, // _l2Token
              recipient, // _to
              BigInt(mEthAmount), // _amount
              BigInt(200000), // _l2Gas
              '0x', // _data
            ],
          }),
          value: BigInt(0),
          funcSig:
            'depositERC20To(address,address,address,uint256,uint32,bytes)',
        },
      };

      return [unwrapTx, stakeTx, approvalTx, bridgeTx].filter((x) => !!x);
    } catch (error) {
      this.handleError(error, 'prepare Mantle bridge transaction', { amount, route });
    }
  }

  /**
   * Mantle bridge does not require destination callbacks once the message relays.
   */
  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    this.logger.debug('Mantle destinationCallback invoked - no action required', {
      transactionHash: originTransaction.transactionHash,
      route,
    });
    return;
  }

  /**
   * Checks whether the L2 side has finalized the bridge transfer.
   */
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
      const isReady = statusData.status === 'filled';
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

  /** Helper method to get deposit status from the Mantle SDK */
  protected async getDepositStatus(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<{ status: 'filled' | 'pending' | 'unfilled' } | undefined> {
    try {
      const crossChainMessenger = new CrossChainMessenger({
        l1ChainId: route.origin,
        l2ChainId: route.destination,
        l1SignerOrProvider: this.chains[route.origin.toString()]?.providers[0],
        l2SignerOrProvider: this.chains[route.destination.toString()]?.providers[0],
      });
      
      const status = await crossChainMessenger.getMessageStatus(originTransaction.transactionHash);

      if (status === MessageStatus.RELAYED) {
        return { status: 'filled' };
      } else if (status === MessageStatus.UNCONFIRMED_L1_TO_L2_MESSAGE) {
        return { status: 'pending' };
      } else {
        return { status: 'unfilled' };
      }
    } catch (error) {
      this.logger.error('Failed to get deposit status', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      throw error;
    }
  }

  /** Mantle bridge currently never requires callbacks, but keep hook for parity with interface */
  protected async requiresCallback(route: RebalanceRoute, fillTxHash: string): Promise<CallbackInfo> {
    return { needsCallback: false };
  }

  /** Logs and rethrows errors with consistent context */
  protected handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(`Failed to ${context}: ${(error as any)?.message ?? ''}`);
  }

  /** Returns a cached public client for the provided chain id. */
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
}
