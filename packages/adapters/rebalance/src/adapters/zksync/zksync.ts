import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  erc20Abi,
  PublicClient,
  fallback,
  pad,
} from 'viem';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { SupportedBridge, ChainConfiguration, ILogger } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import type { RebalanceRoute } from '@mark/core';
import {
  ZKSYNC_L1_BRIDGE,
  ZKSYNC_L2_BRIDGE,
  ZKSYNC_DIAMOND_PROXY,
  ETH_TOKEN_L2,
  L1_MESSENGER,
  WITHDRAWAL_DELAY_HOURS,
  BASE_COST_BUFFER_PERCENT,
  L1_MESSAGE_SENT_TOPIC,
  zkSyncL1BridgeAbi,
  zkSyncL2BridgeAbi,
  zkSyncL2EthTokenAbi,
  zkSyncDiamondProxyAbi,
} from './constants';

const ETHEREUM_CHAIN_ID = 1;
const ZKSYNC_CHAIN_ID = 324;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

  async getMinimumAmount(_route: RebalanceRoute): Promise<string | null> {
    return null;
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === ZKSYNC_CHAIN_ID;
      const isL2ToL1 = route.origin === ZKSYNC_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;
      if (!isL1ToL2 && !isL2ToL1) {
        throw new Error(`Unsupported zkSync route: ${route.origin}->${route.destination}`);
      }

      const isETH = route.asset.toLowerCase() === ZERO_ADDRESS;
      const transactions: MemoizedTransactionRequest[] = [];

      const l2GasLimit = BigInt(2000000); // Must be sufficient for L2 execution; 200k causes ValidateTxnNotEnoughGas
      const l2GasPerPubdataByteLimit = BigInt(800);

      if (isL1ToL2) {
        const l1Client = await this.getClient(route.origin);

        // Query the L2 transaction base cost from the Diamond Proxy
        const gasPrice = await l1Client.getGasPrice();
        const baseCost = await l1Client.readContract({
          address: ZKSYNC_DIAMOND_PROXY as `0x${string}`,
          abi: zkSyncDiamondProxyAbi,
          functionName: 'l2TransactionBaseCost',
          args: [gasPrice, l2GasLimit, l2GasPerPubdataByteLimit],
        });

        // Add buffer to absorb gas price increases between query and tx inclusion.
        // Overpayment is refunded to _refundRecipient by the Diamond Proxy.
        const baseCostWithBuffer = baseCost + (baseCost * BASE_COST_BUFFER_PERCENT) / BigInt(100);

        this.logger.info('zkSync L2 transaction base cost', {
          gasPrice: gasPrice.toString(),
          baseCost: baseCost.toString(),
          baseCostWithBuffer: baseCostWithBuffer.toString(),
        });

        if (isETH) {
          // ETH deposits go through the Diamond Proxy via requestL2Transaction
          // msg.value = deposit amount + L2 base cost
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZKSYNC_DIAMOND_PROXY as `0x${string}`,
              data: encodeFunctionData({
                abi: zkSyncDiamondProxyAbi,
                functionName: 'requestL2Transaction',
                args: [
                  recipient as `0x${string}`,
                  BigInt(amount),
                  '0x',
                  l2GasLimit,
                  l2GasPerPubdataByteLimit,
                  [],
                  sender as `0x${string}`,
                ],
              }),
              value: BigInt(amount) + baseCostWithBuffer,
            },
          });
        } else {
          // ERC20 deposits go through the L1 Bridge via deposit
          const allowance = await l1Client.readContract({
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

          // msg.value = baseCost only (ERC20 amount is transferred via the bridge contract)
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
                  l2GasLimit,
                  l2GasPerPubdataByteLimit,
                  sender as `0x${string}`,
                ],
              }),
              value: baseCostWithBuffer,
            },
          });
        }
      } else {
        if (isETH) {
          // L2→L1 ETH: Call withdraw(address) on L2 ETH Token (0x800A) with msg.value
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ETH_TOKEN_L2 as `0x${string}`,
              data: encodeFunctionData({
                abi: zkSyncL2EthTokenAbi,
                functionName: 'withdraw',
                args: [recipient as `0x${string}`],
              }),
              value: BigInt(amount),
            },
          });
        } else {
          // L2→L1 ERC20: Call withdraw(address, address, uint256) on L2 Bridge
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZKSYNC_L2_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: zkSyncL2BridgeAbi,
                functionName: 'withdraw',
                args: [recipient as `0x${string}`, route.asset as `0x${string}`, BigInt(amount)],
              }),
              value: BigInt(0),
            },
          });
        }
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
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === ZKSYNC_CHAIN_ID;
      const isL2ToL1 = route.origin === ZKSYNC_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;
      if (!isL1ToL2 && !isL2ToL1) {
        throw new Error(`Unsupported zkSync route: ${route.origin}->${route.destination}`);
      }

      if (isL1ToL2) {
        return true;
      } else {
        // L2→L1: Check if batch containing the withdrawal has been executed on L1
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);
        const l2Client = await this.getClient(ZKSYNC_CHAIN_ID);

        // Get the batch number from the L2 receipt (l1BatchNumber is a zkSync-specific field)
        const rawReceipt = await this.getRawReceipt(l2Client, originTransaction.transactionHash);
        const l1BatchNumber = rawReceipt?.l1BatchNumber;
        if (l1BatchNumber == null) {
          this.logger.info('zkSync withdrawal: batch number not yet available', {
            txHash: originTransaction.transactionHash,
          });
          return false;
        }

        const batchNumber = BigInt(l1BatchNumber);

        // Check if the batch has been executed on L1
        const totalBatchesExecuted = await l1Client.readContract({
          address: ZKSYNC_DIAMOND_PROXY as `0x${string}`,
          abi: zkSyncDiamondProxyAbi,
          functionName: 'getTotalBatchesExecuted',
        });

        const isExecuted = batchNumber <= totalBatchesExecuted;

        this.logger.info('zkSync withdrawal batch finalization status', {
          txHash: originTransaction.transactionHash,
          batchNumber: batchNumber.toString(),
          totalBatchesExecuted: totalBatchesExecuted.toString(),
          isExecuted,
          requiredDelayHours: WITHDRAWAL_DELAY_HOURS,
        });

        return isExecuted;
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
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === ZKSYNC_CHAIN_ID;
      const isL2ToL1 = route.origin === ZKSYNC_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;
      if (!isL1ToL2 && !isL2ToL1) {
        throw new Error(`Unsupported zkSync route: ${route.origin}->${route.destination}`);
      }

      if (isL2ToL1) {
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);
        const l2Client = await this.getClient(ZKSYNC_CHAIN_ID);

        // Get the raw receipt to access zkSync-specific fields (l1BatchNumber, l1BatchTxIndex, l2ToL1Logs)
        const rawReceipt = await this.getRawReceipt(l2Client, originTransaction.transactionHash);
        if (rawReceipt?.l1BatchNumber == null || rawReceipt?.l1BatchTxIndex == null) {
          throw new Error('Batch number not available for withdrawal transaction');
        }

        const l1BatchNumber = BigInt(rawReceipt.l1BatchNumber);
        const l1BatchTxIndex = Number(rawReceipt.l1BatchTxIndex);
        const isETH = route.asset.toLowerCase() === ZERO_ADDRESS;

        // Find the l2ToL1Log index for this withdrawal
        const l2ToL1Logs = rawReceipt.l2ToL1Logs ?? [];
        const targetKey = isETH ? ETH_TOKEN_L2.toLowerCase() : ZKSYNC_L2_BRIDGE.toLowerCase();
        const l2ToL1LogIndex = l2ToL1Logs.findIndex(
          (log: { sender: string; key: string }) =>
            log.sender.toLowerCase() === L1_MESSENGER.toLowerCase() &&
            log.key.toLowerCase().endsWith(targetKey.slice(2)),
        );
        if (l2ToL1LogIndex === -1) {
          throw new Error(`No l2ToL1Log found for ${isETH ? 'ETH' : 'ERC20'} withdrawal`);
        }

        // Get the L2 to L1 log proof from zkSync RPC
        const proofData = await this.getL2ToL1LogProof(l2Client, originTransaction.transactionHash, l2ToL1LogIndex);
        if (!proofData) {
          throw new Error('Failed to get L2 to L1 log proof');
        }

        // proof.id is the message index within the batch Merkle tree
        const l2MessageIndex = proofData.id;

        if (isETH) {
          // ETH withdrawal: finalize via Diamond Proxy
          const isFinalized = await l1Client.readContract({
            address: ZKSYNC_DIAMOND_PROXY as `0x${string}`,
            abi: zkSyncDiamondProxyAbi,
            functionName: 'isEthWithdrawalFinalized',
            args: [l1BatchNumber, BigInt(l2MessageIndex)],
          });

          if (isFinalized) {
            this.logger.info('zkSync ETH withdrawal already finalized', {
              txHash: originTransaction.transactionHash,
              l1BatchNumber: l1BatchNumber.toString(),
              l2MessageIndex,
            });
            return;
          }

          // Extract the message from the L1MessageSent event log
          const message = this.extractL1Message(rawReceipt, targetKey);

          this.logger.info('Building zkSync ETH withdrawal finalization transaction', {
            withdrawalTxHash: originTransaction.transactionHash,
            l1BatchNumber: l1BatchNumber.toString(),
            l2MessageIndex,
            l2TxNumberInBatch: l1BatchTxIndex,
            messageLength: message.length,
          });

          return {
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZKSYNC_DIAMOND_PROXY as `0x${string}`,
              data: encodeFunctionData({
                abi: zkSyncDiamondProxyAbi,
                functionName: 'finalizeEthWithdrawal',
                args: [l1BatchNumber, BigInt(l2MessageIndex), l1BatchTxIndex, message, proofData.proof],
              }),
              value: BigInt(0),
            },
          };
        } else {
          // ERC20 withdrawal: finalize via L1 Bridge
          const isFinalized = await l1Client.readContract({
            address: ZKSYNC_L1_BRIDGE as `0x${string}`,
            abi: zkSyncL1BridgeAbi,
            functionName: 'isWithdrawalFinalized',
            args: [l1BatchNumber, BigInt(l2MessageIndex)],
          });

          if (isFinalized) {
            this.logger.info('zkSync ERC20 withdrawal already finalized', {
              txHash: originTransaction.transactionHash,
              l1BatchNumber: l1BatchNumber.toString(),
              l2MessageIndex,
            });
            return;
          }

          // Extract the message from the L1MessageSent event log
          const message = this.extractL1Message(rawReceipt, targetKey);

          this.logger.info('Building zkSync ERC20 withdrawal finalization transaction', {
            withdrawalTxHash: originTransaction.transactionHash,
            l1BatchNumber: l1BatchNumber.toString(),
            l2MessageIndex,
            l2TxNumberInBatch: l1BatchTxIndex,
          });

          return {
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZKSYNC_L1_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: zkSyncL1BridgeAbi,
                functionName: 'finalizeWithdrawal',
                args: [l1BatchNumber, BigInt(l2MessageIndex), l1BatchTxIndex, message, proofData.proof],
              }),
              value: BigInt(0),
            },
          };
        }
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

  /**
   * Get the raw transaction receipt from zkSync RPC, which includes zkSync-specific fields
   * like l1BatchNumber, l1BatchTxIndex, and l2ToL1Logs that viem may not expose.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getRawReceipt(l2Client: PublicClient, txHash: string): Promise<any | undefined> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (l2Client as any).request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      return result;
    } catch (error) {
      this.logger.warn('Failed to get raw receipt', {
        txHash,
        error: jsonifyError(error),
      });
      return undefined;
    }
  }

  private async getL2ToL1LogProof(
    l2Client: PublicClient,
    txHash: string,
    l2ToL1LogIndex: number,
  ): Promise<{ proof: `0x${string}`[]; id: number } | undefined> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (l2Client as any).request({
        method: 'zks_getL2ToL1LogProof',
        params: [txHash, l2ToL1LogIndex],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proofResult = result as any;
      if (!proofResult || !proofResult.proof) {
        return undefined;
      }

      return {
        proof: proofResult.proof as `0x${string}`[],
        id: proofResult.id ?? 0,
      };
    } catch (error) {
      this.logger.warn('Failed to get L2 to L1 log proof', {
        txHash,
        l2ToL1LogIndex,
        error: jsonifyError(error),
      });
      return undefined;
    }
  }

  /**
   * Extract the raw L1 message from the L1MessageSent event in the receipt logs.
   * The L1MessageSent event is emitted by the L1Messenger system contract (0x8008)
   * with the second topic matching the sender token address (0x800A for ETH, bridge for ERC20).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractL1Message(rawReceipt: any, senderKey: string): `0x${string}` {
    const logs = rawReceipt.logs ?? [];
    // Find L1MessageSent event from L1Messenger where topic[1] matches the sender key
    const paddedKey = pad(senderKey as `0x${string}`, { size: 32 }).toLowerCase();

    const messageSentLog = logs.find(
      (log: { address: string; topics: string[] }) =>
        log.address.toLowerCase() === L1_MESSENGER.toLowerCase() &&
        log.topics[0]?.toLowerCase() === L1_MESSAGE_SENT_TOPIC.toLowerCase() &&
        log.topics[1]?.toLowerCase() === paddedKey,
    );

    if (!messageSentLog) {
      throw new Error('L1MessageSent event not found in receipt logs');
    }

    // The data is ABI-encoded: bytes offset (32) + bytes length (32) + actual message bytes
    const data = messageSentLog.data as `0x${string}`;
    // Skip 0x prefix, then skip offset (64 hex chars) and length (64 hex chars)
    const lengthHex = data.slice(66, 130); // bytes 32-63 = length
    const length = parseInt(lengthHex, 16);
    const messageHex = data.slice(130, 130 + length * 2);
    return `0x${messageHex}` as `0x${string}`;
  }
}
