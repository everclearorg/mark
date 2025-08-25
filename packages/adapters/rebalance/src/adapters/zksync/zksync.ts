import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  erc20Abi,
  PublicClient,
  fallback,
  parseEventLogs,
  parseAbi,
} from 'viem';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { SupportedBridge, ChainConfiguration, ILogger } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import type { RebalanceRoute } from '@mark/core';

const ZKSYNC_L1_BRIDGE = '0x57891966931eb4bb6fb81430e6ce0a03aabde063';
const ZKSYNC_L2_BRIDGE = '0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102';
const ETH_TOKEN_L2 = '0x000000000000000000000000000000000000800A';
const WITHDRAWAL_DELAY_HOURS = 24;

const zkSyncL1BridgeAbi = parseAbi([
  'function deposit(address _l2Receiver, address _l1Token, uint256 _amount, uint256 _l2TxGasLimit, uint256 _l2TxGasPerPubdataByte, address _refundRecipient) payable',
  'function finalizeWithdrawal(uint256 _l2BatchNumber, uint256 _l2MessageIndex, uint16 _l2TxNumberInBatch, bytes calldata _message, bytes32[] calldata _merkleProof)',
  'event DepositInitiated(bytes32 indexed l2DepositTxHash, address indexed from, address indexed to, address l1Token, uint256 amount)',
]);

const zkSyncL2BridgeAbi = parseAbi([
  'function withdraw(address _l1Receiver, address _l2Token, uint256 _amount)',
  'event WithdrawalInitiated(address indexed l2Sender, address indexed l1Receiver, address indexed l2Token, uint256 amount)',
]);


export class ZKSyncNativeBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: ILogger,
  ) {}

  type(): SupportedBridge {
    return SupportedBridge.Zksync;
  }

  // https://docs.zksync.io/zk-stack/concepts/fee-mechanism
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      return amount;
    } catch (error) {
      this.handleError(error, 'calculate received amount', { amount, route });
    }
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      const isL1ToL2 = route.origin === 1 && route.destination === 324;
      const isETH = route.asset.toLowerCase() === '0x0000000000000000000000000000000000000000';
      const transactions: MemoizedTransactionRequest[] = [];

      if (isL1ToL2) {
        if (!isETH) {
          const client = await this.getClient(route.origin);
          const allowance = await client.readContract({
            address: route.asset as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender as `0x${string}`, ZKSYNC_L1_BRIDGE as `0x${string}`],
          });

          if (allowance < BigInt(amount)) {
            transactions.push({
              memo: RebalanceTransactionMemo.Approval,
              transaction: {
                to: route.asset as `0x${string}`,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [ZKSYNC_L1_BRIDGE as `0x${string}`, BigInt(amount)],
                }),
                value: BigInt(0),
              },
            });
          }
        }

        transactions.push({
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: ZKSYNC_L1_BRIDGE as `0x${string}`,
            data: encodeFunctionData({
              abi: zkSyncL1BridgeAbi,
              functionName: 'deposit',
              args: [
                recipient as `0x${string}`,
                route.asset as `0x${string}`,
                BigInt(amount),
                BigInt(200000),
                BigInt(800),
                sender as `0x${string}`,
              ],
            }),
            value: isETH ? BigInt(amount) : BigInt(0),
          },
        });
      } else {
        transactions.push({
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: ZKSYNC_L2_BRIDGE as `0x${string}`,
            data: encodeFunctionData({
              abi: zkSyncL2BridgeAbi,
              functionName: 'withdraw',
              args: [
                recipient as `0x${string}`,
                route.asset === '0x0000000000000000000000000000000000000000'
                  ? (ETH_TOKEN_L2 as `0x${string}`)
                  : (route.asset as `0x${string}`),
                BigInt(amount),
              ],
            }),
            value: BigInt(0),
          },
        });
      }

      return transactions;
    } catch (error) {
      this.handleError(error, 'prepare bridge transactions', { sender, recipient, amount, route });
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    try {
      const isL1ToL2 = route.origin === 1 && route.destination === 324;

      if (isL1ToL2) {
        return true;
      } else {
        this.logger.info('zkSync withdrawal delay check - 24-hour delay required', {
          txBlock: Number(originTransaction.blockNumber),
          txHash: originTransaction.transactionHash,
          requiredDelayHours: WITHDRAWAL_DELAY_HOURS,
        });

        return true;
      }
    } catch (error) {
      this.handleError(error, 'check destination readiness', { amount, route, originTransaction });
    }
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    try {
      const isL2ToL1 = route.origin === 324 && route.destination === 1;

      if (isL2ToL1) {
        const logs = parseEventLogs({
          abi: zkSyncL2BridgeAbi,
          logs: originTransaction.logs,
        });

        const withdrawalEvent = logs.find((log) => log.eventName === 'WithdrawalInitiated');
        if (!withdrawalEvent) {
          this.logger.warn('No WithdrawalInitiated event found in transaction logs');
          return;
        }

        this.logger.info('zkSync withdrawal requires manual finalization after 24-hour delay', {
          withdrawalTxHash: originTransaction.transactionHash,
          blockNumber: originTransaction.blockNumber,
        });

        throw new Error('zkSync withdrawal finalization not yet implemented - requires batch proof integration');
      }
    } catch (error) {
      this.handleError(error, 'prepare destination callback', { route, originTransaction });
    }
  }

  private async getClient(chainId: number): Promise<PublicClient> {
    const providers = this.chains[chainId.toString()]?.providers ?? [];
    if (providers.length === 0) {
      throw new Error(`No providers configured for chain ${chainId}`);
    }

    return createPublicClient({
      transport: fallback(providers.map((provider: string) => http(provider))),
    });
  }

  private handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    throw new Error(`Failed to ${context}: ${(error as Error)?.message ?? ''}`);
  }
}
