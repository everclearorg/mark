import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { safeParseBigInt } from '../helpers';
import { jsonifyError } from '@mark/logger';
import {
  RebalanceOperationStatus,
  RebalanceAction,
  SupportedBridge,
  MAINNET_CHAIN_ID,
  SOLANA_CHAINID,
  getTokenAddressFromConfig,
  WalletType,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import { SolanaSigner } from '@mark/chainservice';
import { createRebalanceOperation, TransactionReceipt } from '@mark/database';
import { submitTransactionWithLogging, TransactionSubmissionResult } from '../helpers/transactions';
import { RebalanceTransactionMemo, USDC_PTUSDE_PAIRS, CCIPBridgeAdapter } from '@mark/rebalance';

// Ticker hash from chaindata/everclear.json for cross-chain asset matching
const USDC_TICKER_HASH = '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa';

// Token decimals on Solana
const PTUSDE_SOLANA_DECIMALS = 9; // PT-sUSDE has 9 decimals on Solana
const USDC_SOLANA_DECIMALS = 6; // USDC has 6 decimals on Solana

// Decimal conversion factor from ptUSDe (9 decimals) to USDC (6 decimals)
const PTUSDE_TO_USDC_DIVISOR = BigInt(10 ** (PTUSDE_SOLANA_DECIMALS - USDC_SOLANA_DECIMALS)); // 10^3 = 1000

// Minimum rebalancing amount (1 USDC in 6 decimals)
const MIN_REBALANCING_AMOUNT = 1_000_000n; // 1 USDC

// Default operation timeout: 24 hours (in minutes)
const DEFAULT_OPERATION_TTL_MINUTES = 24 * 60;

// ============================================================================
// TESTING DEFAULTS - TODO: Update these values for production
// ============================================================================
// For testing, we use low thresholds (5 tokens) to trigger rebalancing easily.
// Production values should be significantly higher based on expected volumes.
//
// Environment variables to override:
//   - PTUSDE_SOLANA_THRESHOLD: Minimum ptUSDe balance before rebalancing (9 decimals)
//   - PTUSDE_SOLANA_TARGET: Target ptUSDe balance after rebalancing (9 decimals)
//   - SOLANA_USDC_MAX_REBALANCE_AMOUNT: Maximum USDC per rebalance operation (6 decimals)
//
// ============================================================================
const DEFAULT_PTUSDE_THRESHOLD = 5n * BigInt(10 ** PTUSDE_SOLANA_DECIMALS); // 5 ptUSDe for testing
const DEFAULT_PTUSDE_TARGET = 10n * BigInt(10 ** PTUSDE_SOLANA_DECIMALS); // 10 ptUSDe for testing
const DEFAULT_MAX_REBALANCE_AMOUNT = 10n * BigInt(10 ** USDC_SOLANA_DECIMALS); // 10 USDC for testing

/**
 * Check if an operation has exceeded its TTL (time-to-live).
 * Operations stuck in PENDING or AWAITING_CALLBACK for too long should be marked as failed.
 *
 * @param createdAt - Operation creation timestamp
 * @param ttlMinutes - TTL in minutes (default: 24 hours)
 * @returns true if operation has timed out
 */
function isOperationTimedOut(createdAt: Date, ttlMinutes: number = DEFAULT_OPERATION_TTL_MINUTES): boolean {
  const maxAgeMs = ttlMinutes * 60 * 1000;
  const operationAgeMs = Date.now() - createdAt.getTime();
  return operationAgeMs > maxAgeMs;
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

  logger.info('Starting to rebalance Solana USDC', {
    requestId,
    solanaAddress: solanaSigner.getAddress(),
  });

  // Check solver's ptUSDe balance directly on Solana to determine if rebalancing is needed
  let solanaPtUsdeBalance: bigint = 0n;
  try {
    const connection = solanaSigner.getConnection();
    const walletPublicKey = solanaSigner.getPublicKey();

    const ptUsdeTokenAccount = await getAssociatedTokenAddress(PTUSDE_SOLANA_MINT, walletPublicKey);

    try {
      const ptUsdeAccountInfo = await getAccount(connection, ptUsdeTokenAccount);
      solanaPtUsdeBalance = ptUsdeAccountInfo.amount;
    } catch (accountError) {
      // Account might not exist if no ptUSDe has been received yet
      logger.info('ptUSDe token account does not exist or is empty', {
        requestId,
        walletAddress: walletPublicKey.toBase58(),
        ptUsdeTokenAccount: ptUsdeTokenAccount.toBase58(),
        error: jsonifyError(accountError),
      });
      solanaPtUsdeBalance = 0n;
    }

    logger.info('Retrieved Solana ptUSDe balance', {
      requestId,
      walletAddress: walletPublicKey.toBase58(),
      ptUsdeTokenAccount: ptUsdeTokenAccount.toBase58(),
      balance: solanaPtUsdeBalance.toString(),
      balanceInPtUsde: (Number(solanaPtUsdeBalance) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
    });
  } catch (error) {
    logger.error('Failed to retrieve Solana ptUSDe balance', {
      requestId,
      error: jsonifyError(error),
    });
    // Continue with 0 balance - this will trigger rebalancing if USDC is available
    solanaPtUsdeBalance = 0n;
  }

  // Get Solana USDC balance - this is what we'll bridge if ptUSDe is low
  let solanaUsdcBalance: bigint = 0n;
  try {
    const connection = solanaSigner.getConnection();
    const walletPublicKey = solanaSigner.getPublicKey();

    const sourceTokenAccount = await getAssociatedTokenAddress(USDC_SOLANA_MINT, walletPublicKey);

    const tokenAccountInfo = await getAccount(connection, sourceTokenAccount);
    solanaUsdcBalance = tokenAccountInfo.amount;

    logger.info('Retrieved Solana USDC balance for potential bridging', {
      requestId,
      walletAddress: walletPublicKey.toBase58(),
      tokenAccount: sourceTokenAccount.toBase58(),
      balance: solanaUsdcBalance.toString(),
      balanceInUsdc: (Number(solanaUsdcBalance) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
    });
  } catch (error) {
    logger.error('Failed to retrieve Solana USDC balance', {
      requestId,
      error: jsonifyError(error),
    });
    return rebalanceOperations;
  }

  if (solanaUsdcBalance === 0n) {
    logger.info('No Solana USDC balance available for bridging, skipping rebalancing', { requestId });
    return rebalanceOperations;
  }

  // Values should be in native units (9 decimals for ptUSDe, 6 decimals for USDC)
  const ptUsdeThresholdEnv = process.env['PTUSDE_SOLANA_THRESHOLD'];
  const ptUsdeTargetEnv = process.env['PTUSDE_SOLANA_TARGET'];
  const maxRebalanceAmountEnv = process.env['SOLANA_USDC_MAX_REBALANCE_AMOUNT'];

  // TODO: Update defaults for production - current values are for testing
  // Threshold: minimum ptUSDe balance that triggers rebalancing (in 9 decimals for Solana ptUSDe)
  const ptUsdeThreshold = ptUsdeThresholdEnv ? safeParseBigInt(ptUsdeThresholdEnv) : DEFAULT_PTUSDE_THRESHOLD;

  // Target: desired ptUSDe balance after rebalancing (in 9 decimals for Solana ptUSDe)
  const ptUsdeTarget = ptUsdeTargetEnv ? safeParseBigInt(ptUsdeTargetEnv) : DEFAULT_PTUSDE_TARGET;

  // Max rebalance amount per operation (in 6 decimals for USDC)
  const maxRebalanceAmount = maxRebalanceAmountEnv
    ? safeParseBigInt(maxRebalanceAmountEnv)
    : DEFAULT_MAX_REBALANCE_AMOUNT;

  logger.info('Checking ptUSDe balance threshold for rebalancing decision', {
    requestId,
    ptUsdeBalance: solanaPtUsdeBalance.toString(),
    ptUsdeBalanceFormatted: (Number(solanaPtUsdeBalance) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
    ptUsdeThreshold: ptUsdeThreshold.toString(),
    ptUsdeThresholdFormatted: (Number(ptUsdeThreshold) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
    ptUsdeTarget: ptUsdeTarget.toString(),
    ptUsdeTargetFormatted: (Number(ptUsdeTarget) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
    shouldTriggerRebalance: solanaPtUsdeBalance < ptUsdeThreshold,
    availableSolanaUsdc: solanaUsdcBalance.toString(),
    availableSolanaUsdcFormatted: (Number(solanaUsdcBalance) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
    isTestingDefaults: !ptUsdeThresholdEnv && !ptUsdeTargetEnv,
  });

  if (solanaPtUsdeBalance >= ptUsdeThreshold) {
    logger.info('ptUSDe balance is above threshold, no rebalancing needed', {
      requestId,
      ptUsdeBalance: solanaPtUsdeBalance.toString(),
      ptUsdeThreshold: ptUsdeThreshold.toString(),
    });
    return rebalanceOperations;
  }

  // Calculate how much USDC to bridge based on ptUSDe deficit and available Solana USDC
  const ptUsdeShortfall = ptUsdeTarget - solanaPtUsdeBalance;

  // If balance is already at or above target, no bridging needed
  if (ptUsdeShortfall <= 0n) {
    logger.info('ptUSDe balance is at or above target, no bridging needed', {
      requestId,
      solanaPtUsdeBalance: solanaPtUsdeBalance.toString(),
      solanaPtUsdeBalanceFormatted: (Number(solanaPtUsdeBalance) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
      ptUsdeTarget: ptUsdeTarget.toString(),
      ptUsdeTargetFormatted: (Number(ptUsdeTarget) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
    });
    return rebalanceOperations;
  }

  // Approximate 1:1 ratio between USDC and ptUSDe for initial calculation
  const usdcNeeded = ptUsdeShortfall / PTUSDE_TO_USDC_DIVISOR;

  // Calculate amount to bridge: min(shortfall, available balance, max per operation)
  let amountToBridge = usdcNeeded;
  if (amountToBridge > solanaUsdcBalance) {
    amountToBridge = solanaUsdcBalance;
  }
  if (amountToBridge > maxRebalanceAmount) {
    amountToBridge = maxRebalanceAmount;
  }

  // Check minimum rebalancing amount
  if (amountToBridge < MIN_REBALANCING_AMOUNT) {
    logger.warn('Calculated bridge amount is below minimum threshold, skipping rebalancing', {
      requestId,
      calculatedAmount: amountToBridge.toString(),
      calculatedAmountFormatted: (Number(amountToBridge) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
      minAmount: MIN_REBALANCING_AMOUNT.toString(),
      minAmountFormatted: (Number(MIN_REBALANCING_AMOUNT) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
      reason: 'Calculated bridge amount too small to be effective',
    });
    return rebalanceOperations;
  }

  logger.info('Calculated bridge amount based on ptUSDe deficit and available balance', {
    requestId,
    balanceChecks: {
      ptUsdeShortfall: ptUsdeShortfall.toString(),
      ptUsdeShortfallFormatted: (Number(ptUsdeShortfall) / 10 ** PTUSDE_SOLANA_DECIMALS).toFixed(6),
      usdcNeeded: usdcNeeded.toString(),
      usdcNeededFormatted: (Number(usdcNeeded) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
      availableSolanaUsdc: solanaUsdcBalance.toString(),
      availableSolanaUsdcFormatted: (Number(solanaUsdcBalance) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
      maxRebalanceAmount: maxRebalanceAmount.toString(),
      maxRebalanceAmountFormatted: (Number(maxRebalanceAmount) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
    },
    bridgeDecision: {
      finalAmountToBridge: amountToBridge.toString(),
      finalAmountToBridgeFormatted: (Number(amountToBridge) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
      isPartialBridge: solanaUsdcBalance < usdcNeeded,
      utilizationPercentage: ((Number(amountToBridge) / Number(solanaUsdcBalance)) * 100).toFixed(2) + '%',
    },
  });

  // Check for in-flight operations to prevent overlapping rebalances
  const { operations: inFlightSolanaOps } = await context.database.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
    chainId: Number(SOLANA_CHAINID),
    bridge: 'ccip-solana-mainnet',
  });

  if (inFlightSolanaOps.length > 0) {
    logger.info('In-flight Solana rebalance operations exist, skipping new rebalance to prevent overlap', {
      requestId,
      inFlightCount: inFlightSolanaOps.length,
      inFlightOperationIds: inFlightSolanaOps.map((op) => op.id),
    });
    return rebalanceOperations;
  }

  // Prepare route for Solana to Mainnet bridge
  const solanaToMainnetRoute = {
    origin: Number(SOLANA_CHAINID),
    destination: Number(MAINNET_CHAIN_ID),
    asset: USDC_SOLANA_MINT.toString(),
  };

  logger.info('Starting Leg 1: Solana to Mainnet CCIP bridge (threshold-based)', {
    requestId,
    route: solanaToMainnetRoute,
    amountToBridge: amountToBridge.toString(),
    amountToBridgeInUsdc: (Number(amountToBridge) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
    recipientAddress: config.ownAddress,
    trigger: 'threshold-based',
    ptUsdeBalance: solanaPtUsdeBalance.toString(),
    ptUsdeThreshold: ptUsdeThreshold.toString(),
  });

  try {
    // Pre-flight checks
    if (!config.ownAddress) {
      throw new Error('Recipient address (config.ownAddress) not configured');
    }

    // Validate balance
    if (solanaUsdcBalance < amountToBridge) {
      throw new Error(
        `Insufficient Solana USDC balance. Required: ${amountToBridge.toString()}, Available: ${solanaUsdcBalance.toString()}`,
      );
    }

    logger.info('Performing pre-bridge validation checks', {
      requestId,
      trigger: 'threshold-based',
      checks: {
        solanaUsdcBalance: solanaUsdcBalance.toString(),
        solanaUsdcBalanceFormatted: (Number(solanaUsdcBalance) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
        amountToBridge: amountToBridge.toString(),
        amountToBridgeFormatted: (Number(amountToBridge) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
        hasSufficientBalance: solanaUsdcBalance >= amountToBridge,
        recipientValid: !!config.ownAddress,
        recipient: config.ownAddress,
      },
    });

    // Execute Leg 1: Solana to Mainnet bridge
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
      solanaSlot: bridgeResult.receipt.blockNumber,
    });

    // Create rebalance operation record for tracking all 3 legs (no earmark for threshold-based)
    try {
      await createRebalanceOperation({
        earmarkId: null, // No earmark for threshold-based rebalancing
        originChainId: Number(SOLANA_CHAINID),
        destinationChainId: Number(MAINNET_CHAIN_ID),
        tickerHash: USDC_TICKER_HASH,
        amount: bridgeResult.effectiveBridgedAmount,
        slippage: 1000, // 1% slippage
        status: RebalanceOperationStatus.PENDING, // pending as CCIP takes 20 mins to bridge
        bridge: 'ccip-solana-mainnet',
        transactions: { [SOLANA_CHAINID]: bridgeResult.receipt },
        recipient: config.ownAddress,
      });

      logger.info('Rebalance operation record created for Leg 1', {
        requestId,
        operationStatus: RebalanceOperationStatus.PENDING,
        note: 'Status is PENDING because CCIP takes ~20 minutes to complete',
      });

      const rebalanceAction: RebalanceAction = {
        bridge: SupportedBridge.CCIP,
        amount: bridgeResult.effectiveBridgedAmount,
        origin: Number(SOLANA_CHAINID),
        destination: Number(MAINNET_CHAIN_ID),
        asset: USDC_SOLANA_MINT.toString(),
        transaction: bridgeResult.receipt.transactionHash,
        recipient: config.ownAddress,
      };
      rebalanceOperations.push(rebalanceAction);

      logger.info('Leg 1 rebalance completed successfully', {
        requestId,
        bridgedAmount: bridgeResult.effectiveBridgedAmount,
        bridgedAmountInUsdc: (Number(bridgeResult.effectiveBridgedAmount) / 10 ** USDC_SOLANA_DECIMALS).toFixed(6),
        transactionHash: bridgeResult.receipt.transactionHash,
      });
    } catch (dbError) {
      logger.error('Failed to create rebalance operation record', {
        requestId,
        error: jsonifyError(dbError),
      });
      // Don't throw here - the bridge was successful, just the record creation failed
    }
  } catch (bridgeError) {
    logger.error('Leg 1 bridge operation failed', {
      requestId,
      route: solanaToMainnetRoute,
      amountToBridge: amountToBridge.toString(),
      error: jsonifyError(bridgeError),
      errorMessage: (bridgeError as Error)?.message,
      errorStack: (bridgeError as Error)?.stack,
    });
  }

  logger.info('Completed rebalancing Solana USDC', { requestId });

  return rebalanceOperations;
}

export const executeSolanaUsdcCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, database: db } = context;
  logger.info('Executing destination callbacks for Solana USDC rebalance', { requestId });

  // Get all pending CCIP operations from Solana to Mainnet
  const { operations: pendingSolanaOps } = await db.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING],
    chainId: Number(SOLANA_CHAINID),
    bridge: 'ccip-solana-mainnet',
  });

  logger.debug('Found pending Solana USDC rebalance operations', {
    count: pendingSolanaOps.length,
    requestId,
    status: RebalanceOperationStatus.PENDING,
  });

  for (const operation of pendingSolanaOps) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    if (
      operation.originChainId !== Number(SOLANA_CHAINID) ||
      operation.destinationChainId !== Number(MAINNET_CHAIN_ID)
    ) {
      continue;
    }

    // Check for operation timeout - mark as failed if stuck for too long
    if (operation.createdAt && isOperationTimedOut(new Date(operation.createdAt))) {
      logger.warn('Operation has exceeded TTL, marking as FAILED', {
        ...logContext,
        createdAt: operation.createdAt,
        ttlMinutes: DEFAULT_OPERATION_TTL_MINUTES,
      });
      await db.updateRebalanceOperation(operation.id, {
        status: RebalanceOperationStatus.EXPIRED,
      });
      continue;
    }

    logger.info('Checking if CCIP bridge completed and USDC arrived on Mainnet', {
      ...logContext,
      bridge: operation.bridge,
      amount: operation.amount,
    });

    try {
      // Get the Solana transaction hash from the stored receipt
      const solanaTransactionHash = operation.transactions?.[SOLANA_CHAINID]?.transactionHash;
      if (!solanaTransactionHash) {
        logger.warn('No Solana transaction hash found for CCIP operation', {
          ...logContext,
          transactions: operation.transactions,
        });
        continue;
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
          // Status should already be AWAITING_CALLBACK, just continue to next operation
          continue;
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

        // Execute Leg 2: Mainnet USDC → ptUSDe using Pendle adapter
        logger.info('Executing Leg 2: Mainnet USDC → ptUSDe via Pendle adapter', logContext);

        try {
          const { rebalance, config: rebalanceConfig } = context;

          // Get the Pendle adapter
          const pendleAdapter = rebalance.getAdapter(SupportedBridge.Pendle);
          if (!pendleAdapter) {
            logger.error('Pendle adapter not found', logContext);
            continue;
          }

          // Get USDC address on mainnet for the swap
          const usdcAddress = getTokenAddressFromConfig(USDC_TICKER_HASH, MAINNET_CHAIN_ID.toString(), rebalanceConfig);
          if (!usdcAddress) {
            logger.error('Could not find USDC address for mainnet', logContext);
            continue;
          }

          // Use stored recipient from Leg 1 operation to ensure consistency
          const storedRecipient = operation.recipient;
          const recipient = storedRecipient || rebalanceConfig.ownAddress;

          // Get ptUSDe address from the USDC_PTUSDE_PAIRS config
          const tokenPair = USDC_PTUSDE_PAIRS[Number(MAINNET_CHAIN_ID)];
          if (!tokenPair?.ptUSDe) {
            logger.error('ptUSDe address not configured for mainnet in USDC_PTUSDE_PAIRS', logContext);
            await db.updateRebalanceOperation(operation.id, {
              status: RebalanceOperationStatus.CANCELLED,
            });
            continue;
          }

          const ptUsdeAddress = tokenPair.ptUSDe;

          logger.debug('Leg 2 Pendle swap details', {
            ...logContext,
            storedRecipient,
            fallbackRecipient: rebalanceConfig.ownAddress,
            finalRecipient: recipient,
            usdcAddress,
            ptUsdeAddress,
            amountToSwap: operation.amount,
          });

          // Create route for USDC → ptUSDe swap on mainnet (same chain swap)
          const pendleRoute = {
            asset: usdcAddress,
            origin: Number(MAINNET_CHAIN_ID),
            destination: Number(MAINNET_CHAIN_ID), // Same chain swap
            swapOutputAsset: ptUsdeAddress, // Target ptUSDe (actual address)
          };

          // Get quote from Pendle for USDC → ptUSDe
          const receivedAmountStr = await pendleAdapter.getReceivedAmount(operation.amount, pendleRoute);

          logger.info('Received Pendle quote for USDC → ptUSDe swap', {
            ...logContext,
            amountToSwap: operation.amount,
            expectedPtUsde: receivedAmountStr,
            route: pendleRoute,
          });

          // Execute the Pendle swap transactions
          const swapTxRequests = await pendleAdapter.send(recipient, recipient, operation.amount, pendleRoute);

          if (!swapTxRequests.length) {
            logger.error('No swap transactions returned from Pendle adapter', logContext);
            continue;
          }

          logger.info('Executing Pendle USDC → ptUSDe swap transactions', {
            ...logContext,
            transactionCount: swapTxRequests.length,
            recipient,
          });

          // Execute each transaction in the swap sequence
          let effectivePtUsdeAmount = receivedAmountStr;

          for (const { transaction, memo, effectiveAmount } of swapTxRequests) {
            logger.info('Submitting Pendle swap transaction', {
              requestId,
              memo,
              transaction,
            });

            const result = await submitTransactionWithLogging({
              chainService: context.chainService,
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

            if (memo === RebalanceTransactionMemo.Rebalance) {
              if (effectiveAmount) {
                effectivePtUsdeAmount = effectiveAmount;
              }
            }
          }

          // Execute Leg 3: ptUSDe → Solana CCIP immediately after Leg 2
          logger.info('Executing Leg 3: Mainnet ptUSDe → Solana via CCIP adapter', logContext);

          const ccipAdapter = context.rebalance.getAdapter(SupportedBridge.CCIP);

          // Reuse ptUsdeAddress from Leg 2 scope for Leg 3

          // Create route for ptUSDe → Solana CCIP bridge
          const ccipRoute = {
            asset: ptUsdeAddress,
            origin: Number(MAINNET_CHAIN_ID),
            destination: Number(SOLANA_CHAINID), // Back to Solana
          };

          // Execute Leg 3 CCIP transactions
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
              chainService: context.chainService,
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

            // Store the CCIP bridge transaction hash (not approval)
            if (memo === RebalanceTransactionMemo.Rebalance) {
              leg3CcipTx = result;
            }
          }

          // Update operation with Leg 3 CCIP transaction hash for status tracking
          if (leg3CcipTx) {
            const leg3Receipt: TransactionReceipt = leg3CcipTx.receipt!;

            const insertedTransactions = {
              [MAINNET_CHAIN_ID]: leg3Receipt,
            };

            await db.updateRebalanceOperation(operation.id, {
              txHashes: insertedTransactions,
            });

            logger.info('Stored Leg 3 CCIP transaction hash for status tracking', {
              requestId,
              operationId: operation.id,
              leg3CcipTxHash: leg3CcipTx.hash,
            });
          }

          // Keep status as AWAITING_CALLBACK - Leg 3 CCIP takes 20+ minutes
          // Will be checked in next callback cycle
          logger.info('Legs 1, 2, and 3 submitted successfully', {
            ...logContext,
            ptUsdeAmount: effectivePtUsdeAmount,
            note: 'Leg 1: Done, Leg 2: Done, Leg 3: CCIP submitted, waiting for completion',
            status: 'AWAITING_CALLBACK',
          });
        } catch (pendleError) {
          logger.error('Failed to execute Leg 2 Pendle swap', {
            ...logContext,
            error: jsonifyError(pendleError),
          });

          // Mark operation as FAILED since Leg 2 failed
          await db.updateRebalanceOperation(operation.id, {
            status: RebalanceOperationStatus.CANCELLED,
          });

          logger.info('Marked operation as FAILED due to Leg 2 Pendle swap failure', {
            ...logContext,
            note: 'Funds are on Mainnet as USDC - manual intervention may be required',
          });
        }
      } else if (ccipStatus.status === 'FAILURE') {
        logger.error('CCIP bridge transaction failed', {
          ...logContext,
          solanaTransactionHash,
          ccipMessage: ccipStatus.message,
          shouldRetry: false,
        });

        // Mark operation as FAILED since CCIP bridge failed
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.CANCELLED,
        });

        logger.info('Marked operation as FAILED due to CCIP bridge failure', {
          ...logContext,
          note: 'Leg 1 CCIP bridge failed - funds may still be on Solana',
        });
      } else {
        // CCIP still pending - check if it's been too long (CCIP typically takes 20 minutes)
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
    } catch (error) {
      logger.error('Failed to check CCIP bridge completion status', {
        ...logContext,
        error: jsonifyError(error),
      });
    }
  }

  // Check operations in AWAITING_CALLBACK status for Leg 3 (ptUSDe → Solana CCIP) completion
  const { operations: awaitingCallbackOps } = await db.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.AWAITING_CALLBACK],
    bridge: 'ccip-solana-mainnet',
  });

  logger.debug('Found operations awaiting Leg 3 CCIP completion', {
    count: awaitingCallbackOps.length,
    requestId,
    status: RebalanceOperationStatus.AWAITING_CALLBACK,
  });

  for (const operation of awaitingCallbackOps) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    // Check for operation timeout - mark as failed if stuck for too long
    if (operation.createdAt && isOperationTimedOut(new Date(operation.createdAt))) {
      logger.warn('AWAITING_CALLBACK operation has exceeded TTL, marking as FAILED', {
        ...logContext,
        createdAt: operation.createdAt,
        ttlMinutes: DEFAULT_OPERATION_TTL_MINUTES,
        note: 'Leg 3 CCIP may have failed or taken too long',
      });
      await db.updateRebalanceOperation(operation.id, {
        status: RebalanceOperationStatus.EXPIRED,
      });
      continue;
    }

    logger.info('Checking Leg 3 CCIP completion (ptUSDe → Solana)', logContext);

    try {
      // Get Leg 3 CCIP transaction hash from mainnet transactions
      const mainnetTransactionHash = operation.transactions?.[MAINNET_CHAIN_ID]?.transactionHash;
      if (!mainnetTransactionHash) {
        logger.warn('No Leg 3 CCIP transaction hash found', {
          ...logContext,
          transactions: operation.transactions,
        });
        continue;
      }

      // Check if Leg 3 CCIP (ptUSDe → Solana) is ready on destination
      const ccipAdapter = context.rebalance.getAdapter(SupportedBridge.CCIP) as CCIPBridgeAdapter;

      const leg3Route = {
        origin: Number(MAINNET_CHAIN_ID),
        destination: Number(SOLANA_CHAINID),
        asset: '', // Will be filled by adapter
      };

      // Create minimal receipt for readyOnDestination - the CCIP adapter only uses
      // transactionHash and status fields, so we cast a partial object
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
        // All 3 legs completed successfully
        await db.updateRebalanceOperation(operation.id, {
          status: RebalanceOperationStatus.COMPLETED,
        });

        logger.info('All 3 legs completed successfully', {
          ...logContext,
          mainnetTransactionHash,
          note: 'Leg 1: Solana→Mainnet CCIP ✓, Leg 2: USDC→ptUSDe ✓, Leg 3: ptUSDe→Solana CCIP ✓',
          finalStatus: 'COMPLETED',
        });
      } else {
        logger.debug('Leg 3 CCIP still pending', {
          ...logContext,
          mainnetTransactionHash,
          note: 'Waiting for ptUSDe → Solana CCIP to complete',
        });
      }
    } catch (error) {
      logger.error('Failed to check Leg 3 CCIP completion', {
        ...logContext,
        error: jsonifyError(error),
      });
    }
  }
};
