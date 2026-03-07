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
  LINEA_SDK_FALLBACK_L1_RPCS,
  LINEA_SDK_FALLBACK_L2_RPCS,
  lineaMessageServiceAbi,
  lineaTokenBridgeAbi,
} from './constants';
import { LineaSDK } from '@consensys/linea-sdk';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface LineaMessageInfo {
  messageHash: `0x${string}`;
  messageNumber: bigint;
  from: `0x${string}`;
  to: `0x${string}`;
  fee: bigint;
  value: bigint;
  calldata: `0x${string}`;
}

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
      const isL2ToL1 = route.origin === LINEA_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;
      if (!isL1ToL2 && !isL2ToL1) {
        throw new Error(`Unsupported Linea route: ${route.origin}->${route.destination}`);
      }
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
      const isL2ToL1 = route.origin === LINEA_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;
      if (!isL1ToL2 && !isL2ToL1) {
        throw new Error(`Unsupported Linea route: ${route.origin}->${route.destination}`);
      }

      if (isL1ToL2) {
        // L1→L2: Auto-claimed by Linea postman service
        return true;
      } else {
        // L2→L1: Ready when the L2 block's Merkle root has been anchored on L1,
        // which is when a proof can be constructed. This is typically 6-8 hours
        // after the L2 transaction, not a fixed 24-hour window.
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);

        const messageInfo = this.extractMessageInfo(originTransaction);
        if (!messageInfo) {
          this.logger.info('Linea withdrawal: no MessageSent event found', {
            txHash: originTransaction.transactionHash,
          });
          return false;
        }

        // Fast-path: already claimed on L1
        const isClaimed = await this.isMessageClaimed(l1Client, messageInfo.messageNumber);
        if (isClaimed) {
          this.logger.info('Linea withdrawal already claimed', {
            txHash: originTransaction.transactionHash,
            messageHash: messageInfo.messageHash,
          });
          return true;
        }

        // Check proof availability — proof only exists once the L2 block is anchored on L1
        const proofData = await this.fetchProofFromLineaSDK(messageInfo.messageHash, originTransaction.transactionHash);
        const isReady = proofData != null;

        this.logger.info('Linea withdrawal readiness check', {
          txHash: originTransaction.transactionHash,
          messageHash: messageInfo.messageHash,
          isReady,
        });

        return isReady;
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
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === LINEA_CHAIN_ID;
      const isL2ToL1 = route.origin === LINEA_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;
      if (!isL1ToL2 && !isL2ToL1) {
        throw new Error(`Unsupported Linea route: ${route.origin}->${route.destination}`);
      }

      if (isL2ToL1) {
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);

        // Extract message info from the origin transaction
        const messageInfo = this.extractMessageInfo(originTransaction);
        if (!messageInfo) {
          this.logger.warn('No MessageSent event found in transaction logs');
          return;
        }

        // Check if already claimed
        const isClaimed = await this.isMessageClaimed(l1Client, messageInfo.messageNumber);
        if (isClaimed) {
          this.logger.info('Linea withdrawal already claimed', {
            txHash: originTransaction.transactionHash,
            messageHash: messageInfo.messageHash,
          });
          return;
        }

        // Get the Merkle proof from the Linea SDK
        const proofResponse = await this.fetchProofFromLineaSDK(
          messageInfo.messageHash,
          originTransaction.transactionHash,
        );
        if (!proofResponse) {
          throw new Error('Failed to get message proof - L2 block may not be anchored on L1 yet');
        }

        this.logger.info('Building Linea claim transaction', {
          withdrawalTxHash: originTransaction.transactionHash,
          messageHash: messageInfo.messageHash,
        });

        return {
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: LINEA_L1_MESSAGE_SERVICE as `0x${string}`,
            data: encodeFunctionData({
              abi: lineaMessageServiceAbi,
              functionName: 'claimMessageWithProof',
              args: [
                {
                  proof: proofResponse.proof,
                  messageNumber: messageInfo.messageNumber,
                  leafIndex: proofResponse.leafIndex,
                  from: messageInfo.from,
                  to: messageInfo.to,
                  fee: messageInfo.fee,
                  value: messageInfo.value,
                  feeRecipient: this.extractFeeRecipient(messageInfo, originTransaction),
                  merkleRoot: proofResponse.root,
                  data: messageInfo.calldata,
                },
              ],
            }),
            value: BigInt(0),
          },
        };
      }
    } catch (error) {
      this.handleError(error, 'prepare destination callback', { route, originTransaction });
    }
  }

  private extractFeeRecipient(messageInfo: LineaMessageInfo, originTransaction: TransactionReceipt): `0x${string}` {
    // ETH transfer: messageInfo.from is Mark's address (Mark called sendMessage directly).
    if (messageInfo.from.toLowerCase() !== LINEA_L2_TOKEN_BRIDGE.toLowerCase()) {
      return messageInfo.from;
    }

    // ERC20 transfer: messageInfo.from is the L2 TokenBridge (it called sendMessage internally).
    // Extract Mark's actual address from the BridgingInitiated event's sender field.
    const bridgingLogs = parseEventLogs({ abi: lineaTokenBridgeAbi, logs: originTransaction.logs });
    const bridgingEvent = bridgingLogs.find((log) => log.eventName === 'BridgingInitiated');
    if (bridgingEvent) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (bridgingEvent as any).args.sender as `0x${string}`;
    }

    // Fallback: warn and use ZERO_ADDRESS (fee goes to msg.sender)
    this.logger.warn('BridgingInitiated event not found for ERC20 claim; feeRecipient defaults to msg.sender');
    return ZERO_ADDRESS as `0x${string}`;
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

  private extractMessageInfo(originTransaction: TransactionReceipt): LineaMessageInfo | undefined {
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
    return {
      messageHash: args._messageHash as `0x${string}`,
      messageNumber: args._nonce as bigint,
      from: args._from as `0x${string}`,
      to: args._to as `0x${string}`,
      fee: args._fee as bigint,
      value: args._value as bigint,
      calldata: args._calldata as `0x${string}`,
    };
  }

  private async isMessageClaimed(l1Client: PublicClient, messageNumber: bigint): Promise<boolean> {
    try {
      // Use the contract's isMessageClaimed(uint256 messageNumber) view function.
      // This is much more efficient than scanning event logs across thousands of blocks.
      return (await l1Client.readContract({
        address: LINEA_L1_MESSAGE_SERVICE as `0x${string}`,
        abi: lineaMessageServiceAbi,
        functionName: 'isMessageClaimed',
        args: [messageNumber],
      })) as boolean;
    } catch (error) {
      this.logger.warn('Failed to check if message is claimed', {
        messageNumber: messageNumber.toString(),
        error: jsonifyError(error),
      });
      return false;
    }
  }

  private async fetchProofFromLineaSDK(
    messageHash: `0x${string}`,
    txHash: string,
  ): Promise<{ proof: `0x${string}`[]; leafIndex: number; root: `0x${string}` } | undefined> {
    // The Linea SDK issues wide-range eth_getLogs on both L1 and L2.
    // Commercial free-tier providers (Alchemy, DRPC) reject block ranges >10k.
    // Try configured providers first, then fall back to public RPCs for both chains.
    const l1Candidates = [...(this.chains[ETHEREUM_CHAIN_ID.toString()]?.providers ?? []), ...LINEA_SDK_FALLBACK_L1_RPCS];
    const l2Candidates = [...(this.chains[LINEA_CHAIN_ID.toString()]?.providers ?? []), ...LINEA_SDK_FALLBACK_L2_RPCS];

    if (l2Candidates.length === 0) {
      this.logger.warn('No L2 providers available for Linea SDK');
      return undefined;
    }

    // Outer loop: L2 RPC (most likely bottleneck — L2 getLogs for message tree).
    // Inner loop: L1 RPC (required for anchored root lookup).
    for (const l2RpcUrl of l2Candidates) {
      for (const l1RpcUrl of l1Candidates) {
        try {
          const sdk = new LineaSDK({
            l1RpcUrl,
            l2RpcUrl,
            network: 'linea-mainnet',
            mode: 'read-only',
          });

          const l1ClaimingService = sdk.getL1ClaimingService(LINEA_L1_MESSAGE_SERVICE);
          const proofResult = await l1ClaimingService.getMessageProof(messageHash);

          if (!proofResult) {
            this.logger.info('Message proof not yet available from Linea SDK', { messageHash, txHash });
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
            l1RpcUrl: l1RpcUrl.replace(/\/[^/]*$/, '/***'),
            l2RpcUrl: l2RpcUrl.replace(/\/[^/]*$/, '/***'),
            error: jsonifyError(error),
          });
        }
      }
    }

    this.logger.warn('All providers failed for Linea SDK proof fetching', { messageHash });
    return undefined;
  }
}
