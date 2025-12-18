import { TransactionReceipt, createPublicClient, http, fallback, type PublicClient, erc20Abi } from 'viem';
import { ChainConfiguration, SupportedBridge, RebalanceRoute } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest } from '../../types';
import {
  TAC_CHAIN_ID,
  TAC_BRIDGE_SUPPORTED_ASSETS,
  USDT_TAC,
  TAC_RPC_PROVIDERS,
  TacNetwork,
  TacOperationStatus,
  TacAssetLike,
  TacEvmProxyMsg,
  TacTransactionLinker,
  TacSdkConfig,
  TacRetryConfig,
} from './types';
import { JsonRpcProvider, FallbackProvider } from 'ethers';

// Default TAC sequencer endpoints for reliability
const DEFAULT_TAC_SEQUENCER_ENDPOINTS = ['https://data.tac.build'];

// Default retry configuration
const DEFAULT_RETRY_CONFIG: TacRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
};

/**
 * TAC Inner Bridge Adapter
 *
 * Handles Leg 2 of TAC USDT rebalancing:
 * TON → TAC via the TAC Bridge (lock and mint)
 *
 * Architecture:
 * - Uses TAC SDK (@tonappchain/sdk) for cross-chain transactions
 * - TAC SDK provides RawSender for backend/server-side operations
 * - Supports mnemonic-based TON wallet signing
 *
 * Reference:
 * - TAC SDK Docs: https://docs.tac.build/build/sdk/introduction
 * - TAC SDK GitHub: https://github.com/TacBuild/tac-sdk
 * - TAC Bridge: https://docs.tac.build/build/tooling/bridge
 */
export class TacInnerBridgeAdapter implements BridgeAdapter {
  protected readonly publicClients = new Map<number, PublicClient>();
  protected tacSdk: unknown = null; // TacSdk instance (dynamically imported)
  protected sdkInitialized = false;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
    protected readonly sdkConfig?: TacSdkConfig,
  ) {
    this.logger.debug('Initializing TacInnerBridgeAdapter', {
      tacChainId: TAC_CHAIN_ID,
      usdtOnTac: USDT_TAC,
      hasSdkConfig: !!sdkConfig,
      network: sdkConfig?.network || 'mainnet',
    });
  }

  type(): SupportedBridge {
    return SupportedBridge.TacInner;
  }

  /**
   * Initialize the TAC SDK for cross-chain operations
   * This is done lazily on first use with retry logic for transient failures
   */
  protected async initializeSdk(): Promise<void> {
    if (this.sdkInitialized) return;

    const maxRetries = 3;
    const baseDelayMs = 2000;
    const maxDelayMs = 30000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.initializeSdkInternal();
        return; // Success
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isRetryable = this.isRetryableError(errorMessage);

        if (isRetryable && attempt < maxRetries) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          this.logger.warn(`TAC SDK initialization attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`, {
            error: jsonifyError(error),
            nextAttempt: attempt + 1,
            delayMs: delay,
            isRetryable,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable error or max retries exceeded
        this.logger.warn('Failed to initialize TAC SDK, will use fallback methods', {
          error: jsonifyError(error),
          attempts: attempt,
          maxRetries,
          isRetryable,
          note: 'Install @tonappchain/sdk for full TAC bridge support',
        });
        return; // Don't throw - allow fallback behavior
      }
    }
  }

  /**
   * Internal SDK initialization logic (without retry)
   */
  protected async initializeSdkInternal(): Promise<void> {
    // Dynamically import TAC SDK to avoid issues if not installed
    const { TacSdk, Network } = await import('@tonappchain/sdk');
    const { TonClient } = await import('@ton/ton');

    const network = this.sdkConfig?.network === TacNetwork.TESTNET ? Network.TESTNET : Network.MAINNET;

    // Create custom TonClient with paid RPC to avoid rate limits
    // The default SDK uses Orbs endpoints which can be rate-limited
    // Use DRPC paid endpoint for reliable access
    const tonRpcUrl = this.sdkConfig?.tonRpcUrl || 'https://toncenter.com/api/v2/jsonRPC';

    this.logger.debug('Initializing TonClient', { tonRpcUrl });

    const tonClient = new TonClient({
      endpoint: tonRpcUrl,
      // Note: DRPC includes API key in URL, no separate apiKey param needed
    });

    // Create custom contractOpener using TonClient
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractOpener: any = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      open: <T extends object>(contract: T) => tonClient.open(contract as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getContractState: async (address: any) => {
        const state = await tonClient.getContractState(address);
        return {
          balance: state.balance,
          state: state.state === 'active' ? 'active' : state.state === 'frozen' ? 'frozen' : 'uninitialized',
          code: state.code ?? null,
        };
      },
    };

    // Get custom sequencer endpoints from config or use defaults
    const customSequencerEndpoints = this.sdkConfig?.customSequencerEndpoints ?? DEFAULT_TAC_SEQUENCER_ENDPOINTS;

    // CRITICAL: Create custom TAC EVM provider to avoid rate limits on public endpoints
    // The TAC SDK internally uses ethers to make RPC calls to the TAC chain
    // Without this, it uses default public endpoints which are heavily rate-limited
    const tacRpcUrls =
      this.sdkConfig?.tacRpcUrls ?? this.chains[TAC_CHAIN_ID.toString()]?.providers ?? TAC_RPC_PROVIDERS;

    this.logger.debug('Creating TAC EVM provider', { tacRpcUrls });

    // Create ethers FallbackProvider for reliability
    // This allows automatic failover between RPC endpoints
    let tacProvider;
    if (tacRpcUrls.length === 1) {
      tacProvider = new JsonRpcProvider(tacRpcUrls[0], TAC_CHAIN_ID);
    } else {
      // Create array of provider configs with priority (lower = higher priority)
      const providerConfigs = tacRpcUrls.map((url, index) => ({
        provider: new JsonRpcProvider(url, TAC_CHAIN_ID),
        priority: index,
        stallTimeout: 2000, // 2 second stall timeout before trying next
        weight: 1,
      }));
      tacProvider = new FallbackProvider(providerConfigs);
    }

    this.tacSdk = await TacSdk.create({
      network,
      TONParams: {
        contractOpener,
      },
      // CRITICAL: Pass custom TAC EVM provider to avoid rate-limited public endpoints
      // This uses our configured TAC RPC URLs from config.chains["239"].providers
      TACParams: {
        provider: tacProvider,
      },
      // Provide custom sequencer endpoints for reliability
      // This helps when the primary data.tac.build endpoint is down
      customLiteSequencerEndpoints: customSequencerEndpoints,
    });
    this.sdkInitialized = true;

    this.logger.info('TAC SDK initialized successfully', {
      network,
      tonRpcUrl,
      tacRpcUrls,
      customSequencerEndpoints,
    });
  }

  /**
   * Get the expected amount received after bridging via TAC Inner Bridge
   *
   * TAC Inner Bridge is a 1:1 lock-and-mint bridge with no fees.
   * Assets locked on TON are minted 1:1 on TAC EVM.
   */
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    // TAC Inner Bridge is 1:1 - no fees for lock-and-mint
    this.logger.debug('TAC Inner Bridge quote (1:1)', {
      amount,
      route,
      note: 'TAC Inner Bridge is a 1:1 lock-and-mint bridge',
    });
    return amount;
  }

  /**
   * Returns the minimum rebalance amount for TAC Inner Bridge.
   * TAC Inner Bridge doesn't have a strict minimum.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getMinimumAmount(route: RebalanceRoute): Promise<string | null> {
    // TAC Inner Bridge has no strict minimum
    return null;
  }

  /**
   * Build transactions needed to bridge via TAC Inner Bridge
   *
   * Note: For TON → TAC, this uses the TAC SDK which handles:
   * 1. Creating the cross-chain message
   * 2. Signing with TON wallet (via RawSender)
   * 3. Submitting to the TAC sequencer
   *
   * Returns empty array - the actual bridge is executed via executeTacBridge()
   */
  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      this.logger.info('TAC Inner Bridge send requested', {
        sender,
        recipient,
        amount,
        route,
        note: 'TON → TAC bridging uses TAC SDK sendCrossChainTransaction',
      });

      // Return empty array - the actual bridge is triggered via executeTacBridge()
      // This is because TON transactions are not EVM transactions
      return [];
    } catch (error) {
      this.handleError(error, 'prepare TAC Inner Bridge transaction', { amount, route });
    }
  }

  /**
   * Execute the TAC Inner Bridge transfer using TAC SDK
   *
   * This method uses the TAC SDK's sendCrossChainTransaction method
   * with RawSender for backend/server-side operations.
   *
   * Architecture:
   * - TAC SDK handles asset bridging from TON to TAC EVM
   * - Assets are locked on TON and minted on TAC
   * - For simple bridging (no EVM contract call), we use ERC20 transfer to send
   *   the bridged assets to the desired recipient
   * - The sender's TAC address receives the bridged tokens first, then transfers them
   *
   * Flow:
   * 1. TON jettons are locked on TON
   * 2. TAC sequencer mints equivalent tokens to the sender's TAC address
   * 3. The evmProxyMsg triggers ERC20 transfer to the final recipient
   *
   * Retry Logic:
   * - Uses exponential backoff for transient failures (endpoint failures, network issues)
   * - Default: 3 retries with 2s base delay, up to 30s max delay
   *
   * @param tonMnemonic - TON wallet mnemonic for signing
   * @param recipient - TAC EVM address to receive tokens (must be EVM format 0x...)
   * @param amount - Amount to bridge (in jetton units - 6 decimals for USDT)
   * @param asset - TON jetton address (from config.ton.assets)
   * @param retryConfig - Optional retry configuration
   */
  async executeTacBridge(
    tonMnemonic: string,
    recipient: string,
    amount: string,
    asset: string,
    retryConfig: TacRetryConfig = DEFAULT_RETRY_CONFIG,
  ): Promise<TacTransactionLinker | null> {
    const { maxRetries, baseDelayMs, maxDelayMs } = retryConfig;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeTacBridgeInternal(tonMnemonic, recipient, amount, asset);
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isRetryable = this.isRetryableError(errorMessage);

        if (isRetryable && attempt < maxRetries) {
          // Calculate delay with exponential backoff: baseDelay * 2^(attempt-1)
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

          this.logger.warn(`TAC bridge attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`, {
            error: jsonifyError(error),
            recipient,
            amount,
            asset,
            nextAttempt: attempt + 1,
            delayMs: delay,
            isRetryable,
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable error or max retries exceeded
        this.logger.error('Failed to execute TAC bridge after retries', {
          error: jsonifyError(error),
          recipient,
          amount,
          asset,
          attempts: attempt,
          maxRetries,
          isRetryable,
        });
        return null;
      }
    }

    return null;
  }

  /**
   * Check if an error is retryable (transient network/endpoint issues)
   */
  protected isRetryableError(errorMessage: string): boolean {
    const retryablePatterns = [
      'All endpoints failed',
      'failed to fetch',
      'failed to complete request',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'socket hang up',
      'network error',
      'timeout',
      'rate limit',
      '503',
      '502',
      '504',
      '429',
    ];

    const lowerMessage = errorMessage.toLowerCase();
    return retryablePatterns.some((pattern) => lowerMessage.includes(pattern.toLowerCase()));
  }

  /**
   * Internal implementation of TAC bridge execution (without retry logic)
   */
  protected async executeTacBridgeInternal(
    tonMnemonic: string,
    recipient: string,
    amount: string,
    asset: string,
  ): Promise<TacTransactionLinker | null> {
    await this.initializeSdk();

    if (!this.tacSdk) {
      throw new Error('TAC SDK not initialized, cannot execute bridge');
    }

    // Import SDK components
    const { SenderFactory, Network } = await import('@tonappchain/sdk');

    // Determine network based on config
    const network = this.sdkConfig?.network === TacNetwork.TESTNET ? Network.TESTNET : Network.MAINNET;

    // Create RawSender for backend operations (server-side signing)
    // TAC SDK v0.7.x requires network, version, and mnemonic
    // Use V4 which matches the wallet derived from the 12-word mnemonic
    const sender = await SenderFactory.getSender({
      network,
      version: 'V4', // V4 wallet - standard TON wallet
      mnemonic: tonMnemonic,
    });

    // Get the sender's wallet address for debugging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const senderAny = sender as any;
    const senderAddress =
      typeof senderAny.getSenderAddress === 'function'
        ? senderAny.getSenderAddress()
        : senderAny.wallet?.address?.toString?.() || 'unknown';

    // Log for debugging (V4 wallet derived from mnemonic)
    this.logger.info('TAC bridge sender wallet', {
      senderTonWallet: senderAddress,
      finalRecipient: recipient,
    });

    // Build the EVM proxy message
    // For simple bridging (TON → TAC) without calling a contract,
    // we just specify the recipient address as evmTargetAddress.
    // The TAC SDK will bridge tokens directly to this address.
    //
    // See TAC SDK docs: for TON-TAC transactions, when no methodName
    // is provided, tokens are sent directly to evmTargetAddress.
    const evmProxyMsg: TacEvmProxyMsg = {
      evmTargetAddress: recipient, // Tokens go directly to recipient
      // No methodName or encodedParameters needed for simple transfer
    };

    // Prepare assets to bridge
    // TAC SDK will lock these on TON and mint on TAC
    // IMPORTANT: Use rawAmount (not amount) since we're already passing the raw token units
    // 'amount' expects human-readable values (e.g., 1.99) which get multiplied by 10^decimals
    // 'rawAmount' expects raw units (e.g., 1999400 for 1.9994 USDT with 6 decimals)
    const assets: TacAssetLike[] = [
      {
        address: asset, // TON jetton address
        rawAmount: BigInt(amount), // Already in raw units (6 decimals for USDT)
      },
    ];

    this.logger.info('Executing TAC SDK bridge', {
      recipient,
      amount,
      asset,
      evmTarget: evmProxyMsg.evmTargetAddress,
      note: 'Simple bridge - tokens go directly to recipient',
    });

    // Send cross-chain transaction via TAC SDK
    // The SDK will:
    // 1. Create the cross-chain message on TON
    // 2. Sign with the sender's TON wallet
    // 3. Submit to the TAC sequencer network
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transactionLinker = await (this.tacSdk as any).sendCrossChainTransaction(evmProxyMsg, sender, assets);

    this.logger.info('TAC bridge transaction sent successfully', {
      recipient,
      amount,
      asset,
      transactionLinker,
    });

    return transactionLinker as TacTransactionLinker;
  }

  /**
   * Execute simple asset bridging with no EVM proxy call
   *
   * This method attempts to bridge assets using TAC SDK methods that
   * don't require specifying an EVM call (assets go to default address).
   *
   * Falls back to sendCrossChainTransaction with minimal config.
   *
   * @param tonMnemonic - TON wallet mnemonic for signing
   * @param amount - Amount to bridge (in jetton units - 6 decimals for USDT)
   * @param asset - TON jetton address (from config.ton.assets)
   */
  async executeSimpleBridge(tonMnemonic: string, amount: string, asset: string): Promise<TacTransactionLinker | null> {
    try {
      await this.initializeSdk();

      if (!this.tacSdk) {
        this.logger.error('TAC SDK not initialized, cannot execute bridge');
        return null;
      }

      const { SenderFactory, Network } = await import('@tonappchain/sdk');

      // Determine network based on config
      const network = this.sdkConfig?.network === TacNetwork.TESTNET ? Network.TESTNET : Network.MAINNET;

      const sender = await SenderFactory.getSender({
        network,
        version: 'V4', // V4 wallet - standard TON wallet
        mnemonic: tonMnemonic,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = this.tacSdk as any;

      // Try to use bridgeAssets method if available (depends on SDK version)
      if (typeof sdk.bridgeAssets === 'function') {
        this.logger.info('Using TAC SDK bridgeAssets method', { amount, asset });

        // IMPORTANT: Use rawAmount (not amount) since we're already passing raw token units
        // 'amount' expects human-readable values (e.g., 1.99) which get multiplied by 10^decimals
        // 'rawAmount' expects raw units (e.g., 1999400 for 1.9994 USDT with 6 decimals)
        const result = await sdk.bridgeAssets(sender, [{ address: asset, rawAmount: BigInt(amount) }]);

        return result as TacTransactionLinker;
      }

      // Try startBridging method (alternative TAC SDK method)
      if (typeof sdk.startBridging === 'function') {
        this.logger.info('Using TAC SDK startBridging method', { amount, asset });

        // IMPORTANT: Use rawAmount for the same reason as above
        const result = await sdk.startBridging(sender, [{ address: asset, rawAmount: BigInt(amount) }]);

        return result as TacTransactionLinker;
      }

      // Use sendCrossChainTransaction with minimal evmProxyMsg
      // This will bridge assets but requires an EVM proxy call
      this.logger.info('Using sendCrossChainTransaction with minimal config', { amount, asset });

      // Minimal proxy message - just targets the token contract with no action
      const evmProxyMsg: TacEvmProxyMsg = {
        evmTargetAddress: USDT_TAC,
        methodName: '',
        encodedParameters: '0x',
      };

      // IMPORTANT: Use rawAmount (not amount) since we're already passing raw token units
      const transactionLinker = await sdk.sendCrossChainTransaction(evmProxyMsg, sender, [
        { address: asset, rawAmount: BigInt(amount) },
      ]);

      return transactionLinker as TacTransactionLinker;
    } catch (error) {
      this.logger.error('Failed to execute simple bridge', {
        error: jsonifyError(error),
        amount,
        asset,
      });
      return null;
    }
  }

  /**
   * Track the status of a TAC cross-chain operation
   *
   * Uses TAC SDK's OperationTracker to check the status of a pending bridge.
   *
   * Status values:
   * - PENDING: Operation is in progress
   * - SUCCESSFUL: Operation completed successfully
   * - FAILED: Operation failed
   * - NOT_FOUND: Operation not found (may not have been indexed yet)
   *
   * @param transactionLinker - The transaction linker from sendCrossChainTransaction
   */
  async trackOperation(transactionLinker: TacTransactionLinker): Promise<TacOperationStatus> {
    try {
      const { OperationTracker, Network } = await import('@tonappchain/sdk');

      // Initialize tracker with network configuration
      const network = this.sdkConfig?.network === TacNetwork.TESTNET ? Network.TESTNET : Network.MAINNET;

      const tracker = new OperationTracker(network);

      this.logger.debug('Tracking TAC operation', {
        transactionLinker,
        network: this.sdkConfig?.network || 'mainnet',
      });

      // Get simplified status (PENDING, SUCCESSFUL, FAILED, NOT_FOUND)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = await tracker.getSimplifiedOperationStatus(transactionLinker as any);

      this.logger.debug('TAC operation status retrieved', {
        transactionLinker,
        status,
      });

      // Map SDK status to our enum
      switch (status) {
        case 'SUCCESSFUL':
          return TacOperationStatus.SUCCESSFUL;
        case 'FAILED':
          return TacOperationStatus.FAILED;
        case 'PENDING':
          return TacOperationStatus.PENDING;
        case 'OPERATION_ID_NOT_FOUND':
        default:
          return TacOperationStatus.NOT_FOUND;
      }
    } catch (error) {
      this.logger.error('Failed to track TAC operation', {
        error: jsonifyError(error),
        transactionLinker,
      });
      return TacOperationStatus.NOT_FOUND;
    }
  }

  /**
   * Wait for a TAC operation to complete with polling
   *
   * @param transactionLinker - The transaction linker from sendCrossChainTransaction
   * @param timeoutMs - Maximum time to wait (default 10 minutes)
   * @param pollIntervalMs - Polling interval (default 10 seconds)
   */
  async waitForOperation(
    transactionLinker: TacTransactionLinker,
    timeoutMs: number = 600000, // 10 minutes
    pollIntervalMs: number = 10000, // 10 seconds
  ): Promise<TacOperationStatus> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.trackOperation(transactionLinker);

      if (status === TacOperationStatus.SUCCESSFUL || status === TacOperationStatus.FAILED) {
        return status;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    this.logger.warn('TAC operation tracking timed out', {
      transactionLinker,
      timeoutMs,
    });

    return TacOperationStatus.PENDING;
  }

  /**
   * TAC Inner Bridge doesn't require destination callbacks
   * Tokens are minted automatically by the TAC sequencer
   */
  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    this.logger.debug('TAC Inner Bridge destinationCallback invoked - no action required', {
      transactionHash: originTransaction.transactionHash,
      route,
    });
    return;
  }

  /**
   * Check if the TAC Inner Bridge transfer is complete
   *
   * Strategy:
   * 1. If we have a transactionLinker, use TAC SDK OperationTracker
   * 2. Otherwise, check USDT balance on TAC for the recipient
   *
   * @param amount - Amount expected to be received
   * @param route - Bridge route (origin, destination, asset)
   * @param originTransaction - Origin transaction receipt (may be empty for TON transactions)
   * @param recipientOverride - Optional recipient address to check (preferred over originTransaction.to)
   */
  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    recipientOverride?: string,
  ): Promise<boolean> {
    this.logger.debug('Checking if TAC Inner Bridge transfer is ready', {
      amount,
      route,
      transactionHash: originTransaction?.transactionHash,
      recipientOverride,
    });

    try {
      // Get TAC EVM client
      const tacClient = this.getPublicClient(TAC_CHAIN_ID);

      // Get the TAC asset address for the bridged asset
      const tacAsset = this.getTacAssetAddress(route.asset);

      if (!tacAsset) {
        this.logger.warn('Could not find TAC asset address', {
          sourceAsset: route.asset,
          supportedAssets: Object.keys(TAC_BRIDGE_SUPPORTED_ASSETS),
        });
        return false;
      }

      // Get recipient address - prefer override, then originTransaction.to
      let recipient: `0x${string}` | undefined;
      if (recipientOverride && recipientOverride.startsWith('0x')) {
        recipient = recipientOverride as `0x${string}`;
      } else if (originTransaction?.to) {
        recipient = originTransaction.to as `0x${string}`;
      }

      if (!recipient) {
        this.logger.warn('No recipient address available for balance check', {
          recipientOverride,
          originTransactionTo: originTransaction?.to,
        });
        return false;
      }

      // Check balance on TAC
      const balance = await tacClient.readContract({
        address: tacAsset,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [recipient],
      });

      // IMPORTANT: Don't use simple balance check - it may return true if
      // the recipient already had sufficient balance before the operation.
      // Instead, check for actual Transfer events to the recipient.

      // Check for Transfer events to recipient in the last ~100 blocks
      // (TAC RPC has strict block range limits)
      const currentBlock = await tacClient.getBlockNumber();
      const fromBlock = currentBlock - 100n > 0n ? currentBlock - 100n : 0n;

      this.logger.debug('Checking TAC Transfer events', {
        tacAsset,
        recipient,
        fromBlock: fromBlock.toString(),
        toBlock: currentBlock.toString(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let logs: any[] = [];
      try {
        logs = await tacClient.getLogs({
          address: tacAsset,
          event: {
            type: 'event',
            name: 'Transfer',
            inputs: [
              { type: 'address', indexed: true, name: 'from' },
              { type: 'address', indexed: true, name: 'to' },
              { type: 'uint256', indexed: false, name: 'value' },
            ],
          },
          args: {
            to: recipient,
          },
          fromBlock,
          toBlock: 'latest',
        });
      } catch (logsError) {
        this.logger.warn('Failed to query TAC logs, falling back to balance check', {
          error: jsonifyError(logsError),
          tacAsset,
          recipient,
        });

        // Fallback: If we can't query logs, check if balance is sufficient
        // This is less accurate but better than failing completely
        const expectedAmount = BigInt(amount);
        const minAmount = (expectedAmount * 95n) / 100n; // 5% tolerance
        if (balance >= minAmount) {
          this.logger.info('TAC balance check passed (fallback)', {
            tacAsset,
            recipient,
            balance: balance.toString(),
            minAmount: minAmount.toString(),
          });
          return true;
        }
        return false;
      }

      // Check if any transfer matches our expected amount (within 5% tolerance for fees)
      const expectedAmount = BigInt(amount);
      const minAmount = (expectedAmount * 95n) / 100n; // 5% tolerance

      let matchingTransfer = false;
      for (const log of logs) {
        const transferAmount = log.args.value as bigint;
        this.logger.debug('Found TAC Transfer event', {
          tacAsset,
          recipient,
          transferAmount: transferAmount.toString(),
          expectedMinAmount: minAmount.toString(),
          txHash: log.transactionHash,
          blockNumber: log.blockNumber?.toString(),
        });

        if (transferAmount >= minAmount) {
          matchingTransfer = true;
          this.logger.info('Found matching Transfer event on TAC', {
            tacAsset,
            recipient,
            transferAmount: transferAmount.toString(),
            expectedAmount: amount,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber?.toString(),
          });
          break;
        }
      }

      // If we found a matching transfer event, we're done
      if (matchingTransfer) {
        this.logger.debug('TAC transfer event check result - COMPLETE', {
          tacAsset,
          recipient,
          currentBalance: balance.toString(),
          requiredAmount: amount,
          transferEventsFound: logs.length,
          matchingTransferFound: true,
          fromBlock: fromBlock.toString(),
          toBlock: currentBlock.toString(),
        });
        return true;
      }

      // Fallback: If no transfer events found in recent blocks but balance is sufficient,
      // mark as complete. This handles cases where the transfer happened too long ago
      // to be in the recent block window.
      const fallbackMinAmount = (expectedAmount * 95n) / 100n; // 5% tolerance (reuse expectedAmount from above)

      if (balance >= fallbackMinAmount) {
        this.logger.info('TAC transfer complete (balance check fallback)', {
          tacAsset,
          recipient,
          currentBalance: balance.toString(),
          requiredAmount: amount,
          fallbackMinAmount: fallbackMinAmount.toString(),
          transferEventsFound: logs.length,
          fromBlock: fromBlock.toString(),
          toBlock: currentBlock.toString(),
          note: 'No recent Transfer events but balance is sufficient',
        });
        return true;
      }

      this.logger.debug('TAC transfer event check result - NOT COMPLETE', {
        tacAsset,
        recipient,
        currentBalance: balance.toString(),
        requiredAmount: amount,
        fallbackMinAmount: fallbackMinAmount.toString(),
        transferEventsFound: logs.length,
        matchingTransferFound: false,
        fromBlock: fromBlock.toString(),
        toBlock: currentBlock.toString(),
        note: 'No matching transfer yet and balance insufficient',
      });

      return false;
    } catch (error) {
      this.logger.error('Failed to check TAC Inner Bridge status', {
        error: jsonifyError(error),
        amount,
        route,
        transactionHash: originTransaction?.transactionHash,
      });
      return false;
    }
  }

  /**
   * Get the TAC asset address for a given source asset
   * Maps from TON asset address to TAC EVM address
   */
  protected getTacAssetAddress(asset: string): `0x${string}` | undefined {
    // First check if it's already a TAC address (EVM format)
    if (asset.startsWith('0x') && asset.length === 42) {
      // Check if this is the known USDT address on TAC
      if (asset.toLowerCase() === USDT_TAC.toLowerCase()) {
        return USDT_TAC;
      }
      // Check against supported assets
      for (const [, addresses] of Object.entries(TAC_BRIDGE_SUPPORTED_ASSETS)) {
        if (addresses.tac.toLowerCase() === asset.toLowerCase()) {
          return addresses.tac as `0x${string}`;
        }
      }
    }

    // Check if it's a TON address - map to TAC address
    for (const [symbol, addresses] of Object.entries(TAC_BRIDGE_SUPPORTED_ASSETS)) {
      if (addresses.ton.toLowerCase() === asset.toLowerCase()) {
        this.logger.debug('Mapped TON asset to TAC', {
          symbol,
          tonAddress: asset,
          tacAddress: addresses.tac,
        });
        return addresses.tac as `0x${string}`;
      }
    }

    // Default to USDT on TAC if asset looks like USDT
    if (asset.toLowerCase().includes('usdt')) {
      return USDT_TAC;
    }

    return undefined;
  }

  /**
   * Get or create a public client for a chain
   * Falls back to TAC RPC providers if chain config is missing
   */
  protected getPublicClient(chainId: number): PublicClient {
    if (this.publicClients.has(chainId)) {
      return this.publicClients.get(chainId)!;
    }

    let providers = this.chains[chainId.toString()]?.providers ?? [];

    // Fall back to hardcoded TAC providers if not in config
    if (!providers.length && chainId === TAC_CHAIN_ID) {
      providers = TAC_RPC_PROVIDERS;
      this.logger.debug('Using fallback TAC RPC providers', { providers });
    }

    if (!providers.length) {
      throw new Error(`No providers found for chain ${chainId}`);
    }

    const client = createPublicClient({
      transport: fallback(providers.map((provider: string) => http(provider))),
    });

    this.publicClients.set(chainId, client);
    return client;
  }

  /**
   * Logs and rethrows errors with consistent context
   */
  protected handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(`Failed to ${context}: ${(error as any)?.message ?? ''}`);
  }
}
