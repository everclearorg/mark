import {
  TransactionReceipt,
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  http,
  erc20Abi,
  fallback,
  type PublicClient,
} from 'viem';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, MarkConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { L2CrossDomainMessenger_ABI, MANTLE_BRIDGE_ABI, MANTLE_STAKING_ABI, WETH_ABI } from './abi';
import { findMatchingDestinationAsset } from '../../shared/asset';
import {
  METH_STAKING_CONTRACT_ADDRESS,
  METH_ON_ETH_ADDRESS,
  METH_ON_MANTLE_ADDRESS,
  MANTLE_BRIDGE_CONTRACT_ADDRESS,
} from './types';

// Default L2 gas limit for Mantle bridge transactions
const DEFAULT_L2_GAS = 200000n;

/**
 * Mantle configuration resolved from MarkConfiguration.mantle with defaults
 */
interface ResolvedMantleConfig {
  l2Gas: bigint;
  stakingContractAddress: `0x${string}`;
  methL1Address: `0x${string}`;
  methL2Address: `0x${string}`;
  bridgeContractAddress: `0x${string}`;
}

const MANTLE_MESSENGER_ADDRESSES: Record<number, { l1: `0x${string}`; l2: `0x${string}` }> = {
  5000: {
    l1: '0x676A795fe6E43C17c668de16730c3F690FEB7120',
    l2: '0x4200000000000000000000000000000000000007',
  },
};

type MantleMessage = {
  target: `0x${string}`;
  sender: `0x${string}`;
  message: `0x${string}`;
  messageNonce: bigint;
  mntValue: bigint;
  ethValue: bigint;
  gasLimit: bigint;
};

export class MantleBridgeAdapter implements BridgeAdapter {
  protected readonly publicClients = new Map<number, PublicClient>();
  protected readonly mantleConfig: ResolvedMantleConfig;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
    config?: Pick<MarkConfiguration, 'mantle'>,
  ) {
    // Resolve Mantle configuration with defaults
    // This allows operators to override contract addresses via config if needed
    this.mantleConfig = {
      l2Gas: config?.mantle?.l2Gas ? BigInt(config.mantle.l2Gas) : DEFAULT_L2_GAS,
      stakingContractAddress: (config?.mantle?.stakingContractAddress ??
        METH_STAKING_CONTRACT_ADDRESS) as `0x${string}`,
      methL1Address: (config?.mantle?.methL1Address ?? METH_ON_ETH_ADDRESS) as `0x${string}`,
      methL2Address: (config?.mantle?.methL2Address ?? METH_ON_MANTLE_ADDRESS) as `0x${string}`,
      bridgeContractAddress: (config?.mantle?.bridgeContractAddress ?? MANTLE_BRIDGE_CONTRACT_ADDRESS) as `0x${string}`,
    };

    this.logger.debug('Initializing MantleBridgeAdapter', {
      l2Gas: this.mantleConfig.l2Gas.toString(),
      stakingContract: this.mantleConfig.stakingContractAddress,
      methL1: this.mantleConfig.methL1Address,
      methL2: this.mantleConfig.methL2Address,
      bridgeContract: this.mantleConfig.bridgeContractAddress,
    });
  }

  type(): SupportedBridge {
    return SupportedBridge.Mantle;
  }

  /**
   * Queries the Mantle staking contract for the expected mETH output.
   */
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    const client = this.getPublicClient(route.origin);
    const { stakingContractAddress } = this.mantleConfig;

    try {
      const minimumStakeBound = (await client.readContract({
        address: stakingContractAddress,
        abi: MANTLE_STAKING_ABI,
        functionName: 'minimumStakeBound',
      })) as bigint;

      if (minimumStakeBound > BigInt(amount)) {
        throw new Error(`Amount: ${amount} is less than minimum stake bound: ${minimumStakeBound.toString()}`);
      }

      const mEthAmount = (await client.readContract({
        address: stakingContractAddress,
        abi: MANTLE_STAKING_ABI,
        functionName: 'ethToMETH',
        args: [BigInt(amount)],
      })) as bigint;

      this.logger.debug('Mantle staking contract quote obtained', {
        ethAmount: amount,
        methAmount: mEthAmount.toString(),
        route,
        stakingContract: stakingContractAddress,
      });

      return mEthAmount.toString();
    } catch (error) {
      this.handleError(error, 'get m-eth amount', { amount, route });
    }
  }

  /**
   * Returns the minimum rebalance amount for this bridge.
   * For Mantle, we use the minimum stake bound from the staking contract.
   */
  async getMinimumAmount(route: RebalanceRoute): Promise<string | null> {
    try {
      const client = this.getPublicClient(route.origin);
      const { stakingContractAddress } = this.mantleConfig;
      const minimumStakeBound = (await client.readContract({
        address: stakingContractAddress,
        abi: MANTLE_STAKING_ABI,
        functionName: 'minimumStakeBound',
      })) as bigint;
      return minimumStakeBound.toString();
    } catch (error) {
      this.logger.warn('Failed to get minimum stake bound for Mantle', { error });
      return null;
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

      const client = this.getPublicClient(route.origin);
      const { stakingContractAddress, methL1Address, methL2Address, bridgeContractAddress, l2Gas } = this.mantleConfig;

      // Unwrap WETH to ETH before staking
      const unwrapTx = {
        memo: RebalanceTransactionMemo.Unwrap,
        effectiveAmount: amount,
        transaction: {
          to: route.asset as `0x${string}`,
          data: encodeFunctionData({
            abi: WETH_ABI,
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
        transaction: {
          to: stakingContractAddress,
          data: encodeFunctionData({
            abi: MANTLE_STAKING_ABI,
            functionName: 'stake',
            args: [BigInt(mEthAmount)],
          }) as `0x${string}`,
          value: BigInt(amount),
          funcSig: 'stake(uint256)',
        },
      };

      let approvalTx: MemoizedTransactionRequest | undefined;

      const allowance = await client.readContract({
        address: methL1Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [sender as `0x${string}`, bridgeContractAddress],
      });

      if (allowance < BigInt(mEthAmount)) {
        approvalTx = {
          memo: RebalanceTransactionMemo.Approval,
          transaction: {
            to: methL1Address,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [bridgeContractAddress, BigInt(mEthAmount)],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
        };
      }

      const bridgeTx: MemoizedTransactionRequest = {
        memo: RebalanceTransactionMemo.Rebalance,
        transaction: {
          to: bridgeContractAddress,
          data: encodeFunctionData({
            abi: MANTLE_BRIDGE_ABI,
            functionName: 'depositERC20To',
            args: [
              methL1Address, // _l1Token
              methL2Address, // _l2Token
              recipient as `0x${string}`, // _to
              BigInt(mEthAmount), // _amount
              l2Gas, // _l2Gas (configurable, default 200000)
              '0x', // _data
            ],
          }),
          value: BigInt(0),
          funcSig: 'depositERC20To(address,address,address,uint256,uint32,bytes)',
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
        transactionHash: originTransaction.transactionHash,
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

  /** Helper method to get deposit status by inspecting Mantle messenger contracts via viem */
  protected async getDepositStatus(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<{ status: 'filled' | 'pending' | 'unfilled' } | undefined> {
    try {
      const addresses = this.getMessengerAddresses(route.destination);
      const message = this.extractMantleMessage(originTransaction, addresses.l1);
      const messageHash = this.computeMessageHash(message);
      const l2Client = this.getPublicClient(route.destination);

      const wasRelayed = await this.isMessageRelayed(l2Client, addresses.l2, messageHash);
      if (wasRelayed) {
        return { status: 'filled' };
      }

      const failed = await this.wasMessageFailed(l2Client, addresses.l2, messageHash);
      return { status: failed ? 'unfilled' : 'pending' };
    } catch (error) {
      this.logger.error('Failed to get deposit status', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      throw error;
    }
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

  protected getMessengerAddresses(chainId: number): { l1: `0x${string}`; l2: `0x${string}` } {
    const addresses = MANTLE_MESSENGER_ADDRESSES[chainId];
    if (!addresses) {
      throw new Error(`Unsupported Mantle chain id ${chainId}`);
    }
    return addresses;
  }

  protected extractMantleMessage(receipt: TransactionReceipt, messengerAddress: `0x${string}`): MantleMessage {
    const messenger = messengerAddress.toLowerCase();
    let baseMessage: MantleMessage | undefined;

    for (const log of receipt.logs) {
      if (log.address?.toLowerCase() !== messenger) {
        continue;
      }
      try {
        const topics = log.topics as [`0x${string}`, ...`0x${string}`[]];
        const decoded = decodeEventLog({
          abi: L2CrossDomainMessenger_ABI,
          eventName: undefined,
          data: log.data as `0x${string}`,
          topics,
        });
        if (decoded.eventName === 'SentMessage') {
          const args = decoded.args as {
            target: `0x${string}`;
            sender: `0x${string}`;
            message: `0x${string}`;
            messageNonce: bigint;
            gasLimit: bigint;
          };
          baseMessage = {
            target: args.target,
            sender: args.sender,
            message: args.message,
            messageNonce: BigInt(args.messageNonce),
            gasLimit: BigInt(args.gasLimit),
            // Default to zero; for ERC20 deposits there is no L2 native value.
            mntValue: 0n,
            ethValue: 0n,
          };
        } else if (decoded.eventName === 'SentMessageExtension1' && baseMessage) {
          const args = decoded.args as {
            sender: `0x${string}`;
            mntValue: bigint;
            ethValue: bigint;
          };
          // Sanity check that extension sender matches base sender
          if (args.sender.toLowerCase() === baseMessage.sender.toLowerCase()) {
            baseMessage.mntValue = BigInt(args.mntValue);
            baseMessage.ethValue = BigInt(args.ethValue);
          }
        }
      } catch {
        continue;
      }
    }

    if (!baseMessage) {
      throw new Error('Mantle SentMessage event not found in origin transaction logs');
    }

    return baseMessage;
  }

  protected computeMessageHash(message: MantleMessage): `0x${string}` {
    const encoded = encodeFunctionData({
      abi: L2CrossDomainMessenger_ABI,
      functionName: 'relayMessage',
      args: [
        message.messageNonce,
        message.sender,
        message.target,
        message.mntValue,
        message.ethValue,
        message.gasLimit,
        message.message,
      ],
    });
    return keccak256(encoded);
  }

  protected async isMessageRelayed(
    client: PublicClient,
    messengerAddress: `0x${string}`,
    messageHash: `0x${string}`,
  ): Promise<boolean> {
    try {
      return await client.readContract({
        abi: L2CrossDomainMessenger_ABI,
        address: messengerAddress,
        functionName: 'successfulMessages',
        args: [messageHash],
      });
    } catch (error) {
      this.logger.error('Failed to read successfulMessages', {
        error: jsonifyError(error),
        messengerAddress,
        messageHash,
      });
      throw error;
    }
  }

  protected async wasMessageFailed(
    client: PublicClient,
    messengerAddress: `0x${string}`,
    messageHash: `0x${string}`,
  ): Promise<boolean> {
    try {
      const currentBlock = await client.getBlockNumber();
      const chunkSize = 5000n;
      const numChunks = 4;

      // Fetch logs sequentially in chunks from current block backwards to avoid RPC limits
      // Return early if FailedRelayedMessage event is found
      for (let i = 0; i < numChunks; i++) {
        const chunkToBlock = currentBlock - BigInt(i) * chunkSize;
        const chunkFromBlock = currentBlock - BigInt(i + 1) * chunkSize + 1n;

        const logs = await client.getLogs({
          address: messengerAddress,
          event: {
            type: 'event',
            name: 'FailedRelayedMessage',
            inputs: [{ indexed: true, name: 'msgHash', type: 'bytes32' }],
          } as const,
          args: { msgHash: messageHash },
          fromBlock: chunkFromBlock,
          toBlock: chunkToBlock,
        });

        if (logs.length > 0) {
          this.logger.debug('FailedRelayedMessage logs found', {
            logs,
            fromBlock: chunkFromBlock,
            toBlock: chunkToBlock,
          });
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.error('Failed to read FailedRelayedMessage logs', {
        error: jsonifyError(error),
        messengerAddress,
        messageHash,
      });
      throw error;
    }
  }
}
