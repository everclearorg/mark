import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  erc20Abi,
  fallback,
  type PublicClient,
  pad,
  decodeEventLog,
} from 'viem';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, axiosGet, MAINNET_CHAIN_ID } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { STARGATE_OFT_ABI } from '../stargate/abi';
import {
  StargateSendParam,
  StargateMessagingFee,
  LzMessageStatus,
  LzScanMessageResponse,
  tonAddressToBytes32,
} from '../stargate/types';
import { USDT0_LEGACY_MESH_ETH, USDT_ETH, USDT0_LZ_ENDPOINT_TON, USDT0_LEGACY_MESH_FEE_BPS } from './types';

// LayerZero Scan API base URL (same as Stargate — both use LayerZero)
const LZ_SCAN_API_URL = 'https://scan.layerzero-api.com';

/**
 * USDT0 Bridge Adapter for bridging USDT via Tether's USDT0 Legacy Mesh
 *
 * This adapter serves as a fallback for the Stargate adapter when Stargate
 * has no liquidity for the ETH → TON USDT route. It uses the same LayerZero
 * OFT interface (identical ABI) and delivery tracking (LayerZero Scan API).
 *
 * Reference:
 * - USDT0 Docs: https://docs.usdt0.to/
 * - Legacy Mesh: https://docs.usdt0.to/overview/the-legacy-mesh
 */
export class Usdt0BridgeAdapter implements BridgeAdapter {
  private readonly publicClients = new Map<number, PublicClient>();

  constructor(
    private readonly chains: Record<string, ChainConfiguration>,
    private readonly logger: Logger,
  ) {
    this.logger.debug('Initializing Usdt0BridgeAdapter (Legacy Mesh)', {
      contract: USDT0_LEGACY_MESH_ETH,
      tonEndpointId: USDT0_LZ_ENDPOINT_TON,
    });
  }

  type(): SupportedBridge {
    return SupportedBridge.Usdt0;
  }

  /**
   * Get the expected amount received after bridging via USDT0 Legacy Mesh
   *
   * Uses the known fixed Legacy Mesh fee of 0.03% (3 basis points).
   * Note: The fixed fee is reliable and documented at https://docs.usdt0.to/overview/the-legacy-mesh.
   * 
   */
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    const logContext = { amount, origin: route.origin, destination: route.destination };

    const estimatedReceived = BigInt(amount) - (BigInt(amount) * USDT0_LEGACY_MESH_FEE_BPS) / 10000n;

    this.logger.debug('USDT0 received amount (fixed 0.03% Legacy Mesh fee)', {
      ...logContext,
      estimatedReceived: estimatedReceived.toString(),
      feeBps: USDT0_LEGACY_MESH_FEE_BPS.toString(),
    });

    return estimatedReceived.toString();
  }

  /**
   * Returns null — defer minimum amount to the caller's config
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getMinimumAmount(route: RebalanceRoute): Promise<string | null> {
    return null;
  }

  /**
   * Build transactions to bridge USDT from Ethereum to TON via USDT0 Legacy Mesh
   *
   * Flow:
   * 1. Approve USDT to Legacy Mesh OFT contract (with USDT zero-allowance workaround)
   * 2. Call send() on the Legacy Mesh OFT contract
   *
   * The OFT contract locks USDT on Ethereum, routes through Arbitrum hub,
   * and the TON Legacy Mesh pool releases canonical USDT to the recipient.
   */
  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    const logContext = { sender, recipient, amount, origin: route.origin, destination: route.destination };

    try {
      const client = this.getPublicClient(route.origin);

      // Convert recipient to bytes32 (handles TON address formats)
      let recipientBytes32: `0x${string}`;
      if (recipient.startsWith('0x')) {
        recipientBytes32 = pad(recipient as `0x${string}`, { size: 32 });
      } else {
        recipientBytes32 = tonAddressToBytes32(recipient);
      }

      this.logger.debug('USDT0 encoding recipient address', {
        ...logContext,
        recipientBytes32,
        isTonAddress: !recipient.startsWith('0x'),
      });

      // Calculate minimum amount with slippage (0.5%)
      const slippageBps = 50n;
      const minAmount = (BigInt(amount) * (10000n - slippageBps)) / 10000n;

      // Build SendParam for the OFT contract
      const sendParam: StargateSendParam = {
        dstEid: USDT0_LZ_ENDPOINT_TON,
        to: recipientBytes32,
        amountLD: BigInt(amount),
        minAmountLD: minAmount,
        extraOptions: '0x' as `0x${string}`,
        composeMsg: '0x' as `0x${string}`,
        oftCmd: '0x' as `0x${string}`,
      };

      // Get messaging fee quote
      const fee = (await client.readContract({
        address: USDT0_LEGACY_MESH_ETH,
        abi: STARGATE_OFT_ABI,
        functionName: 'quoteSend',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: [sendParam, false] as any,
      })) as { nativeFee: bigint; lzTokenFee: bigint };

      this.logger.debug('USDT0 messaging fee quoted', {
        ...logContext,
        nativeFee: fee.nativeFee.toString(),
        lzTokenFee: fee.lzTokenFee.toString(),
      });

      const transactions: MemoizedTransactionRequest[] = [];

      // 1. Check and add USDT approval (with zero-allowance workaround for mainnet USDT)
      const tokenAddress = route.asset as `0x${string}`;
      const allowance = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [sender as `0x${string}`, USDT0_LEGACY_MESH_ETH],
      });

      this.logger.debug('USDT0 checking USDT allowance', {
        ...logContext,
        currentAllowance: allowance.toString(),
        required: amount,
        spender: USDT0_LEGACY_MESH_ETH,
      });

      // Approve amount + 5% buffer to cover any on-chain fees the OFT contract charges on top
      const approvalAmount = BigInt(amount) + (BigInt(amount) * 5n) / 100n;

      if (allowance < approvalAmount) {
        // Mainnet USDT requires setting allowance to 0 before setting a new non-zero value
        if (
          route.origin === Number(MAINNET_CHAIN_ID) &&
          route.asset.toLowerCase() === USDT_ETH.toLowerCase() &&
          allowance > 0n
        ) {
          this.logger.info('USDT0: Adding zero-approval for mainnet USDT (non-standard ERC20)', {
            ...logContext,
            currentAllowance: allowance.toString(),
          });
          transactions.push({
            memo: RebalanceTransactionMemo.Approval,
            transaction: {
              to: tokenAddress,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [USDT0_LEGACY_MESH_ETH, 0n],
              }),
              value: BigInt(0),
              funcSig: 'approve(address,uint256)',
            },
          });
        }

        transactions.push({
          memo: RebalanceTransactionMemo.Approval,
          transaction: {
            to: tokenAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [USDT0_LEGACY_MESH_ETH, approvalAmount],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
        });

        this.logger.debug('USDT0 approval transaction(s) added', {
          ...logContext,
          approvalAmount: approvalAmount.toString(),
          approvalCount: transactions.length,
        });
      }

      // 2. Build the OFT send transaction
      const messagingFee: StargateMessagingFee = {
        nativeFee: fee.nativeFee,
        lzTokenFee: BigInt(0),
      };

      transactions.push({
        memo: RebalanceTransactionMemo.Rebalance,
        transaction: {
          to: USDT0_LEGACY_MESH_ETH,
          data: encodeFunctionData({
            abi: STARGATE_OFT_ABI,
            functionName: 'send',
            args: [sendParam, messagingFee, sender as `0x${string}`],
          }),
          value: fee.nativeFee, // Pay LayerZero messaging fee in ETH
          funcSig: 'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
        },
      });

      this.logger.info('USDT0 bridge transactions prepared', {
        ...logContext,
        contract: USDT0_LEGACY_MESH_ETH,
        dstEid: USDT0_LZ_ENDPOINT_TON,
        minAmount: minAmount.toString(),
        nativeFee: fee.nativeFee.toString(),
        transactionCount: transactions.length,
      });

      return transactions;
    } catch (error) {
      this.logger.error('Failed to prepare USDT0 bridge transactions', {
        ...logContext,
        error: jsonifyError(error),
      });
      throw new Error(`Failed to prepare USDT0 bridge: ${(error as Error)?.message ?? ''}`);
    }
  }

  /**
   * USDT0 OFT auto-delivers on destination — no callback needed
   */
  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    this.logger.debug('USDT0 destinationCallback invoked - no action required (auto-delivery)', {
      transactionHash: originTransaction.transactionHash,
      origin: route.origin,
      destination: route.destination,
    });
    return;
  }

  /**
   * Check if the LayerZero message has been delivered to TON
   * Uses the same LayerZero Scan API as Stargate (both are LayerZero OFT)
   */
  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    const logContext = {
      amount,
      origin: route.origin,
      destination: route.destination,
      transactionHash: originTransaction.transactionHash,
    };

    this.logger.debug('USDT0 checking delivery status via LayerZero Scan', logContext);

    try {
      // Extract GUID from OFTSent event (same event as Stargate — standard OFT)
      const guid = this.extractGuidFromReceipt(originTransaction);
      if (!guid) {
        this.logger.warn('USDT0: Could not extract GUID from OFTSent event', logContext);
        return false;
      }

      // Query LayerZero Scan API for message status
      const status = await this.getLayerZeroMessageStatus(originTransaction.transactionHash);

      if (!status) {
        this.logger.debug('USDT0: LayerZero message status not found yet', { ...logContext, guid });
        return false;
      }

      const isReady = status.status === LzMessageStatus.DELIVERED;
      this.logger.debug('USDT0 LayerZero message status', {
        ...logContext,
        status: status.status,
        isReady,
        guid,
        dstTxHash: status.dstTxHash,
      });

      if (status.status === LzMessageStatus.FAILED || status.status === LzMessageStatus.BLOCKED) {
        this.logger.error('USDT0 LayerZero message failed or blocked', {
          ...logContext,
          status: status.status,
          guid,
        });
      }

      return isReady;
    } catch (error) {
      this.logger.error('Failed to check USDT0 transfer status', {
        ...logContext,
        error: jsonifyError(error),
      });
      return false;
    }
  }

  /**
   * Get the destination transaction hash after a successful USDT0 bridge
   */
  async getDestinationTxHash(originTxHash: string): Promise<string | undefined> {
    try {
      const status = await this.getLayerZeroMessageStatus(originTxHash);
      return status?.dstTxHash;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract the GUID from OFTSent event in the transaction receipt
   * The OFTSent event is part of the standard LayerZero OFT interface
   */
  private extractGuidFromReceipt(receipt: TransactionReceipt): `0x${string}` | undefined {
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: STARGATE_OFT_ABI,
          eventName: 'OFTSent',
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName === 'OFTSent') {
          return decoded.args.guid;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * Query LayerZero Scan API for message status
   */
  private async getLayerZeroMessageStatus(txHash: string): Promise<LzScanMessageResponse | undefined> {
    try {
      const url = `${LZ_SCAN_API_URL}/v1/messages/tx/${txHash}`;

      interface LzScanApiResponse {
        data: Array<{
          pathway: { srcEid: number; dstEid: number };
          source: { tx: { txHash: string; blockNumber: string } };
          destination: { tx?: { txHash: string; blockNumber?: number } };
          status: { name: string; message?: string };
        }>;
      }

      const { data: response } = await axiosGet<LzScanApiResponse>(url);

      if (!response.data || response.data.length === 0) {
        return undefined;
      }

      const msg = response.data[0];

      const result: LzScanMessageResponse = {
        status: msg.status.name as LzMessageStatus,
        srcTxHash: msg.source.tx.txHash,
        dstTxHash: msg.destination.tx?.txHash,
        srcChainId: msg.pathway.srcEid,
        dstChainId: msg.pathway.dstEid,
        srcBlockNumber: parseInt(msg.source.tx.blockNumber, 10),
        dstBlockNumber: msg.destination.tx?.blockNumber,
      };

      this.logger.debug('USDT0 LayerZero message status retrieved', {
        txHash,
        status: result.status,
        dstTxHash: result.dstTxHash,
        srcEid: result.srcChainId,
        dstEid: result.dstChainId,
      });

      return result;
    } catch (error) {
      this.logger.error('USDT0: Failed to query LayerZero Scan API', {
        error: jsonifyError(error),
        txHash,
      });
      return undefined;
    }
  }

  /**
   * Get or create a public client for a chain
   */
  private getPublicClient(chainId: number): PublicClient {
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
