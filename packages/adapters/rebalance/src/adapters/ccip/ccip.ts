import { TransactionReceipt, createPublicClient, http, fallback, Address } from 'viem';
import { SupportedBridge, RebalanceRoute, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { SVMExtraArgsV1, SDKAnyMessage } from './types';
import {
  CCIPTransferStatus,
  CHAIN_SELECTORS,
  CCIP_ROUTER_ADDRESSES,
  CCIP_SUPPORTED_CHAINS,
  CHAIN_ID_TO_CCIP_SELECTOR,
  SOLANA_CHAIN_ID_NUMBER,
  CCIPRequestTx,
} from './types';
import { Connection } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { TransactionRequest } from 'ethers';
export class CCIPBridgeAdapter implements BridgeAdapter {
  // Lazy-load bs58 to avoid CJS/ESM interop issues under Node16 resolution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bs58Module?: Promise<any>;
  private bs58Decode?: (value: string) => Uint8Array;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing CCIPBridgeAdapter');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async importBs58Module(): Promise<any> {
    return import('bs58');
  }

  private async getBs58Decode(): Promise<(value: string) => Uint8Array> {
    if (!this.bs58Module) {
      this.bs58Module = this.importBs58Module();
    }

    const mod = await this.bs58Module;
    const decode =
      (mod as { decode?: unknown }).decode ??
      (mod as { default?: { decode?: unknown } }).default?.decode ??
      (mod as { default?: unknown }).default;

    if (typeof decode !== 'function') {
      throw new Error('bs58 decode function is unavailable');
    }

    this.bs58Decode = this.bs58Decode ?? (decode as (value: string) => Uint8Array);
    return this.bs58Decode;
  }

  type(): SupportedBridge {
    return SupportedBridge.CCIP;
  }

  async getMinimumAmount(_route: RebalanceRoute): Promise<string | null> {
    // CCIP has no fixed minimum, depends on fee costs
    return null;
  }

  /**
   * Check if a chain ID represents Solana
   */
  private isSolanaChain(chainId: number): boolean {
    return chainId === SOLANA_CHAIN_ID_NUMBER;
  }

  private validateCCIPRoute(route: RebalanceRoute): void {
    const originChainId = route.origin;
    const destinationChainId = route.destination;

    // Check origin chain support (EVM chains only for sending)
    if (!CCIP_SUPPORTED_CHAINS[originChainId as keyof typeof CCIP_SUPPORTED_CHAINS]) {
      throw new Error(`Origin chain ${originChainId} not supported by CCIP`);
    }

    // For Solana destination, we allow it since CCIP supports Solana as a destination
    // Use the numeric Solana chain ID constant to avoid BigInt overflow issues
    if (
      !this.isSolanaChain(destinationChainId) &&
      !CCIP_SUPPORTED_CHAINS[destinationChainId as keyof typeof CCIP_SUPPORTED_CHAINS]
    ) {
      throw new Error(`Destination chain ${destinationChainId} not supported by CCIP`);
    }

    // Check if router is available for origin chain
    const routerAddress = CCIP_ROUTER_ADDRESSES[originChainId];
    if (!routerAddress) {
      throw new Error(`CCIP router not available for origin chain ${originChainId}`);
    }
  }

  private getDestinationChainSelector(chainId: number): string {
    // Special handling for Solana using the numeric chain ID
    if (this.isSolanaChain(chainId)) {
      return CHAIN_SELECTORS.SOLANA;
    }

    // Use the chain ID to selector map
    const selector = CHAIN_ID_TO_CCIP_SELECTOR[chainId];
    if (selector) {
      return selector;
    }

    throw new Error(`Unsupported destination chain ID: ${chainId}`);
  }

  /**
   * Encode a Solana base58 address as bytes for CCIP receiver field
   * CCIP expects Solana addresses as 32-byte public keys
   */
  private async encodeSolanaAddress(solanaAddress: string): Promise<`0x${string}`> {
    try {
      const decode = await this.getBs58Decode();
      // Decode base58 Solana address to get the 32-byte public key
      const publicKeyBytes = decode(solanaAddress);

      if (publicKeyBytes.length !== 32) {
        throw new Error(`Invalid Solana address length: expected 32 bytes, got ${publicKeyBytes.length}`);
      }

      // Return as hex-encoded bytes
      return `0x${Buffer.from(publicKeyBytes).toString('hex')}` as `0x${string}`;
    } catch (error) {
      throw new Error(`Failed to encode Solana address '${solanaAddress}': ${(error as Error).message}`);
    }
  }

  /**
   * Encode recipient address based on destination chain type
   */
  private async encodeRecipientAddress(address: string, destinationChainId: number): Promise<`0x${string}`> {
    // Check if destination is Solana
    if (this.isSolanaChain(destinationChainId)) {
      return this.encodeSolanaAddress(address);
    }

    // For EVM chains, ensure address is properly formatted
    if (!address.startsWith('0x') || address.length !== 42) {
      throw new Error(`Invalid EVM address format: ${address}`);
    }

    // Pad EVM address to 32 bytes for CCIP receiver field
    const addressWithoutPrefix = address.slice(2).toLowerCase();
    return `0x000000000000000000000000${addressWithoutPrefix}` as `0x${string}`;
  }

  /**
   * Build CCIP SVMExtraArgsV1 for Solana destination (Borsh serialized)
   * See: https://docs.chain.link/ccip/api-reference/svm/v1.6.0/messages#svmextraargsv1
   *
   * Format:
   * - Tag: 4 bytes big-endian (0x1f3b3aba)
   * - compute_units: u32 (4 bytes LE)
   * - account_is_writable_bitmap: u64 (8 bytes LE)
   * - allow_out_of_order_execution: bool (1 byte)
   * - token_receiver: [u8; 32] (32 bytes)
   * - accounts: Vec<[u8; 32]> (4 bytes length + 32 bytes per account)
   *
   * @param computeUnits - Compute units for Solana. MUST be 0 for token-only transfers.
   * @param accountIsWritableBitmap - Bitmask for writable accounts. 0 for token-only.
   * @param allowOutOfOrderExecution - Must be true for Solana destination
   * @param tokenReceiver - Solana address (base58) receiving tokens. Required for token transfers.
   * @param accounts - Additional accounts needed. Empty for token-only transfers.
   */
  private async encodeSVMExtraArgsV1(
    computeUnits: number,
    accountIsWritableBitmap: bigint,
    allowOutOfOrderExecution: boolean,
    tokenReceiver: string,
    accounts: string[] = [],
  ): Promise<SVMExtraArgsV1> {
    const decode = await this.getBs58Decode();

    // SVM_EXTRA_ARGS_V1_TAG: 0x1f3b3aba (4 bytes, big-endian)
    const typeTag = Buffer.alloc(4);
    typeTag.writeUInt32BE(0x1f3b3aba, 0);

    // compute_units: u32 little-endian (4 bytes)
    const computeUnitsBuf = Buffer.alloc(4);
    computeUnitsBuf.writeUInt32LE(computeUnits, 0);

    // account_is_writable_bitmap: u64 little-endian (8 bytes)
    const bitmapBuf = Buffer.alloc(8);
    bitmapBuf.writeBigUInt64LE(accountIsWritableBitmap, 0);

    // allow_out_of_order_execution: bool (1 byte)
    const oooBuf = Buffer.alloc(1);
    oooBuf.writeUInt8(allowOutOfOrderExecution ? 1 : 0, 0);

    // token_receiver: [u8; 32] - Solana public key
    let tokenReceiverBuf: Buffer;
    if (tokenReceiver.startsWith('0x')) {
      tokenReceiverBuf = Buffer.from(tokenReceiver.slice(2), 'hex');
    } else {
      // Assume base58 Solana address
      tokenReceiverBuf = Buffer.from(decode(tokenReceiver));
    }
    if (tokenReceiverBuf.length !== 32) {
      throw new Error(`Invalid tokenReceiver length: expected 32 bytes, got ${tokenReceiverBuf.length}`);
    }

    const accountsHex = accounts.map((account) => {
      const buf = account.startsWith('0x') ? Buffer.from(account.slice(2), 'hex') : Buffer.from(decode(account));
      if (buf.length !== 32) {
        throw new Error(`Invalid account length: expected 32 bytes, got ${buf.length}`);
      }
      return `0x${buf.toString('hex')}` as `0x${string}`;
    });

    return {
      computeUnits: BigInt(computeUnits),
      accountIsWritableBitmap,
      allowOutOfOrderExecution,
      tokenReceiver: `0x${tokenReceiverBuf.toString('hex')}` as `0x${string}`,
      accounts: accountsHex,
    };
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

  async sendSolanaToMainnet(
    sender: string,
    recipient: string,
    amount: string,
    connection: Connection,
    wallet: Wallet,
    route: RebalanceRoute,
  ): Promise<CCIPRequestTx> {
    // Dynamic import for ES module compatibility; use eval to prevent TS from downleveling to require()
    const { SolanaChain } = await import('@chainlink/ccip-sdk');
    const solanaChain = await SolanaChain.fromConnection(connection);

    // Create extra args
    const extraArgs = {
      gasLimit: 0n, // No execution on destination for token transfers
      allowOutOfOrderExecution: true,
    };

    // Get fee first
    const fee = await solanaChain.getFee({
      router: CCIP_ROUTER_ADDRESSES[route.origin],
      destChainSelector: BigInt(CHAIN_ID_TO_CCIP_SELECTOR[route.destination]),
      message: {
        receiver: recipient,
        data: Buffer.from(''),
        tokenAmounts: [{ token: route.asset, amount: BigInt(amount) }],
        extraArgs: extraArgs,
      },
    });

    const result = await solanaChain.sendMessage({
      wallet: wallet,
      router: CCIP_ROUTER_ADDRESSES[route.origin],
      destChainSelector: BigInt(CHAIN_ID_TO_CCIP_SELECTOR[route.destination]),
      message: {
        receiver: recipient,
        data: Buffer.from(''),
        tokenAmounts: [{ token: route.asset, amount: BigInt(amount) }],
        extraArgs: extraArgs,
        fee: fee,
      },
    });

    return {
      hash: result.tx.hash,
      logs: result.tx.logs,
      blockNumber: result.tx.blockNumber,
      timestamp: result.tx.timestamp,
      from: sender,
    };
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

      // Determine if destination is Solana for special handling
      const isSolanaDestination = this.isSolanaChain(route.destination);

      if (!isSolanaDestination) {
        throw new Error('Destination chain must be an Solana chain');
      }

      // Get providers for the origin chain
      const providers = this.chains[originChainId.toString()]?.providers ?? [];
      if (!providers.length) {
        throw new Error(`No providers found for origin chain ${originChainId}`);
      }

      // Dynamic import for ES module compatibility; use eval to prevent TS from downleveling to require()
      const { EVMChain } = await import('@chainlink/ccip-sdk');
      const sourceChain = await EVMChain.fromUrl(providers[0]);
      const destChainSelector = BigInt(CHAIN_ID_TO_CCIP_SELECTOR[route.destination]);

      // Create CCIP message with proper encoding based on destination chain
      // For Solana: receiver must be zero address, actual recipient goes in tokenReceiver (extraArgs)
      // For EVM: receiver is the actual recipient padded to 32 bytes
      const receiver = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

      const extraArgs = await this.encodeSVMExtraArgsV1(
        0, // computeUnits: 0 for token-only transfers
        0n, // accountIsWritableBitmap: 0 for token-only
        true, // allowOutOfOrderExecution: MUST be true for Solana
        recipient, // tokenReceiver: actual Solana recipient address
        [], // accounts: empty for token-only transfers
      );

      const ccipMessage: SDKAnyMessage = {
        // For Solana token-only transfers: receiver MUST be zero address
        // The actual recipient is specified in tokenReceiver field of SVMExtraArgsV1
        receiver,
        data: '0x' as `0x${string}`, // No additional data for simple token transfer
        tokenAmounts: [
          {
            token: tokenAddress,
            amount: tokenAmount,
          },
        ],
        // For Solana: SVMExtraArgsV1 with tokenReceiver set to actual recipient
        // For EVM: EVMExtraArgsV2 with gasLimit=0 for token-only transfers
        extraArgs,
        feeToken: '0x0000000000000000000000000000000000000000' as Address, // Pay fees in native token
      };

      // Get fee first
      const fee = await sourceChain.getFee({
        router: routerAddress as `0x${string}`,
        destChainSelector: BigInt(CHAIN_ID_TO_CCIP_SELECTOR[route.destination]),
        message: ccipMessage,
      });

      this.logger.info('CCIP fee calculated', {
        fee: fee.toString(),
        originChainId,
      });

      const unsignedTx = await sourceChain.generateUnsignedSendMessage({
        sender, // Your wallet address
        router: routerAddress as `0x${string}`,
        destChainSelector,
        message: {
          ...ccipMessage,
          fee,
        },
      });

      this.logger.info('CCIP transfer transactions prepared', {
        originChainId,
        totalTransactions: unsignedTx.transactions.length,
        needsApproval: unsignedTx.transactions.length > 1,
        ccipFee: fee.toString(),
        effectiveAmount: amount,
      });

      const txs = unsignedTx.transactions;
      const approveTxs = txs.slice(0, txs.length - 1);
      const sendTx: TransactionRequest = txs[txs.length - 1]!;

      return [
        ...approveTxs.map((tx: TransactionRequest) => ({
          transaction: {
            to: tx.to as `0x${string}`,
            from: tx.from as `0x${string}`,
            data: tx.data as `0x${string}`,
            value: tx.value as bigint,
            nonce: tx.nonce as number,
          },
          memo: RebalanceTransactionMemo.Approval,
          effectiveAmount: amount,
        })),
        {
          transaction: {
            to: sendTx.to as `0x${string}`,
            from: sendTx.from as `0x${string}`,
            data: sendTx.data as `0x${string}`,
            value: sendTx.value as bigint,
            nonce: sendTx.nonce as number,
          },
          memo: RebalanceTransactionMemo.Rebalance,
          effectiveAmount: amount,
        },
      ];
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

      // Handle both viem string status ('success') and database numeric status (1)
      const isSuccessful =
        originTransaction && (originTransaction.status === 'success' || (originTransaction.status as unknown) === 1);

      if (!isSuccessful) {
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
        route.destination,
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
   * Extract CCIP message ID from transaction receipt logs
   * The message ID is emitted in the CCIPSendRequested event
   */
  async extractMessageIdFromReceipt(transactionHash: string, originChainId: number): Promise<string | null> {
    try {
      // Skip for Solana chains - can't use eth_getTransactionReceipt on Solana RPC
      if (this.isSolanaChain(originChainId)) {
        this.logger.debug('Skipping message ID extraction for Solana origin chain', {
          transactionHash,
          originChainId,
        });
        return null;
      }

      const providers = this.chains[originChainId.toString()]?.providers ?? [];
      if (!providers.length) {
        return null;
      }

      const transports = providers.map((p: string) => http(p));
      const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
      const client = createPublicClient({ transport });

      const receipt = await client.getTransactionReceipt({
        hash: transactionHash as `0x${string}`,
      });

      if (!receipt || !receipt.logs) {
        return null;
      }

      // Look for CCIPSendRequested event which contains the messageId
      // The event signature is: CCIPSendRequested(bytes32 indexed messageId, ...)
      // The messageId is the first topic after the event signature
      for (const log of receipt.logs) {
        // CCIPSendRequested event has messageId as first indexed parameter (topic[1])
        if (log.topics.length >= 2) {
          // Check if this looks like a CCIP event (topic[1] would be messageId)
          // The event from EVM OnRamp contract
          const potentialMessageId = log.topics[1];
          if (potentialMessageId && potentialMessageId.startsWith('0x') && potentialMessageId.length === 66) {
            this.logger.debug('Found potential CCIP message ID in logs', {
              transactionHash,
              messageId: potentialMessageId,
              logAddress: log.address,
            });
            return potentialMessageId;
          }
        }
      }

      this.logger.warn('Could not find CCIP message ID in transaction logs', {
        transactionHash,
        logsCount: receipt.logs.length,
      });

      return null;
    } catch (error) {
      this.logger.error('Failed to extract message ID from receipt', {
        error: jsonifyError(error),
        transactionHash,
        originChainId,
      });
      return null;
    }
  }

  /**
   * Get CCIP transfer status using the official SDK
   *
   * Note: The CCIP SDK's getTransferStatus requires the messageId, not the transaction hash.
   * The messageId is emitted in the CCIPSendRequested event on the origin chain.
   */
  async getTransferStatus(
    transactionHash: string,
    originChainId: number,
    destinationChainId: number,
  ): Promise<CCIPTransferStatus> {
    try {
      this.logger.debug('Checking CCIP transfer status', {
        transactionHash,
        originChainId,
        destinationChainId,
      });

      // Create a public client for the destination chain to check status
      let destinationChain, sourceChain;

      const destinationProviders = this.chains[destinationChainId.toString()]?.providers ?? [];
      const originProviders = this.chains[originChainId.toString()]?.providers ?? [];
      if (!destinationProviders.length) {
        throw new Error(`No providers found for destination chain ${destinationChainId}`);
      }
      if (!originProviders.length) {
        throw new Error(`No providers found for origin chain ${originChainId}`);
      }

      // Dynamic import for ES module compatibility; use eval to prevent TS from downleveling to require()
      const { SolanaChain, EVMChain, discoverOffRamp, ExecutionState, MessageStatus } = await import(
        '@chainlink/ccip-sdk'
      );
      if (this.isSolanaChain(destinationChainId)) {
        destinationChain = await SolanaChain.fromUrl(destinationProviders[0]);
        sourceChain = await EVMChain.fromUrl(originProviders[0]);
      } else {
        destinationChain = await EVMChain.fromUrl(destinationProviders[0]);
        sourceChain = await SolanaChain.fromUrl(originProviders[0]);
      }

      // First, try to extract the message ID from the transaction logs
      const requests = await sourceChain.getMessagesInTx(transactionHash);
      if (!requests.length) {
        this.logger.warn('Could not extract CCIP message ID, will try using transaction hash', {
          transactionHash,
          originChainId,
        });
        return {
          status: 'PENDING',
          message: 'Could not extract CCIP message ID from transaction',
          messageId: undefined,
        };
      }

      const request = requests[0];
      const messageId = request.message.messageId;
      const offRamp = await discoverOffRamp(sourceChain, destinationChain, request.lane.onRamp);
      let transferStatus;

      // For Solana, add retry logic with exponential backoff to handle rate limits
      const isSolanaDestination = this.isSolanaChain(destinationChainId);
      const maxRetries = isSolanaDestination ? 3 : 1;
      let retryCount = 0;
      let lastError: Error | null = null;

      while (retryCount <= maxRetries) {
        try {
          // Add delay between retries (exponential backoff)
          if (retryCount > 0) {
            const delayMs = Math.min(1000 * Math.pow(2, retryCount - 1), 20000); // Max 20 seconds
            this.logger.debug('Retrying getExecutionReceipts after rate limit', {
              retryCount,
              delayMs,
              transactionHash,
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }

          // For Solana, add delay between iterations to avoid rate limits
          const receiptIterator = destinationChain.getExecutionReceipts({
            offRamp,
            messageId: messageId,
            sourceChainSelector: request.message.sourceChainSelector,
            startTime: request.tx.timestamp,
          });

          for await (const receipt of receiptIterator) {
            transferStatus =
              receipt.receipt.state === ExecutionState.Success ? MessageStatus.Success : MessageStatus.Failed;

            // For Solana, add a small delay between receipt checks to avoid rate limits
            if (isSolanaDestination) {
              await new Promise((resolve) => setTimeout(resolve, 500)); // 500ms delay
            }
          }

          // Successfully got receipts, break out of retry loop
          break;
        } catch (error) {
          lastError = error as Error;
          const errorMessage = (error as Error).message || '';
          const isRateLimitError =
            errorMessage.includes('Too Many Requests') ||
            errorMessage.includes('429') ||
            errorMessage.includes('rate limit') ||
            errorMessage.toLowerCase().includes('rate limit');

          if (isRateLimitError) {
            if (retryCount < maxRetries) {
              retryCount++;
              this.logger.warn('Rate limit hit on getExecutionReceipts, will retry', {
                retryCount,
                maxRetries,
                transactionHash,
                destinationChainId,
                error: errorMessage,
              });
              continue;
            } else {
              // Exhausted retries, return early
              this.logger.error('Max retries exceeded for getExecutionReceipts', {
                transactionHash,
                destinationChainId,
                error: jsonifyError(lastError),
              });
              return {
                status: 'PENDING',
                message: `Rate limit error after ${maxRetries} retries: ${lastError.message}`,
                messageId: messageId || undefined,
              };
            }
          }

          // Not a rate limit error, throw immediately
          throw error;
        }
      }

      this.logger.debug('CCIP SDK transfer status response', {
        transactionHash,
        messageId: messageId,
        transferStatus,
        sourceChainSelector: request.message.sourceChainSelector,
        destinationRouterAddress: offRamp,
      });

      if (transferStatus === null) {
        return {
          status: 'PENDING',
          message: 'Transfer not yet found on destination chain',
          messageId: messageId || undefined,
        };
      }

      // TransferStatus enum: Untouched = 0, InProgress = 1, Success = 2, Failure = 3
      switch (transferStatus) {
        case MessageStatus.Success: // Success
          return {
            status: 'SUCCESS',
            message: 'CCIP transfer completed successfully',
            messageId: messageId || undefined,
          };
        case MessageStatus.Failed: // Failure
          return {
            status: 'FAILURE',
            message: 'CCIP transfer failed',
            messageId: messageId || undefined,
          };
        default:
          return {
            status: 'PENDING',
            message: 'CCIP transfer pending or not yet started',
            messageId: messageId || undefined,
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
