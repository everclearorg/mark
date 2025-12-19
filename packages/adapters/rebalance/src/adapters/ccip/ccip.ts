import { TransactionReceipt, createPublicClient, http, fallback, encodeFunctionData, erc20Abi, Address } from 'viem';
import { mainnet } from 'viem/chains';
import { SupportedBridge, RebalanceRoute, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import {
  CCIPMessage,
  CCIPTransferStatus,
  CHAIN_SELECTORS,
  CCIP_ROUTER_ADDRESSES,
  CCIP_SUPPORTED_CHAINS,
  CHAIN_ID_TO_CCIP_SELECTOR,
  SOLANA_CHAIN_ID_NUMBER,
} from './types';
import bs58 from 'bs58';

// Type for CCIP module and client - using type-only import for types, dynamic import for runtime
// The dynamic import returns the module namespace, so we extract types from it
type CCIPModuleType = typeof import('@chainlink/ccip-js');
type CCIPClient = ReturnType<CCIPModuleType['createClient']>;

// Chainlink CCIP Router ABI
const CCIP_ROUTER_ABI = [
  {
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' },
        ],
      },
    ],
    name: 'getFee',
    outputs: [{ name: 'fee', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' },
        ],
      },
    ],
    name: 'ccipSend',
    outputs: [{ name: 'messageId', type: 'bytes32' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export class CCIPBridgeAdapter implements BridgeAdapter {
  private ccipClient: CCIPClient | null = null;
  private ccipModule: CCIPModuleType | null = null;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing CCIPBridgeAdapter');
  }

  /**
   * Lazy-load the CCIP module and client to handle ES module import
   */
  private async getCcipClient(): Promise<CCIPClient> {
    if (this.ccipClient) {
      return this.ccipClient;
    }

    if (!this.ccipModule) {
      this.ccipModule = await import('@chainlink/ccip-js');
    }

    this.ccipClient = this.ccipModule.createClient();
    return this.ccipClient;
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
  private encodeSolanaAddress(solanaAddress: string): `0x${string}` {
    try {
      // Decode base58 Solana address to get the 32-byte public key
      const publicKeyBytes = bs58.decode(solanaAddress);

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
  private encodeRecipientAddress(address: string, destinationChainId: number): `0x${string}` {
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
  private encodeSVMExtraArgsV1(
    computeUnits: number,
    accountIsWritableBitmap: bigint,
    allowOutOfOrderExecution: boolean,
    tokenReceiver: string,
    accounts: string[] = [],
  ): `0x${string}` {
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
      tokenReceiverBuf = Buffer.from(bs58.decode(tokenReceiver));
    }
    if (tokenReceiverBuf.length !== 32) {
      throw new Error(`Invalid tokenReceiver length: expected 32 bytes, got ${tokenReceiverBuf.length}`);
    }

    // accounts: Vec<[u8; 32]> - 4 bytes length (u32 LE) + 32 bytes per account
    const accountsLengthBuf = Buffer.alloc(4);
    accountsLengthBuf.writeUInt32LE(accounts.length, 0);

    const accountBuffers: Buffer[] = [];
    for (const account of accounts) {
      let accountBuf: Buffer;
      if (account.startsWith('0x')) {
        accountBuf = Buffer.from(account.slice(2), 'hex');
      } else {
        accountBuf = Buffer.from(bs58.decode(account));
      }
      if (accountBuf.length !== 32) {
        throw new Error(`Invalid account length: expected 32 bytes, got ${accountBuf.length}`);
      }
      accountBuffers.push(accountBuf);
    }

    return `0x${Buffer.concat([
      typeTag,
      computeUnitsBuf,
      bitmapBuf,
      oooBuf,
      tokenReceiverBuf,
      accountsLengthBuf,
      ...accountBuffers,
    ]).toString('hex')}` as `0x${string}`;
  }

  /**
   * Build CCIP EVMExtraArgsV2 for EVM destination (Borsh serialized)
   * See: https://docs.chain.link/ccip/api-reference/svm/v1.6.0/messages#evmextraargsv2
   *
   * Format:
   * - Tag: 4 bytes big-endian (0x181dcf10)
   * - gas_limit: u128 (16 bytes LE)
   * - allow_out_of_order_execution: bool (1 byte)
   *
   * @param gasLimit - Gas limit for EVM execution. MUST be 0 for token-only transfers.
   * @param allowOutOfOrderExecution - Whether to allow out-of-order execution
   */
  private encodeEVMExtraArgsV2(gasLimit: number, allowOutOfOrderExecution: boolean): `0x${string}` {
    // EVM_EXTRA_ARGS_V2_TAG: 0x181dcf10 (4 bytes, big-endian)
    const typeTag = Buffer.alloc(4);
    typeTag.writeUInt32BE(0x181dcf10, 0);

    // gas_limit: u128 little-endian (16 bytes)
    const gasLimitBuf = Buffer.alloc(16);
    const gasLimitBigInt = BigInt(gasLimit);
    gasLimitBuf.writeBigUInt64LE(gasLimitBigInt & BigInt('0xFFFFFFFFFFFFFFFF'), 0);
    gasLimitBuf.writeBigUInt64LE(gasLimitBigInt >> BigInt(64), 8);

    // allow_out_of_order_execution: bool (1 byte)
    const oooBuf = Buffer.alloc(1);
    oooBuf.writeUInt8(allowOutOfOrderExecution ? 1 : 0, 0);

    return `0x${Buffer.concat([typeTag, gasLimitBuf, oooBuf]).toString('hex')}` as `0x${string}`;
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

      // Create CCIP message with proper encoding based on destination chain
      // For Solana: receiver must be zero address, actual recipient goes in tokenReceiver (extraArgs)
      // For EVM: receiver is the actual recipient padded to 32 bytes
      const ccipMessage: CCIPMessage = {
        // For Solana token-only transfers: receiver MUST be zero address
        // The actual recipient is specified in tokenReceiver field of SVMExtraArgsV1
        receiver: isSolanaDestination
          ? ('0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`)
          : this.encodeRecipientAddress(recipient, route.destination),
        data: '0x' as `0x${string}`, // No additional data for simple token transfer
        tokenAmounts: [
          {
            token: tokenAddress,
            amount: tokenAmount,
          },
        ],
        // For Solana: SVMExtraArgsV1 with tokenReceiver set to actual recipient
        // For EVM: EVMExtraArgsV2 with gasLimit=0 for token-only transfers
        extraArgs: isSolanaDestination
          ? this.encodeSVMExtraArgsV1(
              0, // computeUnits: 0 for token-only transfers
              0n, // accountIsWritableBitmap: 0 for token-only
              true, // allowOutOfOrderExecution: MUST be true for Solana
              recipient, // tokenReceiver: actual Solana recipient address
              [], // accounts: empty for token-only transfers
            )
          : this.encodeEVMExtraArgsV2(
              0, // gasLimit: 0 for token-only transfers
              true, // allowOutOfOrderExecution: recommended true
            ),
        feeToken: '0x0000000000000000000000000000000000000000' as Address, // Pay fees in native token
      };

      this.logger.debug('CCIP message constructed', {
        isSolanaDestination,
        receiver: ccipMessage.receiver,
        extraArgsLength: ccipMessage.extraArgs.length,
        tokenAmount: tokenAmount.toString(),
      });

      // Get providers for the origin chain
      const providers = this.chains[originChainId.toString()]?.providers ?? [];
      if (!providers.length) {
        throw new Error(`No providers found for origin chain ${originChainId}`);
      }

      const transports = providers.map((p: string) => http(p));
      const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
      const client = createPublicClient({ transport });

      // Get CCIP fee estimate
      const ccipFee = await client.readContract({
        address: routerAddress,
        abi: CCIP_ROUTER_ABI,
        functionName: 'getFee',
        args: [
          BigInt(destinationChainSelector),
          {
            receiver: ccipMessage.receiver,
            data: ccipMessage.data,
            tokenAmounts: ccipMessage.tokenAmounts,
            extraArgs: ccipMessage.extraArgs,
            feeToken: ccipMessage.feeToken,
          },
        ],
      });

      this.logger.info('CCIP fee calculated', {
        fee: ccipFee.toString(),
        originChainId,
      });

      // Check token allowance for CCIP router
      const currentAllowance = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [sender as Address, routerAddress],
      });

      const transactions: MemoizedTransactionRequest[] = [];

      // Add approval transaction if needed
      if (currentAllowance < tokenAmount) {
        this.logger.info('Adding approval transaction for CCIP transfer', {
          originChainId,
          tokenAddress,
          routerAddress,
          currentAllowance: currentAllowance.toString(),
          requiredAmount: tokenAmount.toString(),
        });

        const approvalTx: MemoizedTransactionRequest = {
          transaction: {
            to: tokenAddress,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [routerAddress, tokenAmount],
            }),
            value: BigInt(0),
            funcSig: 'approve(address,uint256)',
          },
          memo: RebalanceTransactionMemo.Approval,
        };
        transactions.push(approvalTx);
      }

      // Add CCIP send transaction
      const ccipTx: MemoizedTransactionRequest = {
        transaction: {
          to: routerAddress,
          data: encodeFunctionData({
            abi: CCIP_ROUTER_ABI,
            functionName: 'ccipSend',
            args: [
              BigInt(destinationChainSelector),
              {
                receiver: ccipMessage.receiver,
                data: ccipMessage.data,
                tokenAmounts: ccipMessage.tokenAmounts,
                extraArgs: ccipMessage.extraArgs,
                feeToken: ccipMessage.feeToken,
              },
            ],
          }),
          value: ccipFee, // Pay fee in native token
          funcSig: 'ccipSend(uint64,(bytes,bytes,(address,uint256)[],bytes,address))',
        },
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount: amount,
      };
      transactions.push(ccipTx);

      this.logger.info('CCIP transfer transactions prepared', {
        originChainId,
        totalTransactions: transactions.length,
        needsApproval: currentAllowance < tokenAmount,
        ccipFee: ccipFee.toString(),
        effectiveAmount: amount,
      });

      return transactions;
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

      // First, try to extract the message ID from the transaction logs
      const messageId = await this.extractMessageIdFromReceipt(transactionHash, originChainId);

      if (!messageId) {
        this.logger.warn('Could not extract CCIP message ID, will try using transaction hash', {
          transactionHash,
          originChainId,
        });
      }

      const idToCheck = messageId || transactionHash;

      // Create a public client for the destination chain to check status
      let destinationClient;

      if (this.isSolanaChain(destinationChainId)) {
        // For Solana destination, use Ethereum mainnet client (CCIP hub)
        destinationClient = createPublicClient({
          chain: mainnet,
          transport: http(),
        });
      } else {
        // For EVM destinations, create client for that specific chain
        const providers = this.chains[destinationChainId.toString()]?.providers ?? [];
        if (!providers.length) {
          throw new Error(`No providers found for destination chain ${destinationChainId}`);
        }

        const transports = providers.map((p: string) => http(p));
        const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
        destinationClient = createPublicClient({ transport });
      }

      // For Solana destination, use Ethereum router as the check point
      const destinationRouterAddress = this.isSolanaChain(destinationChainId)
        ? CCIP_ROUTER_ADDRESSES[1] // Ethereum mainnet router
        : CCIP_ROUTER_ADDRESSES[destinationChainId];

      if (!destinationRouterAddress) {
        throw new Error(`No router address for destination chain ${destinationChainId}`);
      }

      const sourceChainSelector = this.getDestinationChainSelector(originChainId);

      // Use the CCIP SDK to check transfer status
      // Note: Type bridge via `unknown` required because @chainlink/ccip-js bundles its own
      // viem version with incompatible types. At runtime, the PublicClient works correctly.
      const ccipClient = await this.getCcipClient();

      const transferStatus = await ccipClient.getTransferStatus({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: destinationClient as any,
        destinationRouterAddress,
        sourceChainSelector,
        messageId: idToCheck as `0x${string}`,
      });

      this.logger.debug('CCIP SDK transfer status response', {
        transactionHash,
        messageId: idToCheck,
        transferStatus,
        sourceChainSelector,
        destinationRouterAddress,
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
        case 2: // Success
          return {
            status: 'SUCCESS',
            message: 'CCIP transfer completed successfully',
            messageId: messageId || undefined,
            destinationTransactionHash: transactionHash,
          };
        case 3: // Failure
          return {
            status: 'FAILURE',
            message: 'CCIP transfer failed',
            messageId: messageId || undefined,
          };
        case 1: // InProgress
          return {
            status: 'PENDING',
            message: 'CCIP transfer in progress',
            messageId: messageId || undefined,
          };
        case 0: // Untouched
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
