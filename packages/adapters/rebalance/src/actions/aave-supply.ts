import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  fallback,
} from 'viem';
import { ChainConfiguration, PostBridgeActionConfig, PostBridgeActionType, AaveSupplyActionConfig } from '@mark/core';
import { Logger } from '@mark/logger';
import { MemoizedTransactionRequest, RebalanceTransactionMemo } from '../types';
import { PostBridgeActionHandler } from './types';

const AAVE_POOL_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'asset', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'address', name: 'onBehalfOf', type: 'address' },
      { internalType: 'uint16', name: 'referralCode', type: 'uint16' },
    ],
    name: 'supply',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export class AaveSupplyActionHandler implements PostBridgeActionHandler {
  constructor(
    private readonly chains: Record<string, ChainConfiguration>,
    private readonly logger: Logger,
  ) {}

  async buildTransactions(
    sender: string,
    amount: string,
    destinationChainId: number,
    actionConfig: PostBridgeActionConfig,
  ): Promise<MemoizedTransactionRequest[]> {
    if (actionConfig.type !== PostBridgeActionType.AaveSupply) {
      throw new Error(`AaveSupplyActionHandler received unexpected action type: ${actionConfig.type}`);
    }

    const config = actionConfig as AaveSupplyActionConfig;
    const { poolAddress, supplyAsset, referralCode = 0 } = config;
    const onBehalfOf = config.onBehalfOf ?? sender;

    const txs: MemoizedTransactionRequest[] = [];

    // Create a public client for the destination chain to check allowance
    const providers = this.chains[destinationChainId.toString()]?.providers ?? [];
    if (!providers.length) {
      throw new Error(`No providers found for destination chain ${destinationChainId}`);
    }

    const client = createPublicClient({
      transport: fallback(providers.map((provider: string) => http(provider))),
    });

    // Check current allowance
    const allowance = await client.readContract({
      address: supplyAsset as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [sender as `0x${string}`, poolAddress as `0x${string}`],
    });

    if (allowance < BigInt(amount)) {
      this.logger.info('Aave supply: building approval transaction', {
        supplyAsset,
        poolAddress,
        currentAllowance: allowance.toString(),
        requiredAmount: amount,
        destinationChainId,
      });

      txs.push({
        memo: RebalanceTransactionMemo.Approval,
        transaction: {
          to: supplyAsset as `0x${string}`,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [poolAddress as `0x${string}`, BigInt(amount)],
          }),
          value: BigInt(0),
        },
      });
    } else {
      this.logger.info('Aave supply: sufficient allowance, skipping approval', {
        supplyAsset,
        poolAddress,
        currentAllowance: allowance.toString(),
        requiredAmount: amount,
        destinationChainId,
      });
    }

    // Build supply transaction
    txs.push({
      memo: RebalanceTransactionMemo.AaveSupply,
      transaction: {
        to: poolAddress as `0x${string}`,
        data: encodeFunctionData({
          abi: AAVE_POOL_ABI,
          functionName: 'supply',
          args: [
            supplyAsset as `0x${string}`,
            BigInt(amount),
            onBehalfOf as `0x${string}`,
            referralCode,
          ],
        }),
        value: BigInt(0),
      },
    });

    this.logger.info('Aave supply: built transactions', {
      transactionCount: txs.length,
      supplyAsset,
      poolAddress,
      amount,
      onBehalfOf,
      referralCode,
      destinationChainId,
    });

    return txs;
  }
}
