import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  erc20Abi,
  PublicClient,
  fallback,
  parseEventLogs,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
} from 'viem';
import { buildProveZircuitWithdrawal } from '@zircuit/zircuit-viem/op-stack';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { SupportedBridge, ChainConfiguration, ILogger } from '@mark/core';
import { jsonifyError } from '@mark/logger';
import type { RebalanceRoute } from '@mark/core';
import { getDestinationAssetAddress } from '../../shared/asset';
import {
  ZIRCUIT_L1_STANDARD_BRIDGE,
  ZIRCUIT_L2_STANDARD_BRIDGE,
  ZIRCUIT_OPTIMISM_PORTAL,
  ZIRCUIT_L2_OUTPUT_ORACLE,
  ETHEREUM_CHAIN_ID,
  ZIRCUIT_CHAIN_ID,
  CHALLENGE_PERIOD_SECONDS,
  zircuitL1StandardBridgeAbi,
  zircuitL2StandardBridgeAbi,
  zircuitOptimismPortalAbi,
  zircuitL2OutputOracleAbi,
  zircuitL2ToL1MessagePasserAbi,
  ZERO_ADDRESS,
} from './constants';

interface WithdrawalTransaction {
  nonce: bigint;
  sender: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  gasLimit: bigint;
  data: `0x${string}`;
}

interface OutputRootProof {
  version: `0x${string}`;
  stateRoot: `0x${string}`;
  messagePasserStorageRoot: `0x${string}`;
  latestBlockhash: `0x${string}`;
}

export class ZircuitNativeBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: ILogger,
  ) {}

  type(): SupportedBridge {
    return SupportedBridge.Zircuit;
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      // No bridge fees for native bridge transfers
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
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === ZIRCUIT_CHAIN_ID;
      const isETH = route.asset.toLowerCase() === ZERO_ADDRESS;
      const transactions: MemoizedTransactionRequest[] = [];

      const minGasLimit = 2000000; // Must be sufficient for L2 cross-chain execution

      if (isL1ToL2) {
        if (isETH) {
          // L1→L2 ETH: Use bridgeETHTo
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZIRCUIT_L1_STANDARD_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: zircuitL1StandardBridgeAbi,
                functionName: 'bridgeETHTo',
                args: [recipient as `0x${string}`, minGasLimit, '0x'],
              }),
              value: BigInt(amount),
            },
          });
        } else {
          // L1→L2 ERC20: Use bridgeERC20To
          const client = await this.getClient(route.origin);
          const allowance = await client.readContract({
            address: route.asset as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender as `0x${string}`, ZIRCUIT_L1_STANDARD_BRIDGE as `0x${string}`],
          });

          if (allowance < BigInt(amount)) {
            transactions.push({
              memo: RebalanceTransactionMemo.Approval,
              transaction: {
                to: route.asset as `0x${string}`,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [ZIRCUIT_L1_STANDARD_BRIDGE as `0x${string}`, BigInt(amount)],
                }),
                value: BigInt(0),
              },
            });
          }

          // Resolve the L2 token address via tickerHash mapping
          const l2Token = getDestinationAssetAddress(
            route.asset,
            route.origin,
            route.destination,
            this.chains,
            this.logger,
          );
          if (!l2Token) {
            throw new Error(`No L2 token mapping found for ${route.asset} on chain ${route.destination}`);
          }

          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZIRCUIT_L1_STANDARD_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: zircuitL1StandardBridgeAbi,
                functionName: 'bridgeERC20To',
                args: [
                  route.asset as `0x${string}`,
                  l2Token as `0x${string}`,
                  recipient as `0x${string}`,
                  BigInt(amount),
                  minGasLimit,
                  '0x',
                ],
              }),
              value: BigInt(0),
            },
          });
        }
      } else {
        // L2→L1
        if (isETH) {
          // L2→L1 ETH: Use bridgeETHTo
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZIRCUIT_L2_STANDARD_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: zircuitL2StandardBridgeAbi,
                functionName: 'bridgeETHTo',
                args: [recipient as `0x${string}`, minGasLimit, '0x'],
              }),
              value: BigInt(amount),
            },
          });
        } else {
          // L2→L1 ERC20: Use bridgeERC20To
          const client = await this.getClient(route.origin);
          const allowance = await client.readContract({
            address: route.asset as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender as `0x${string}`, ZIRCUIT_L2_STANDARD_BRIDGE as `0x${string}`],
          });

          if (allowance < BigInt(amount)) {
            transactions.push({
              memo: RebalanceTransactionMemo.Approval,
              transaction: {
                to: route.asset as `0x${string}`,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [ZIRCUIT_L2_STANDARD_BRIDGE as `0x${string}`, BigInt(amount)],
                }),
                value: BigInt(0),
              },
            });
          }

          // Resolve the L1 token address via tickerHash mapping
          const l1Token = getDestinationAssetAddress(
            route.asset,
            route.origin,
            route.destination,
            this.chains,
            this.logger,
          );
          if (!l1Token) {
            throw new Error(`No L1 token mapping found for ${route.asset} on chain ${route.destination}`);
          }

          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZIRCUIT_L2_STANDARD_BRIDGE as `0x${string}`,
              data: encodeFunctionData({
                abi: zircuitL2StandardBridgeAbi,
                functionName: 'bridgeERC20To',
                args: [
                  route.asset as `0x${string}`,
                  l1Token as `0x${string}`,
                  recipient as `0x${string}`,
                  BigInt(amount),
                  minGasLimit,
                  '0x',
                ],
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
      const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === ZIRCUIT_CHAIN_ID;

      if (isL1ToL2) {
        // L1→L2: Auto-relayed by the sequencer
        return true;
      } else {
        // L2→L1: Check withdrawal status (prove + finalize phases)
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);
        const l2Client = await this.getClient(ZIRCUIT_CHAIN_ID);

        // Extract withdrawal info from the transaction
        const withdrawalTx = await this.extractWithdrawalTransaction(l2Client, originTransaction);
        if (!withdrawalTx) {
          this.logger.info('Could not extract withdrawal transaction', {
            txHash: originTransaction.transactionHash,
          });
          return false;
        }

        const withdrawalHash = this.hashWithdrawal(withdrawalTx);

        // Check if withdrawal is already finalized
        const isFinalized = await l1Client.readContract({
          address: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
          abi: zircuitOptimismPortalAbi,
          functionName: 'finalizedWithdrawals',
          args: [withdrawalHash],
        });

        if (isFinalized) {
          this.logger.info('Zircuit withdrawal already finalized', {
            txHash: originTransaction.transactionHash,
            withdrawalHash,
          });
          return true;
        }

        // Check if withdrawal is proven
        const provenWithdrawal = await l1Client.readContract({
          address: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
          abi: zircuitOptimismPortalAbi,
          functionName: 'provenWithdrawals',
          args: [withdrawalHash],
        });

        const [, timestamp] = provenWithdrawal as [`0x${string}`, bigint, bigint];

        if (timestamp > 0) {
          // Withdrawal is proven, check if challenge period has passed
          const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
          const canFinalize = currentTimestamp >= timestamp + BigInt(CHALLENGE_PERIOD_SECONDS);

          this.logger.info('Zircuit withdrawal proven status', {
            txHash: originTransaction.transactionHash,
            withdrawalHash,
            provenTimestamp: timestamp.toString(),
            currentTimestamp: currentTimestamp.toString(),
            challengePeriodSeconds: CHALLENGE_PERIOD_SECONDS,
            canFinalize,
          });

          return canFinalize;
        }

        // Withdrawal not yet proven - check if L2 output is available
        const l2BlockNumber = originTransaction.blockNumber;
        try {
          const l2OutputIdx = await l1Client.readContract({
            address: ZIRCUIT_L2_OUTPUT_ORACLE as `0x${string}`,
            abi: zircuitL2OutputOracleAbi,
            functionName: 'getL2OutputIndexAfter',
            args: [l2BlockNumber],
          });

          this.logger.info('Zircuit withdrawal ready to prove', {
            txHash: originTransaction.transactionHash,
            l2BlockNumber: l2BlockNumber.toString(),
            l2OutputIndex: l2OutputIdx.toString(),
          });

          // L2 output is available, withdrawal can be proven
          return true;
        } catch {
          // L2 output not yet available
          this.logger.info('Zircuit withdrawal: L2 output not yet available', {
            txHash: originTransaction.transactionHash,
            l2BlockNumber: l2BlockNumber.toString(),
          });
          return false;
        }
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
      const isL2ToL1 = route.origin === ZIRCUIT_CHAIN_ID && route.destination === ETHEREUM_CHAIN_ID;

      if (isL2ToL1) {
        const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);
        const l2Client = await this.getClient(ZIRCUIT_CHAIN_ID);

        // Extract withdrawal info from the transaction
        const withdrawalTx = await this.extractWithdrawalTransaction(l2Client, originTransaction);
        if (!withdrawalTx) {
          this.logger.warn('Could not extract withdrawal transaction');
          return;
        }

        const withdrawalHash = this.hashWithdrawal(withdrawalTx);

        // Check if withdrawal is already finalized
        const isFinalized = await l1Client.readContract({
          address: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
          abi: zircuitOptimismPortalAbi,
          functionName: 'finalizedWithdrawals',
          args: [withdrawalHash],
        });

        if (isFinalized) {
          this.logger.info('Zircuit withdrawal already finalized', {
            txHash: originTransaction.transactionHash,
            withdrawalHash,
          });
          return;
        }

        // Check if withdrawal is proven
        const provenWithdrawal = await l1Client.readContract({
          address: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
          abi: zircuitOptimismPortalAbi,
          functionName: 'provenWithdrawals',
          args: [withdrawalHash],
        });

        const [, timestamp] = provenWithdrawal as [`0x${string}`, bigint, bigint];

        if (timestamp > 0) {
          // Withdrawal is proven, check if we can finalize
          const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
          const canFinalize = currentTimestamp >= timestamp + BigInt(CHALLENGE_PERIOD_SECONDS);

          if (!canFinalize) {
            this.logger.info('Zircuit withdrawal: challenge period not yet passed', {
              txHash: originTransaction.transactionHash,
              withdrawalHash,
              provenTimestamp: timestamp.toString(),
              currentTimestamp: currentTimestamp.toString(),
              remainingSeconds: (timestamp + BigInt(CHALLENGE_PERIOD_SECONDS) - currentTimestamp).toString(),
            });
            return;
          }

          // Finalize the withdrawal
          this.logger.info('Building Zircuit finalize withdrawal transaction', {
            withdrawalTxHash: originTransaction.transactionHash,
            withdrawalHash,
          });

          return {
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
              data: encodeFunctionData({
                abi: zircuitOptimismPortalAbi,
                functionName: 'finalizeWithdrawalTransaction',
                args: [withdrawalTx],
              }),
              value: BigInt(0),
            },
          };
        } else {
          // Withdrawal not yet proven - need to prove first
          // Use @zircuit/zircuit-viem which handles both legacy (v1) and new (v2) proof formats.
          // Zircuit v2 uses a custom Merkle tree for withdrawal proofs instead of standard eth_getProof.
          const proofResult = await this.buildZircuitProof(l2Client, l1Client, originTransaction);
          if (!proofResult) {
            throw new Error('Failed to get withdrawal proof');
          }

          this.logger.info('Building Zircuit prove withdrawal transaction', {
            withdrawalTxHash: originTransaction.transactionHash,
            withdrawalHash,
            l2OutputIndex: proofResult.l2OutputIndex.toString(),
          });

          return {
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
              data: encodeFunctionData({
                abi: zircuitOptimismPortalAbi,
                functionName: 'proveWithdrawalTransaction',
                args: [
                  withdrawalTx,
                  proofResult.l2OutputIndex,
                  proofResult.outputRootProof,
                  proofResult.withdrawalProof,
                ],
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

  async isCallbackComplete(route: RebalanceRoute, originTransaction: TransactionReceipt): Promise<boolean> {
    const isL1ToL2 = route.origin === ETHEREUM_CHAIN_ID && route.destination === ZIRCUIT_CHAIN_ID;
    if (isL1ToL2) {
      return true;
    }

    // L2→L1: complete only when finalized
    const l1Client = await this.getClient(ETHEREUM_CHAIN_ID);
    const l2Client = await this.getClient(ZIRCUIT_CHAIN_ID);

    const withdrawalTx = await this.extractWithdrawalTransaction(l2Client, originTransaction);
    if (!withdrawalTx) {
      // Cannot determine state — treat as complete to avoid stuck entries
      return true;
    }

    const withdrawalHash = this.hashWithdrawal(withdrawalTx);
    const isFinalized = await l1Client.readContract({
      address: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
      abi: zircuitOptimismPortalAbi,
      functionName: 'finalizedWithdrawals',
      args: [withdrawalHash],
    });

    this.logger.info('Zircuit isCallbackComplete check', {
      txHash: originTransaction.transactionHash,
      withdrawalHash,
      isFinalized,
    });

    return isFinalized as boolean;
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

  private async extractWithdrawalTransaction(
    l2Client: PublicClient,
    originTransaction: TransactionReceipt,
  ): Promise<WithdrawalTransaction | undefined> {
    try {
      const logs = parseEventLogs({
        abi: zircuitL2ToL1MessagePasserAbi,
        logs: originTransaction.logs,
      });

      const messagePassedEvent = logs.find((log) => log.eventName === 'MessagePassed');
      if (!messagePassedEvent) {
        return undefined;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (messagePassedEvent as any).args;

      return {
        nonce: args.nonce,
        sender: args.sender,
        target: args.target,
        value: args.value,
        gasLimit: args.gasLimit,
        data: args.data,
      };
    } catch (error) {
      this.logger.warn('Failed to extract withdrawal transaction', {
        txHash: originTransaction.transactionHash,
        error: jsonifyError(error),
      });
      return undefined;
    }
  }

  private hashWithdrawal(tx: WithdrawalTransaction): `0x${string}` {
    return keccak256(
      encodeAbiParameters(parseAbiParameters('uint256, address, address, uint256, uint256, bytes'), [
        tx.nonce,
        tx.sender,
        tx.target,
        tx.value,
        tx.gasLimit,
        tx.data,
      ]),
    );
  }

  /**
   * Builds the withdrawal proof using @zircuit/zircuit-viem.
   * Zircuit uses two proof versions:
   * - v1 (legacy): Standard Optimism eth_getProof-based proofs
   * - v2 (current): Custom Merkle tree built from MessagePassed events
   * The library handles version detection and proof construction automatically.
   */
  private async buildZircuitProof(
    l2Client: PublicClient,
    l1Client: PublicClient,
    originTransaction: TransactionReceipt,
  ): Promise<
    | {
        l2OutputIndex: bigint;
        outputRootProof: OutputRootProof;
        withdrawalProof: `0x${string}`[];
      }
    | undefined
  > {
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any -- @zircuit/zircuit-viem expects its own Client type incompatible with viem's PublicClient */
      const result = await buildProveZircuitWithdrawal(
        l2Client as any,
        {
          receipt: originTransaction,
          l1Client: l1Client as any,
          l2OutputOracleAddress: ZIRCUIT_L2_OUTPUT_ORACLE as `0x${string}`,
        } as any,
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */

      this.logger.info('Zircuit proof built successfully', {
        txHash: originTransaction.transactionHash,
        l2OutputIndex: (result.l2OutputIndex as bigint).toString(),
        outputRootVersion: result.outputRootProof.version,
        stateRoot: result.outputRootProof.stateRoot,
        messagePasserStorageRoot: result.outputRootProof.messagePasserStorageRoot,
        latestBlockhash: result.outputRootProof.latestBlockhash,
        withdrawalProofLength: result.withdrawalProof.length,
      });

      return {
        l2OutputIndex: result.l2OutputIndex as bigint,
        outputRootProof: result.outputRootProof as OutputRootProof,
        withdrawalProof: result.withdrawalProof as `0x${string}`[],
      };
    } catch (error) {
      this.logger.warn('Failed to build Zircuit withdrawal proof', {
        txHash: originTransaction.transactionHash,
        error: jsonifyError(error),
      });
      return undefined;
    }
  }
}
