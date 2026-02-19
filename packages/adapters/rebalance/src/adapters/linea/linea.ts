import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  erc20Abi,
  PublicClient,
  fallback,
  parseEventLogs,
} from 'viem';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { SupportedBridge, ChainConfiguration, ILogger } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import type { RebalanceRoute } from '@mark/core';
import {
  LINEA_L1_MESSAGE_SERVICE,
  LINEA_L2_MESSAGE_SERVICE,
  LINEA_L1_TOKEN_BRIDGE,
  LINEA_L2_TOKEN_BRIDGE,
  ETHEREUM_CHAIN_ID,
  LINEA_CHAIN_ID,
  L2_TO_L1_FEE,
  FINALITY_WINDOW_SECONDS,
  LINEA_SDK_FALLBACK_L1_RPCS,
  LINEA_L1_MESSAGE_SERVICE_DEPLOY_BLOCK,
  lineaMessageServiceAbi,
  lineaTokenBridgeAbi,
} from './constants';
import { LineaSDK } from '@consensys/linea-sdk';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export class LineaNativeBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: ILogger,
  ) {}

  type(): SupportedBridge {
    return SupportedBridge.Linea;
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      // L2→L1 has an anti-DDoS fee
      const isL2ToL1 = route.origin === LINEA_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;
      const isETH = route.asset.toLowerCase() === ZERO_ADDRESS;

      if (isL2ToL1 && isETH) {
        // Deduct the L2→L1 fee from ETH transfers
        const amountBigInt = BigInt(amount);
        const receivedAmount = amountBigInt > L2_TO_L1_FEE ? amountBigInt - L2_TO_L1_FEE : BigInt(0);
        return receivedAmount.toString();
      }

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
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === LINEA_CHAIN_ID;
      const isETH = route.asset.toLowerCase() === ZERO_ADDRESS;
      const transactions: MemoizedTransactionRequest[] = [];

      if (isL1ToL2) {
        if (isETH) {
          // L1→L2 ETH: Use MessageService.sendMessage
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: LINEA_L1_MESSAGE_SERVICE as `0x${string}`,
              data: encodeFunctionData({
                abi: lineaMessageServiceAbi,
                functionName: 'sendMessage',
                args: [
                  recipient as `0x${string}`,
                  BigInt(0), // fee paid by value
                  '0x', // empty calldata for simple ETH transfer
                ],
              }),
              value: BigInt(amount),
            },
          });
        } else {
          // L1→L2 ERC20: Use TokenBridge
          const client = await this.getClient(route.origin);
          const allowance = await client.readContract({
            address: route.asset as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender as `0x${string}`, LINEA_L1_TOKEN_BRIDGE as `0x${string}`],
          });

          if (allowance < BigInt(amount)) {
            transactions.push({
              memo: RebalanceTransactionMemo.Approval,
              transaction: {
                to: route.asset as `0x${string}`,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [LINEA_L1_TOKEN_BRIDGE as `0x${string}`, BigInt(amount)],
                }),
                value: BigInt(0),
              },
            });
          }

          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: LINEA_L1_TOKEN_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: lineaTokenBridgeAbi,
                functionName: 'bridgeToken',
                args: [route.asset as `0x${string}`, BigInt(amount), recipient as `0x${string}`],
              }),
              value: BigInt(0),
            },
          });
        }
      } else {
        // L2→L1
        if (isETH) {
          // L2→L1 ETH: Use MessageService.sendMessage with fee
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: LINEA_L2_MESSAGE_SERVICE as `0x${string}`,
              data: encodeFunctionData({
                abi: lineaMessageServiceAbi,
                functionName: 'sendMessage',
                args: [
                  recipient as `0x${string}`,
                  L2_TO_L1_FEE, // anti-DDoS fee
                  '0x', // empty calldata for simple ETH transfer
                ],
              }),
              value: BigInt(amount),
            },
          });
        } else {
          // L2→L1 ERC20: Use TokenBridge
          const client = await this.getClient(route.origin);
          const allowance = await client.readContract({
            address: route.asset as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender as `0x${string}`, LINEA_L2_TOKEN_BRIDGE as `0x${string}`],
          });

          if (allowance < BigInt(amount)) {
            transactions.push({
              memo: RebalanceTransactionMemo.Approval,
              transaction: {
                to: route.asset as `0x${string}`,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [LINEA_L2_TOKEN_BRIDGE as `0x${string}`, BigInt(amount)],
                }),
                value: BigInt(0),
              },
            });
          }

          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: LINEA_L2_TOKEN_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: lineaTokenBridgeAbi,
                functionName: 'bridgeToken',
                args: [route.asset as `0x${string}`, BigInt(amount), recipient as `0x${string}`],
              }),
              // L2→L1 requires fee payment for anti-DDoS
              value: L2_TO_L1_FEE,
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
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === LINEA_CHAIN_ID;

      if (isL1ToL2) {
        // L1→L2: Auto-claimed by Linea postman service
        // Check if enough time has passed (usually 15-30 minutes)
        return true;
      } else {
        // L2→L1: Requires 24-hour finality window
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);

        // Get the origin transaction timestamp
        const l2Client = await this.getClient(LINEA_CHAIN_ID);
        const block = await l2Client.getBlock({ blockNumber: originTransaction.blockNumber });
        const txTimestamp = Number(block.timestamp);
        const currentTimestamp = Math.floor(Date.now() / 1000);

        const timeElapsed = currentTimestamp - txTimestamp;
        const isFinalized = timeElapsed >= FINALITY_WINDOW_SECONDS;

        this.logger.info('Linea withdrawal finality check', {
          txHash: originTransaction.transactionHash,
          txTimestamp,
          currentTimestamp,
          timeElapsed,
          requiredSeconds: FINALITY_WINDOW_SECONDS,
          isFinalized,
        });

        if (!isFinalized) {
          return false;
        }

        // Check if the message has been claimed
        const messageHash = this.extractMessageHash(originTransaction);
        if (messageHash) {
          const isClaimed = await this.isMessageClaimed(l1Client, messageHash);
          if (isClaimed) {
            this.logger.info('Linea withdrawal already claimed', {
              txHash: originTransaction.transactionHash,
              messageHash,
            });
            return true;
          }
        }

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
      const isL2ToL1 = route.origin === LINEA_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;

      if (isL2ToL1) {
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);

        // Extract message hash from the origin transaction
        const messageHash = this.extractMessageHash(originTransaction);
        if (!messageHash) {
          this.logger.warn('No MessageSent event found in transaction logs');
          return;
        }

        // Check if already claimed
        const isClaimed = await this.isMessageClaimed(l1Client, messageHash);
        if (isClaimed) {
          this.logger.info('Linea withdrawal already claimed', {
            txHash: originTransaction.transactionHash,
            messageHash,
          });
          return;
        }

        // Get the message proof from Linea SDK/API
        const proofData = await this.getMessageProof(originTransaction);
        if (!proofData) {
          this.logger.info('Linea message proof not available yet; will retry callback later', {
            txHash: originTransaction.transactionHash,
            messageHash,
          });
          return;
        }

        this.logger.info('Building Linea claim transaction', {
          withdrawalTxHash: originTransaction.transactionHash,
          messageHash,
        });

        return {
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: LINEA_L1_MESSAGE_SERVICE as `0x${string}`,
            data: encodeFunctionData({
              abi: lineaMessageServiceAbi,
              functionName: 'claimMessageWithProof',
              args: [proofData],
            }),
            value: BigInt(0),
          },
        };
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

  private extractMessageHash(originTransaction: TransactionReceipt): `0x${string}` | undefined {
    const logs = parseEventLogs({
      abi: lineaMessageServiceAbi,
      logs: originTransaction.logs,
    });

    const messageSentEvent = logs.find((log) => log.eventName === 'MessageSent');
    if (!messageSentEvent) {
      return undefined;
    }

    // The message hash is the third indexed topic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (messageSentEvent as any).args._messageHash as `0x${string}`;
  }

  private async isMessageClaimed(l1Client: PublicClient, messageHash: `0x${string}`): Promise<boolean> {
    try {
      // Check for MessageClaimed event with this hash
      const logs = await l1Client.getLogs({
        address: LINEA_L1_MESSAGE_SERVICE as `0x${string}`,
        event: {
          type: 'event',
          name: 'MessageClaimed',
          inputs: [{ type: 'bytes32', name: '_messageHash', indexed: true }],
        },
        args: {
          _messageHash: messageHash,
        },
        fromBlock: LINEA_L1_MESSAGE_SERVICE_DEPLOY_BLOCK,
        toBlock: 'latest',
      });

      return logs.length > 0;
    } catch (error) {
      this.logger.warn('Failed to check if message is claimed', {
        messageHash,
        error: jsonifyError(error),
      });
      return false;
    }
  }

  private async getMessageProof(originTransaction: TransactionReceipt): Promise<
    | {
        proof: `0x${string}`[];
        messageNumber: bigint;
        leafIndex: number;
        from: `0x${string}`;
        to: `0x${string}`;
        fee: bigint;
        value: bigint;
        feeRecipient: `0x${string}`;
        merkleRoot: `0x${string}`;
        data: `0x${string}`;
      }
    | undefined
  > {
    try {
      // Extract message details from the transaction logs
      const logs = parseEventLogs({
        abi: lineaMessageServiceAbi,
        logs: originTransaction.logs,
      });

      const messageSentEvent = logs.find((log) => log.eventName === 'MessageSent');
      if (!messageSentEvent) {
        return undefined;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (messageSentEvent as any).args;

      // Get proof from Linea SDK
      const messageHash = args._messageHash as `0x${string}`;
      const proofResponse = await this.fetchProofFromLineaSDK(messageHash, originTransaction);

      if (!proofResponse) {
        this.logger.warn('Could not fetch proof from Linea SDK - message may not be finalized yet');
        return undefined;
      }

      return {
        proof: proofResponse.proof,
        messageNumber: args._nonce,
        leafIndex: proofResponse.leafIndex,
        from: args._from,
        to: args._to,
        fee: args._fee,
        value: args._value,
        feeRecipient: args._from, // Fee recipient is typically the sender
        merkleRoot: proofResponse.root,
        data: args._calldata,
      };
    } catch (error) {
      this.logger.warn('Failed to get message proof', {
        txHash: originTransaction.transactionHash,
        error: jsonifyError(error),
      });
      return undefined;
    }
  }

  private async fetchProofFromLineaSDK(
    messageHash: `0x${string}`,
    originTransaction: TransactionReceipt,
  ): Promise<{ proof: `0x${string}`[]; leafIndex: number; root: `0x${string}` } | undefined> {
    const l2Providers = this.chains[LINEA_CHAIN_ID.toString()]?.providers ?? [];
    if (l2Providers.length === 0) {
      this.logger.warn('Missing L2 provider configuration for Linea SDK');
      return undefined;
    }

    // The Linea SDK queries eth_getLogs from block 0 to latest on L1,
    // which commercial providers like Alchemy reject due to block range limits.
    // Use configured L1 providers first, then fall back to public RPCs.
    const l1Providers = this.chains[ETHEREUM_CHAIN_ID.toString()]?.providers ?? [];
    const l1RpcCandidates = [...l1Providers, ...LINEA_SDK_FALLBACK_L1_RPCS];

    for (const l1RpcUrl of l1RpcCandidates) {
      try {
        const sdk = new LineaSDK({
          l1RpcUrl,
          l2RpcUrl: l2Providers[0],
          network: 'linea-mainnet',
          mode: 'read-only',
        });

        const l1ClaimingService = sdk.getL1ClaimingService(LINEA_L1_MESSAGE_SERVICE);
        const proofResult = await l1ClaimingService.getMessageProof(messageHash);

        if (!proofResult) {
          this.logger.info('Message proof not yet available from Linea SDK', {
            messageHash,
            txHash: originTransaction.transactionHash,
          });
          return undefined;
        }

        return {
          proof: proofResult.proof as `0x${string}`[],
          leafIndex: proofResult.leafIndex,
          root: proofResult.root as `0x${string}`,
        };
      } catch (error) {
        this.logger.warn('Failed to fetch proof from Linea SDK, trying next provider', {
          messageHash,
          l1RpcUrl: l1RpcUrl.replace(/\/[^/]*$/, '/***'), // mask API key in URL
          error: jsonifyError(error),
        });
      }
    }

    this.logger.warn('All L1 providers failed for Linea SDK proof fetching', { messageHash });
    return undefined;
  }
}
