import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { safeParseBigInt, getEvmBalance } from '../helpers';
import { jsonifyError } from '@mark/logger';
import {
  RebalanceOperationStatus,
  RebalanceAction,
  SupportedBridge,
  MAINNET_CHAIN_ID,
  SOLANA_CHAINID,
  getTokenAddressFromConfig,
  WalletType,
  SolanaRebalanceConfig,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import { SolanaSigner } from '@mark/chainservice';
import { createRebalanceOperation, TransactionReceipt } from '@mark/database';
import { submitTransactionWithLogging, TransactionSubmissionResult } from '../helpers/transactions';
import { RebalanceTransactionMemo, USDC_PTUSDE_PAIRS, CCIPBridgeAdapter, PendleBridgeAdapter } from '@mark/rebalance';
import { RebalanceRunState } from './types';
import { runThresholdRebalance, ThresholdRebalanceDescriptor } from './thresholdEngine';
import { runCallbackLoop, RebalanceOperation } from './callbackEngine';

// Ticker hash from chaindata/everclear.json for cross-chain asset matching
const USDC_TICKER_HASH = '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa';

// Token decimals on Solana
const PTUSDE_SOLANA_DECIMALS = 9; // PT-sUSDE has 9 decimals on Solana
const USDC_SOLANA_DECIMALS = 6; // USDC has 6 decimals on Solana
const PTUSDE_MAINNET_DECIMALS = 18; // PT-sUSDE has 18 decimals on Mainnet

/**
 * Get Solana rebalance configuration from context.
 * Config is loaded from environment variables or config file in @mark/core config.ts
 * with built-in defaults:
 * - SOLANA_PTUSDE_REBALANCE_ENABLED (default: true)
 * - SOLANA_PTUSDE_REBALANCE_THRESHOLD (default: 100 ptUSDe = "100000000000")
 * - SOLANA_PTUSDE_REBALANCE_TARGET (default: 500 ptUSDe = "500000000000")
 * - SOLANA_PTUSDE_REBALANCE_BRIDGE_SLIPPAGE_DBPS (default: 50 = 0.5%)
 * - SOLANA_PTUSDE_REBALANCE_BRIDGE_MIN_REBALANCE_AMOUNT (default: "1000000" = 1 USDC)
 * - SOLANA_PTUSDE_REBALANCE_BRIDGE_MAX_REBALANCE_AMOUNT (default: "100000000" = 100 USDC)
 */
function getSolanaRebalanceConfig(config: ProcessingContext['config']): SolanaRebalanceConfig {
  if (!config.solanaPtusdeRebalance) {
    throw new Error('solanaPtusdeRebalance config not found - this should be provided by @mark/core config loader');
  }
  return config.solanaPtusdeRebalance;
}

/**
 * Get the expected ptUSDe output for a given USDC input using Pendle API.
 *
 * @param pendleAdapter - Pendle bridge adapter instance
 * @param usdcAmount - USDC amount in 6 decimals
 * @param logger - Logger instance
 * @returns Expected ptUSDe output in 18 decimals (Mainnet), or null if quote fails
 */
async function getPtUsdeOutputForUsdc(
  pendleAdapter: PendleBridgeAdapter,
  usdcAmount: bigint,
  logger: ProcessingContext['logger'],
): Promise<bigint | null> {
  try {
    const tokenPair = USDC_PTUSDE_PAIRS[Number(MAINNET_CHAIN_ID)];
    if (!tokenPair) {
      logger.warn('USDC/ptUSDe pair not configured for mainnet');
      return null;
    }

    const pendleRoute = {
      asset: tokenPair.usdc,
      origin: Number(MAINNET_CHAIN_ID),
      destination: Number(MAINNET_CHAIN_ID),
      swapOutputAsset: tokenPair.ptUSDe,
    };

    // Get quote from Pendle API (returns ptUSDe in 18 decimals)
    const ptUsdeOutput = await pendleAdapter.getReceivedAmount(usdcAmount.toString(), pendleRoute);

    logger.debug('Pendle API quote received', {
      usdcInput: usdcAmount.toString(),
      ptUsdeOutput,
      route: pendleRoute,
    });

    return BigInt(ptUsdeOutput);
  } catch (error) {
    logger.warn('Failed to get Pendle quote', {
      error: jsonifyError(error),
      usdcAmount: usdcAmount.toString(),
    });
    return null;
  }
}

/**
 * Calculate required USDC to achieve target ptUSDe balance using Pendle pricing.
 * Returns null if Pendle API is unavailable - callers should skip rebalancing in this case.
 *
 * @param ptUsdeShortfall - Required ptUSDe in Solana decimals (9 decimals)
 * @param pendleAdapter - Pendle bridge adapter
 * @param logger - Logger instance
 * @returns Required USDC amount in 6 decimals, or null if Pendle API unavailable
 */
async function calculateRequiredUsdcForPtUsde(
  ptUsdeShortfall: bigint,
  pendleAdapter: PendleBridgeAdapter,
  logger: ProcessingContext['logger'],
): Promise<bigint | null> {
  // Convert Solana ptUSDe (9 decimals) to Mainnet ptUSDe (18 decimals) for calculation
  const ptUsdeShortfallMainnet = ptUsdeShortfall * BigInt(10 ** (PTUSDE_MAINNET_DECIMALS - PTUSDE_SOLANA_DECIMALS));

  // Estimate USDC amount using decimal conversion (ptUSDe 18 decimals → USDC 6 decimals)
  const estimatedUsdcAmount = ptUsdeShortfallMainnet / BigInt(10 ** (PTUSDE_MAINNET_DECIMALS - USDC_SOLANA_DECIMALS));

  // Get Pendle quote for the estimated amount to account for actual price impact at this size
  const ptUsdeOutput = await getPtUsdeOutputForUsdc(pendleAdapter, estimatedUsdcAmount, logger);

  if (ptUsdeOutput && ptUsdeOutput > 0n) {
    // If estimated USDC gives us ptUsdeOutput, we need: (shortfall / ptUsdeOutput) * estimatedUsdc
    const requiredUsdc = (ptUsdeShortfallMainnet * estimatedUsdcAmount) / ptUsdeOutput;

    logger.info('Calculated USDC requirement using Pendle API pricing', {
      ptUsdeShortfallSolana: ptUsdeShortfall.toString(),
      ptUsdeShortfallMainnet: ptUsdeShortfallMainnet.toString(),
      estimatedUsdcAmount: estimatedUsdcAmount.toString(),
      ptUsdeOutput: ptUsdeOutput.toString(),
      requiredUsdc: requiredUsdc.toString(),
      effectiveRate: (Number(ptUsdeOutput) / Number(estimatedUsdcAmount) / 1e12).toFixed(6),
    });

    return requiredUsdc;
  }

  // Pendle API unavailable - return null to signal failure
  logger.error('Pendle API unavailable - cannot calculate USDC requirement, skipping rebalancing', {
    ptUsdeShortfall: ptUsdeShortfall.toString(),
    ptUsdeShortfallMainnet: ptUsdeShortfallMainnet.toString(),
  });

  return null;
}

// Chainlink CCIP constants for Solana
// See: https://docs.chain.link/ccip/directory/mainnet/chain/solana-mainnet
const CCIP_ROUTER_PROGRAM_ID = new PublicKey('Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C');
const SOLANA_CHAIN_SELECTOR = '124615329519749607';
const ETHEREUM_CHAIN_SELECTOR = '5009297550715157269';
const USDC_SOLANA_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PTUSDE_SOLANA_MINT = new PublicKey('PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA');

/**
 * Get or create lookup table for CCIP transaction accounts
 * This ensures we can use versioned transactions while preserving account order
 */

type ExecuteBridgeContext = Pick<ProcessingContext, 'logger' | 'chainService' | 'config' | 'requestId' | 'rebalance'>;

interface SolanaToMainnetBridgeParams {
  context: ExecuteBridgeContext;
  solanaSigner: SolanaSigner;
  route: {
    origin: number;
    destination: number;
    asset: string;
  };
  amountToBridge: bigint;
  recipientAddress: string;
}

interface SolanaToMainnetBridgeResult {
  receipt?: TransactionReceipt;
  effectiveBridgedAmount: string;
  messageId?: string; // CCIP message ID for tracking cross-chain transfers
}

/**
 * Execute CCIP bridge transaction from Solana to Ethereum Mainnet
 *
 * IMPORTANT NOTES FOR PRODUCTION:
 * 1. The CCIP Router Program ID needs to be verified against Chainlink's official deployment
 * 2. The instruction format may need adjustment when official SDK is available
 * 3. Additional accounts (fee billing, token pools, etc.) may be required
 * 4. Consider using Anchor framework if CCIP program is built with Anchor
 */
async function executeSolanaToMainnetBridge({
  context,
  solanaSigner,
  route,
  amountToBridge,
  recipientAddress,
}: SolanaToMainnetBridgeParams): Promise<SolanaToMainnetBridgeResult> {
  const { logger, requestId } = context;

  try {
    logger.info('Preparing Solana to Mainnet CCIP bridge', {
      requestId,
      route,
      amountToBridge: amountToBridge.toString(),
      recipient: recipientAddress,
      solanaChainSelector: SOLANA_CHAIN_SELECTOR,
      ethereumChainSelector: ETHEREUM_CHAIN_SELECTOR,
    });

    // Use the SolanaSigner for connection and signing
    const connection = solanaSigner.getConnection();
    const walletPublicKey = solanaSigner.getPublicKey();

    logger.info('Solana wallet and connection initialized', {
      requestId,
      walletAddress: walletPublicKey.toBase58(),
      rpcUrl: connection.rpcEndpoint,
    });

    // Get associated token accounts
    const sourceTokenAccount = await getAssociatedTokenAddress(USDC_SOLANA_MINT, walletPublicKey);

    logger.info('Checking source token', { requestId, tokenAccount: sourceTokenAccount, walletPublicKey });

    // Verify USDC balance
    try {
      const tokenAccountInfo = await getAccount(connection, sourceTokenAccount);
      if (tokenAccountInfo.amount < amountToBridge) {
        throw new Error(
          `Insufficient USDC balance. Required: ${amountToBridge}, Available: ${tokenAccountInfo.amount}`,
        );
      }
      logger.info('USDC balance verified', {
        requestId,
        required: amountToBridge.toString(),
        available: tokenAccountInfo.amount.toString(),
      });
    } catch (error) {
      logger.error('Failed to verify USDC balance', {
        requestId,
        error: jsonifyError(error),
        sourceTokenAccount: sourceTokenAccount.toBase58(),
      });
      throw error;
    }

    logger.info('CCIP message prepared', {
      requestId,
      destinationChain: ETHEREUM_CHAIN_SELECTOR,
      tokenAmount: amountToBridge.toString(),
      recipient: recipientAddress,
    });

    const ccipAdapter = context.rebalance.getAdapter(SupportedBridge.CCIP) as CCIPBridgeAdapter;
    const ccipTx = await ccipAdapter.sendSolanaToMainnet(
      walletPublicKey.toBase58(),
      recipientAddress,
      amountToBridge.toString(),
      connection,
      new Wallet(solanaSigner.getKeypair()),
      route,
    );

    // Create transaction receipt
    const receipt: TransactionReceipt = {
      transactionHash: ccipTx.hash,
      status: 1, // Success if we got here
      blockNumber: ccipTx.blockNumber, // Will be filled in later when we get transaction details
      // ccipTx.logs can be readonly; clone to a mutable array to satisfy TransactionReceipt
      logs: [...(ccipTx.logs ?? [])] as unknown[],
      cumulativeGasUsed: '0', // Will be filled in later
      effectiveGasPrice: '0',
      from: walletPublicKey.toBase58(),
      to: CCIP_ROUTER_PROGRAM_ID.toBase58(),
      confirmations: undefined,
    };

    return {
      receipt,
      effectiveBridgedAmount: amountToBridge.toString(),
    };
  } catch (error) {
    logger.error('Failed to execute Solana CCIP bridge', {
      requestId,
      route,
      amountToBridge: amountToBridge.toString(),
      error: jsonifyError(error),
    });
    throw error;
  }
}

export async function rebalanceSolanaUsdc(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, chainService, rebalance, solanaSigner } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  logger.debug('Solana rebalancing initialized', {
    requestId,
    solanaConfigured: !!config.solana,
    signerConfigured: !!solanaSigner,
  });

  // Check if SolanaSigner is available
  if (!solanaSigner) {
    logger.warn('SolanaSigner not configured - Solana USDC rebalancing is disabled', {
      requestId,
      reason: 'Missing solana.privateKey in configuration',
      action: 'Configure SOLANA_PRIVATE_KEY in SSM Parameter Store to enable',
    });
    return rebalanceOperations;
  }

  // Always check destination callbacks to ensure operations complete
  await executeSolanaUsdcCallbacks(context);

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('Solana USDC Rebalance loop is paused', { requestId });
    return rebalanceOperations;
  }

  // Get configuration from config or use production defaults
  const solanaRebalanceConfig = getSolanaRebalanceConfig(config);
  if (!solanaRebalanceConfig?.enabled) {
    logger.warn('Solana PtUSDe Rebalance is not enabled', { requestId });
    return rebalanceOperations;
  }

  logger.info('Starting to rebalance Solana USDC', {
    requestId,
    solanaAddress: solanaSigner.getAddress(),
  });

  const minRebalanceAmount = safeParseBigInt(solanaRebalanceConfig.bridge.minRebalanceAmount);
  const maxRebalanceAmount = safeParseBigInt(solanaRebalanceConfig.bridge.maxRebalanceAmount);

  const solanaThresholdDescriptor: ThresholdRebalanceDescriptor = {
    name: 'Solana ptUSDe',

    isEnabled: () => true, // Already checked solanaRebalanceConfig.enabled above

    hasInFlightOperations: async () => {
      const { operations } = await context.database.getRebalanceOperations(undefined, undefined, {
        status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
        chainId: Number(SOLANA_CHAINID),
        bridge: 'ccip-solana-mainnet',
      });
      if (operations.length > 0) {
        logger.info('In-flight Solana rebalance operations exist, skipping new rebalance to prevent overlap', {
          requestId,
          inFlightCount: operations.length,
          inFlightOperationIds: operations.map((op) => op.id),
        });
      }
      return operations.length > 0;
    },

    getRecipientBalance: async () => {
      // Get ptUSDe balance on Solana (in native 9-decimal units)
      const connection = solanaSigner.getConnection();
      const walletPublicKey = solanaSigner.getPublicKey();
      const ptUsdeTokenAccount = await getAssociatedTokenAddress(PTUSDE_SOLANA_MINT, walletPublicKey);
      let balance = 0n;
      try {
        const ptUsdeAccountInfo = await getAccount(connection, ptUsdeTokenAccount);
        balance = ptUsdeAccountInfo.amount;
      } catch (accountError) {
        // Account might not exist if no ptUSDe has been received yet
        logger.info('ptUSDe token account does not exist or is empty', {
          requestId,
          walletAddress: walletPublicKey.toBase58(),
          ptUsdeTokenAccount: ptUsdeTokenAccount.toBase58(),
          error: jsonifyError(accountError),
        });
        return 0n;
      }
      logger.info('Retrieved Solana ptUSDe balance', {
        requestId,
        walletAddress: walletPublicKey.toBase58(),
        ptUsdeTokenAccount: ptUsdeTokenAccount.toBase58(),
        balance: balance.toString(),
        balanceInPtUsde: (Number(balance) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
      });
      return balance;
    },

    getThresholds: () => ({
      threshold: safeParseBigInt(solanaRebalanceConfig.ptUsdeThreshold),
      target: safeParseBigInt(solanaRebalanceConfig.ptUsdeTarget),
    }),

    convertShortfallToBridgeAmount: async (ptUsdeShortfall) => {
      // Convert ptUSDe shortfall (9 decimals) to USDC needed (6 decimals) via Pendle pricing
      logger.info('Converting ptUSDe shortfall to USDC via Pendle pricing', {
        requestId,
        ptUsdeShortfall: ptUsdeShortfall.toString(),
        ptUsdeShortfallFormatted: (Number(ptUsdeShortfall) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
      });
      const pendleAdapter = context.rebalance.getAdapter(SupportedBridge.Pendle) as PendleBridgeAdapter;
      const usdcNeeded = await calculateRequiredUsdcForPtUsde(ptUsdeShortfall, pendleAdapter, logger);
      if (usdcNeeded === null) {
        throw new Error('Cannot determine accurate USDC requirement without Pendle API');
      }
      logger.info('Pendle pricing: USDC required for ptUSDe shortfall', {
        requestId,
        ptUsdeShortfall: ptUsdeShortfall.toString(),
        usdcNeeded: usdcNeeded.toString(),
        usdcNeededFormatted: (Number(usdcNeeded) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
      });
      return usdcNeeded;
    },

    getSenderBalance: async () => {
      // Get Solana USDC balance (in native 6-decimal units)
      const connection = solanaSigner.getConnection();
      const walletPublicKey = solanaSigner.getPublicKey();
      const sourceTokenAccount = await getAssociatedTokenAddress(USDC_SOLANA_MINT, walletPublicKey);
      const tokenAccountInfo = await getAccount(connection, sourceTokenAccount);
      const balance = tokenAccountInfo.amount;
      logger.info('Retrieved Solana USDC balance for potential bridging', {
        requestId,
        walletAddress: walletPublicKey.toBase58(),
        tokenAccount: sourceTokenAccount.toBase58(),
        balance: balance.toString(),
        balanceInUsdc: (Number(balance) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
      });
      return balance;
    },

    getAmountCaps: () => ({
      min: minRebalanceAmount,
      max: maxRebalanceAmount > 0n ? maxRebalanceAmount : undefined,
    }),

    executeBridge: async (ctx, amountToBridge) => {
      if (!config.ownAddress) {
        throw new Error('Recipient address (config.ownAddress) not configured');
      }

      logger.info('Starting Leg 1: Solana to Mainnet CCIP bridge (threshold-based)', {
        requestId,
        amountToBridge: amountToBridge.toString(),
        amountToBridgeInUsdc: (Number(amountToBridge) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
        recipientAddress: config.ownAddress,
        trigger: 'threshold-based',
      });

      const solanaToMainnetRoute = {
        origin: Number(SOLANA_CHAINID),
        destination: Number(MAINNET_CHAIN_ID),
        asset: USDC_SOLANA_MINT.toString(),
      };

      const bridgeResult = await executeSolanaToMainnetBridge({
        context: { requestId, logger, config, chainService, rebalance: context.rebalance },
        solanaSigner,
        route: solanaToMainnetRoute,
        amountToBridge,
        recipientAddress: config.ownAddress,
      });

      if (!bridgeResult.receipt || bridgeResult.receipt.status !== 1) {
        throw new Error(`Bridge transaction failed: ${bridgeResult.receipt?.transactionHash || 'Unknown transaction'}`);
      }

      logger.info('Leg 1 bridge completed successfully', {
        requestId,
        transactionHash: bridgeResult.receipt.transactionHash,
        effectiveAmount: bridgeResult.effectiveBridgedAmount,
        blockNumber: bridgeResult.receipt.blockNumber,
      });

      await createRebalanceOperation({
        earmarkId: null,
        originChainId: Number(SOLANA_CHAINID),
        destinationChainId: Number(MAINNET_CHAIN_ID),
        tickerHash: USDC_TICKER_HASH,
        amount: bridgeResult.effectiveBridgedAmount,
        slippage: 1000,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'ccip-solana-mainnet',
        transactions: { [SOLANA_CHAINID]: bridgeResult.receipt },
        recipient: config.ownAddress,
      });

      return [
        {
          bridge: SupportedBridge.CCIP,
          amount: bridgeResult.effectiveBridgedAmount,
          origin: Number(SOLANA_CHAINID),
          destination: Number(MAINNET_CHAIN_ID),
          asset: USDC_SOLANA_MINT.toString(),
          transaction: bridgeResult.receipt.transactionHash,
          recipient: config.ownAddress,
        },
      ];
    },
  };

  const ptUsdeThreshold = safeParseBigInt(solanaRebalanceConfig.ptUsdeThreshold);
  const ptUsdeTarget = safeParseBigInt(solanaRebalanceConfig.ptUsdeTarget);

  logger.info('Solana ptUSDe rebalance configuration', {
    requestId,
    ptUsdeThreshold: ptUsdeThreshold.toString(),
    ptUsdeThresholdFormatted: (Number(ptUsdeThreshold) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
    ptUsdeTarget: ptUsdeTarget.toString(),
    ptUsdeTargetFormatted: (Number(ptUsdeTarget) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
    minRebalanceAmount: minRebalanceAmount.toString(),
    minRebalanceAmountFormatted: (Number(minRebalanceAmount) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
    maxRebalanceAmount: maxRebalanceAmount.toString(),
    maxRebalanceAmountFormatted:
      maxRebalanceAmount > 0n ? (Number(maxRebalanceAmount) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6) : 'unlimited',
    configSource: config.solanaPtusdeRebalance ? 'explicit' : 'defaults',
  });

  const runState: RebalanceRunState = { committedAmount: 0n };
  const thresholdActions = await runThresholdRebalance(context, solanaThresholdDescriptor, runState);
  rebalanceOperations.push(...thresholdActions);

  logger.info('Completed rebalancing Solana USDC', {
    requestId,
    operationCount: rebalanceOperations.length,
  });

  return rebalanceOperations;
}

export const executeSolanaUsdcCallbacks = async (context: ProcessingContext): Promise<void> => {
  return runCallbackLoop(context, {
    name: 'Solana USDC',
    bridge: 'ccip-solana-mainnet',
    statuses: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
    timeoutStatus: RebalanceOperationStatus.EXPIRED,
    processOperation: (operation, ctx) => processSolanaOperation(operation, ctx),
  });
};

/**
 * Process a single in-flight Solana USDC operation through its state machine.
 * Dispatches to leg-specific handlers based on operation status.
 */
async function processSolanaOperation(operation: RebalanceOperation, context: ProcessingContext): Promise<void> {
  if (operation.status === RebalanceOperationStatus.PENDING) {
    await processLeg1Completion(operation, context);
  } else if (operation.status === RebalanceOperationStatus.AWAITING_CALLBACK) {
    await checkLeg3Completion(operation, context);
  }
}

/**
 * Leg 1 completion: Check if Solana→Mainnet CCIP bridge completed.
 * On success, executes Leg 2 (USDC→ptUSDe swap) and Leg 3 (ptUSDe→Solana CCIP).
 */
async function processLeg1Completion(operation: RebalanceOperation, context: ProcessingContext): Promise<void> {
  const { logger, requestId, database: db } = context;
  const logContext = {
    requestId,
    operationId: operation.id,
    earmarkId: operation.earmarkId,
    originChain: operation.originChainId,
    destinationChain: operation.destinationChainId,
  };

  if (operation.originChainId !== Number(SOLANA_CHAINID) || operation.destinationChainId !== Number(MAINNET_CHAIN_ID)) {
    return;
  }

  logger.info('Checking if CCIP bridge completed and USDC arrived on Mainnet', {
    ...logContext,
    bridge: operation.bridge,
    amount: operation.amount,
  });

  // Get the Solana transaction hash from the stored receipt
  const solanaTransactionHash = operation.transactions?.[SOLANA_CHAINID]?.transactionHash;
  if (!solanaTransactionHash) {
    logger.warn('No Solana transaction hash found for CCIP operation', {
      ...logContext,
      transactions: operation.transactions,
    });
    return;
  }

  // Use CCIP adapter to check transaction status
  const ccipAdapter = context.rebalance.getAdapter(SupportedBridge.CCIP) as CCIPBridgeAdapter;
  const ccipStatus = await ccipAdapter.getTransferStatus(
    solanaTransactionHash,
    Number(SOLANA_CHAINID),
    Number(MAINNET_CHAIN_ID),
  );

  const createdAt = operation.createdAt ? new Date(operation.createdAt).getTime() : Date.now();
  const timeSinceCreation = new Date().getTime() - createdAt;

  logger.info('CCIP bridge status check', {
    ...logContext,
    solanaTransactionHash,
    ccipStatus: ccipStatus.status,
    ccipMessage: ccipStatus.message,
    destinationTransactionHash: ccipStatus.destinationTransactionHash,
    timeSinceCreation,
  });

  if (ccipStatus.status === 'SUCCESS') {
    // IDEMPOTENCY CHECK: Check if we already have a Mainnet transaction hash
    // which would indicate Leg 2/3 have already been executed
    const existingMainnetTx = operation.transactions?.[MAINNET_CHAIN_ID]?.transactionHash;
    if (existingMainnetTx) {
      logger.info('Leg 2/3 already executed (Mainnet tx hash exists), skipping duplicate execution', {
        ...logContext,
        existingMainnetTx,
        solanaTransactionHash,
      });
      return;
    }

    logger.info('CCIP bridge completed successfully, initiating Leg 2: USDC → ptUSDe swap', {
      ...logContext,
      solanaTransactionHash,
      proceedingToLeg2: true,
    });

    // Update operation to AWAITING_CALLBACK to indicate Leg 1 is done, Leg 2 starting
    await db.updateRebalanceOperation(operation.id, {
      status: RebalanceOperationStatus.AWAITING_CALLBACK,
    });

    // Execute Legs 2 and 3
    await executeLeg2And3(operation, context, logContext);
  } else if (ccipStatus.status === 'FAILURE') {
    logger.error('CCIP bridge transaction failed', {
      ...logContext,
      solanaTransactionHash,
      ccipMessage: ccipStatus.message,
      shouldRetry: false,
    });

    await db.updateRebalanceOperation(operation.id, {
      status: RebalanceOperationStatus.FAILED,
    });

    logger.info('Marked operation as FAILED due to CCIP bridge failure', {
      ...logContext,
      note: 'Leg 1 CCIP bridge failed - funds may still be on Solana',
    });
  } else {
    // CCIP still pending
    const twentyMinutesMs = 20 * 60 * 1000;

    if (timeSinceCreation > twentyMinutesMs) {
      logger.warn('CCIP bridge taking longer than expected', {
        ...logContext,
        solanaTransactionHash,
        timeSinceCreation,
        expectedMaxTime: twentyMinutesMs,
        ccipStatus: ccipStatus.status,
        ccipMessage: ccipStatus.message,
        shouldInvestigate: true,
      });
    } else {
      logger.debug('CCIP bridge still pending within expected timeframe', {
        ...logContext,
        solanaTransactionHash,
        timeSinceCreation,
        remainingTime: twentyMinutesMs - timeSinceCreation,
        ccipStatus: ccipStatus.status,
      });
    }
  }
}

/**
 * Execute Leg 2 (Mainnet USDC → ptUSDe via Pendle) and Leg 3 (ptUSDe → Solana via CCIP).
 */
async function executeLeg2And3(
  operation: RebalanceOperation,
  context: ProcessingContext,
  logContext: Record<string, unknown>,
): Promise<void> {
  const { logger, requestId, database: db, rebalance, config: rebalanceConfig, chainService } = context;

  try {
    logger.info('Executing Leg 2: Mainnet USDC → ptUSDe via Pendle adapter', logContext);

    // Get the Pendle adapter
    const pendleAdapter = rebalance.getAdapter(SupportedBridge.Pendle);
    if (!pendleAdapter) {
      logger.error('Pendle adapter not found', logContext);
      return;
    }

    // Get USDC address on mainnet for the swap
    const usdcAddress = getTokenAddressFromConfig(USDC_TICKER_HASH, MAINNET_CHAIN_ID.toString(), rebalanceConfig);
    if (!usdcAddress) {
      logger.error('Could not find USDC address for mainnet', logContext);
      return;
    }

    const storedRecipient = operation.recipient;
    const recipient = storedRecipient || rebalanceConfig.ownAddress;

    // Get ptUSDe address from the USDC_PTUSDE_PAIRS config
    const tokenPair = USDC_PTUSDE_PAIRS[Number(MAINNET_CHAIN_ID)];
    if (!tokenPair?.ptUSDe) {
      logger.error('ptUSDe address not configured for mainnet in USDC_PTUSDE_PAIRS', logContext);
      await db.updateRebalanceOperation(operation.id, {
        status: RebalanceOperationStatus.CANCELLED,
      });
      return;
    }

    const ptUsdeAddress = tokenPair.ptUSDe;

    // Use actual USDC balance on Mainnet instead of operation.amount to account for
    // potential differences from CCIP fees or rounding during the cross-chain transfer
    let swapAmount = operation.amount;
    try {
      const usdcBalance = await getEvmBalance(
        rebalanceConfig,
        MAINNET_CHAIN_ID.toString(),
        recipient,
        usdcAddress,
        USDC_SOLANA_DECIMALS,
        context.prometheus,
      );
      const operationAmount = safeParseBigInt(operation.amount);
      if (usdcBalance < operationAmount) {
        logger.warn('Actual USDC balance on Mainnet is less than operation amount (CCIP fees/rounding)', {
          ...logContext,
          operationAmount: operation.amount,
          actualBalance: usdcBalance.toString(),
          difference: (operationAmount - usdcBalance).toString(),
        });
        swapAmount = usdcBalance.toString();
      }
    } catch (balanceError) {
      logger.warn('Failed to check actual USDC balance on Mainnet, using operation amount', {
        ...logContext,
        error: jsonifyError(balanceError),
        fallbackAmount: operation.amount,
      });
    }

    logger.debug('Leg 2 Pendle swap details', {
      ...logContext,
      storedRecipient,
      fallbackRecipient: rebalanceConfig.ownAddress,
      finalRecipient: recipient,
      usdcAddress,
      ptUsdeAddress,
      amountToSwap: swapAmount,
    });

    // Create route for USDC → ptUSDe swap on mainnet (same chain swap)
    const pendleRoute = {
      asset: usdcAddress,
      origin: Number(MAINNET_CHAIN_ID),
      destination: Number(MAINNET_CHAIN_ID),
      swapOutputAsset: ptUsdeAddress,
    };

    // Get quote from Pendle for USDC → ptUSDe
    const receivedAmountStr = await pendleAdapter.getReceivedAmount(swapAmount, pendleRoute);

    logger.info('Received Pendle quote for USDC → ptUSDe swap', {
      ...logContext,
      amountToSwap: swapAmount,
      expectedPtUsde: receivedAmountStr,
      route: pendleRoute,
    });

    // Execute the Pendle swap transactions
    const swapTxRequests = await pendleAdapter.send(recipient, recipient, swapAmount, pendleRoute);

    if (!swapTxRequests.length) {
      logger.error('No swap transactions returned from Pendle adapter', logContext);
      return;
    }

    logger.info('Executing Pendle USDC → ptUSDe swap transactions', {
      ...logContext,
      transactionCount: swapTxRequests.length,
      recipient,
    });

    let effectivePtUsdeAmount = receivedAmountStr;

    for (const { transaction, memo, effectiveAmount } of swapTxRequests) {
      logger.info('Submitting Pendle swap transaction', {
        requestId,
        memo,
        transaction,
      });

      const result = await submitTransactionWithLogging({
        chainService,
        logger,
        chainId: MAINNET_CHAIN_ID.toString(),
        txRequest: {
          to: transaction.to!,
          data: transaction.data!,
          value: (transaction.value || 0).toString(),
          chainId: Number(MAINNET_CHAIN_ID),
          from: rebalanceConfig.ownAddress,
          funcSig: transaction.funcSig || '',
        },
        zodiacConfig: {
          walletType: WalletType.EOA,
        },
        context: { requestId, route: pendleRoute, bridgeType: SupportedBridge.Pendle, transactionType: memo },
      });

      logger.info('Successfully submitted Pendle swap transaction', {
        requestId,
        memo,
        transactionHash: result.hash,
      });

      if (memo === RebalanceTransactionMemo.Rebalance && effectiveAmount) {
        effectivePtUsdeAmount = effectiveAmount;
      }
    }

    // Execute Leg 3: ptUSDe → Solana CCIP immediately after Leg 2
    logger.info('Executing Leg 3: Mainnet ptUSDe → Solana via CCIP adapter', logContext);

    const ccipAdapter = rebalance.getAdapter(SupportedBridge.CCIP);

    const ccipRoute = {
      asset: ptUsdeAddress,
      origin: Number(MAINNET_CHAIN_ID),
      destination: Number(SOLANA_CHAINID),
    };

    const solanaRecipient = context.solanaSigner?.getAddress();
    if (!solanaRecipient) throw new Error('Solana signer address unavailable for CCIP leg 3');

    const ccipTxRequests = await ccipAdapter.send(recipient, solanaRecipient, effectivePtUsdeAmount, ccipRoute);

    let leg3CcipTx: TransactionSubmissionResult | undefined;

    for (const { transaction, memo } of ccipTxRequests) {
      logger.info('Submitting CCIP ptUSDe → Solana transaction', {
        requestId,
        memo,
        transaction,
      });

      const result = await submitTransactionWithLogging({
        chainService,
        logger,
        chainId: MAINNET_CHAIN_ID.toString(),
        txRequest: {
          to: transaction.to!,
          data: transaction.data!,
          value: (transaction.value || 0).toString(),
          chainId: Number(MAINNET_CHAIN_ID),
          from: rebalanceConfig.ownAddress,
          funcSig: transaction.funcSig || '',
        },
        zodiacConfig: {
          walletType: WalletType.EOA,
        },
        context: { requestId, route: ccipRoute, bridgeType: SupportedBridge.CCIP, transactionType: memo },
      });

      logger.info('Successfully submitted CCIP transaction', {
        requestId,
        memo,
        transactionHash: result.hash,
      });

      if (memo === RebalanceTransactionMemo.Rebalance) {
        leg3CcipTx = result;
      }
    }

    // Update operation with Leg 3 CCIP transaction hash for status tracking
    if (leg3CcipTx) {
      const leg3Receipt: TransactionReceipt = leg3CcipTx.receipt!;

      await db.updateRebalanceOperation(operation.id, {
        txHashes: { [MAINNET_CHAIN_ID]: leg3Receipt },
      });

      logger.info('Stored Leg 3 CCIP transaction hash for status tracking', {
        requestId,
        operationId: operation.id,
        leg3CcipTxHash: leg3CcipTx.hash,
      });
    }

    logger.info('Legs 1, 2, and 3 submitted successfully', {
      ...logContext,
      ptUsdeAmount: effectivePtUsdeAmount,
      note: 'Leg 1: Done, Leg 2: Done, Leg 3: CCIP submitted, waiting for completion',
      status: 'AWAITING_CALLBACK',
    });
  } catch (pendleError) {
    logger.error('Failed to execute Leg 2/3', {
      ...logContext,
      error: jsonifyError(pendleError),
    });

    await db.updateRebalanceOperation(operation.id, {
      status: RebalanceOperationStatus.CANCELLED,
    });

    logger.info('Marked operation as CANCELLED due to Leg 2/3 failure', {
      ...logContext,
      note: 'Funds are on Mainnet as USDC or ptUSDe (depending on which leg failed) - manual intervention required',
    });
  }
}

/**
 * Check if Leg 3 (ptUSDe → Solana CCIP) has completed.
 * Operations in AWAITING_CALLBACK status have Legs 1+2 done, waiting for Leg 3 CCIP.
 */
async function checkLeg3Completion(operation: RebalanceOperation, context: ProcessingContext): Promise<void> {
  const { logger, requestId, database: db } = context;
  const logContext = {
    requestId,
    operationId: operation.id,
    earmarkId: operation.earmarkId,
    originChain: operation.originChainId,
    destinationChain: operation.destinationChainId,
  };

  logger.info('Checking Leg 3 CCIP completion (ptUSDe → Solana)', logContext);

  // Get Leg 3 CCIP transaction hash from mainnet transactions
  const mainnetTransactionHash = operation.transactions?.[MAINNET_CHAIN_ID]?.transactionHash;
  if (!mainnetTransactionHash) {
    logger.warn('No Leg 3 CCIP transaction hash found', {
      ...logContext,
      transactions: operation.transactions,
    });
    return;
  }

  // Check if Leg 3 CCIP (ptUSDe → Solana) is ready on destination
  const ccipAdapter = context.rebalance.getAdapter(SupportedBridge.CCIP) as CCIPBridgeAdapter;

  const leg3Route = {
    origin: Number(MAINNET_CHAIN_ID),
    destination: Number(SOLANA_CHAINID),
    asset: '',
  };

  const isLeg3Ready = await ccipAdapter.readyOnDestination('0', leg3Route, {
    transactionHash: mainnetTransactionHash,
    status: 'success',
  } as ViemTransactionReceipt);

  logger.info('Leg 3 CCIP readiness check', {
    ...logContext,
    mainnetTransactionHash,
    isReady: isLeg3Ready,
    route: leg3Route,
  });

  if (isLeg3Ready) {
    await db.updateRebalanceOperation(operation.id, {
      status: RebalanceOperationStatus.COMPLETED,
    });

    logger.info('All 3 legs completed successfully', {
      ...logContext,
      mainnetTransactionHash,
      finalStatus: 'COMPLETED',
    });
  } else {
    logger.debug('Leg 3 CCIP still pending', {
      ...logContext,
      mainnetTransactionHash,
      note: 'Waiting for ptUSDe → Solana CCIP to complete',
    });
  }
}
