import { TransactionReceipt as ViemTransactionReceipt } from 'viem';
import { convertToNativeUnits } from '../helpers';
import { jsonifyError } from '@mark/logger';
import {
  getDecimalsFromConfig,
  RebalanceOperationStatus,
  RebalanceAction,
  SupportedBridge,
  MAINNET_CHAIN_ID,
  SOLANA_CHAINID,
  getTokenAddressFromConfig,
  EarmarkStatus,
  WalletType,
} from '@mark/core';
import { ProcessingContext } from '../init';
import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { SolanaSigner } from '@mark/chainservice';
import {
  createEarmark,
  createRebalanceOperation,
  Earmark,
  getActiveEarmarkForInvoice,
  TransactionReceipt,
} from '@mark/database';
import { IntentStatus } from '@mark/everclear';
import { submitTransactionWithLogging } from '../helpers/transactions';
import { RebalanceTransactionMemo, USDC_PTUSDE_PAIRS, CCIPBridgeAdapter } from '@mark/rebalance';

// USDC ticker hash - string identifier used for cross-chain asset matching
// This matches the tickerHash field in AssetConfiguration
const USDC_TICKER_HASH = 'USDC';

// Minimum rebalancing amount (1 USDC in 6 decimals)
const MIN_REBALANCING_AMOUNT = 1000000n;

// Chainlink CCIP constants for Solana
// See: https://docs.chain.link/ccip/directory/mainnet/chain/solana-mainnet
const CCIP_ROUTER_PROGRAM_ID = new PublicKey('Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C');
const SOLANA_CHAIN_SELECTOR = '124615329519749607';
const ETHEREUM_CHAIN_SELECTOR = '5009297550715157269';
const USDC_SOLANA_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PTUSDE_SOLANA_MINT = new PublicKey('PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA');

// Solana CCIP Token Pool addresses (from Chainlink CCIP Directory)
// These are required for properly building CCIP instructions on Solana
// Note: These constants are reserved for future CCIP integration enhancements
// const CCIP_TOKEN_ADMIN_REGISTRY = new PublicKey('TokenAdminRegistry11111111111111111111111');
// const CCIP_FEE_QUOTER = new PublicKey('FeeQuoter111111111111111111111111111111111');

type ExecuteBridgeContext = Pick<ProcessingContext, 'logger' | 'chainService' | 'config' | 'requestId'>;

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
}

/**
 * SVM2AnyMessage structure for CCIP Solana to EVM transfers
 * See: https://docs.chain.link/ccip/architecture#svm2any-messages
 *
 * IMPORTANT: The actual CCIP Solana SDK instruction format may differ.
 * This implementation is based on available documentation and may need
 * updates when the official @chainlink/ccip-solana-sdk is released.
 */
interface SVM2AnyMessage {
  receiver: Uint8Array; // EVM address padded to 32 bytes
  data: Uint8Array; // Empty for token-only transfers
  tokenAmounts: Array<{
    token: Uint8Array; // SPL token mint address (32 bytes)
    amount: bigint; // Amount in base units
  }>;
  feeToken: Uint8Array; // PublicKey.default for native SOL payment
  extraArgs: Uint8Array; // CCIP execution parameters (gas limit, etc.)
}

/**
 * Encode an EVM address as 32-byte receiver for CCIP
 */
function encodeEvmReceiverForCCIP(evmAddress: string): Uint8Array {
  // Remove 0x prefix and convert to bytes
  const addressBytes = Buffer.from(evmAddress.slice(2), 'hex');
  if (addressBytes.length !== 20) {
    throw new Error(`Invalid EVM address format: ${evmAddress}`);
  }
  // Pad to 32 bytes (left-padded with zeros)
  const padded = Buffer.alloc(32);
  addressBytes.copy(padded, 12); // Copy to last 20 bytes
  return padded;
}

/**
 * Build CCIP extra args for EVM destination
 * This encodes gas limit and other options for the destination chain
 */
function buildCCIPExtraArgs(gasLimit: number = 200000): Uint8Array {
  // EVM extra args format (simplified):
  // - Version tag: 1 byte (0x01 for EVM)
  // - Gas limit: 4 bytes (uint32, little-endian)
  // - Out of order execution: 1 byte (0x01 to enable)
  const buffer = Buffer.alloc(6);
  buffer.writeUInt8(0x01, 0); // Version tag for EVM
  buffer.writeUInt32LE(gasLimit, 1); // Gas limit
  buffer.writeUInt8(0x01, 5); // Enable out-of-order execution
  return buffer;
}

/**
 * Build CCIP send instruction data using Borsh-like serialization
 *
 * NOTE: This is a placeholder implementation. The actual serialization
 * format should match the CCIP Solana program's expected format.
 * When Chainlink releases the official SDK, this should be replaced.
 */
function buildCCIPInstructionData(message: SVM2AnyMessage, destChainSelector: bigint): Buffer {
  // Instruction discriminator (placeholder - needs to match actual program)
  const CCIP_SEND_DISCRIMINATOR = Buffer.from([0x01]); // Placeholder

  // Serialize destination chain selector (8 bytes, little-endian)
  const selectorBuffer = Buffer.alloc(8);
  selectorBuffer.writeBigUInt64LE(destChainSelector, 0);

  // Serialize receiver (32 bytes)
  const receiverBuffer = Buffer.from(message.receiver);

  // Serialize data length + data
  const dataLenBuffer = Buffer.alloc(4);
  dataLenBuffer.writeUInt32LE(message.data.length, 0);
  const dataBuffer = Buffer.from(message.data);

  // Serialize token amounts array
  const tokenCountBuffer = Buffer.alloc(4);
  tokenCountBuffer.writeUInt32LE(message.tokenAmounts.length, 0);

  const tokenBuffers: Buffer[] = [];
  for (const tokenAmount of message.tokenAmounts) {
    const tokenBuf = Buffer.from(tokenAmount.token);
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(tokenAmount.amount, 0);
    tokenBuffers.push(Buffer.concat([tokenBuf, amountBuf]));
  }

  // Serialize extra args
  const extraArgsLenBuffer = Buffer.alloc(4);
  extraArgsLenBuffer.writeUInt32LE(message.extraArgs.length, 0);
  const extraArgsBuffer = Buffer.from(message.extraArgs);

  // Serialize fee token (32 bytes)
  const feeTokenBuffer = Buffer.from(message.feeToken);

  return Buffer.concat([
    CCIP_SEND_DISCRIMINATOR,
    selectorBuffer,
    receiverBuffer,
    dataLenBuffer,
    dataBuffer,
    tokenCountBuffer,
    ...tokenBuffers,
    extraArgsLenBuffer,
    extraArgsBuffer,
    feeTokenBuffer,
  ]);
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

    // Build CCIP message
    const ccipMessage: SVM2AnyMessage = {
      receiver: encodeEvmReceiverForCCIP(recipientAddress),
      data: new Uint8Array(0), // No additional data for token transfer
      tokenAmounts: [
        {
          token: USDC_SOLANA_MINT.toBytes(),
          amount: amountToBridge,
        },
      ],
      feeToken: PublicKey.default.toBytes(), // Pay with native SOL
      extraArgs: buildCCIPExtraArgs(200000), // 200k gas limit on destination
    };

    logger.info('CCIP message prepared', {
      requestId,
      destinationChain: ETHEREUM_CHAIN_SELECTOR,
      tokenAmount: amountToBridge.toString(),
      recipient: recipientAddress,
      receiverHex: Buffer.from(ccipMessage.receiver).toString('hex'),
    });

    // Build instruction data
    const instructionData = buildCCIPInstructionData(ccipMessage, BigInt(ETHEREUM_CHAIN_SELECTOR));

    // Create CCIP send instruction
    // NOTE: The account list is simplified. Production should include:
    // - CCIP Router PDA accounts
    // - Token pool accounts
    // - Fee billing accounts
    // - OffRamp config accounts
    const ccipSendInstruction = new TransactionInstruction({
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true }, // Sender/payer
        { pubkey: sourceTokenAccount, isSigner: false, isWritable: true }, // Source token account
        { pubkey: USDC_SOLANA_MINT, isSigner: false, isWritable: false }, // Token mint
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
        { pubkey: CCIP_ROUTER_PROGRAM_ID, isSigner: false, isWritable: false }, // CCIP Router
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
        // TODO: Add additional required accounts for CCIP:
        // - CCIP Config account
        // - Token Pool account
        // - Fee Billing account
        // - OnRamp account
      ],
      programId: CCIP_ROUTER_PROGRAM_ID,
      data: instructionData,
    });

    logger.info('Sending CCIP transaction to Solana via SolanaSigner', {
      requestId,
      transaction: {
        feePayer: walletPublicKey.toBase58(),
        instructionDataLength: instructionData.length,
      },
    });

    // Use SolanaSigner to sign and send transaction with built-in retry logic
    const result = await solanaSigner.signAndSendTransaction({
      instructions: [ccipSendInstruction],
      computeUnitPrice: 50000, // Priority fee for faster inclusion
      computeUnitLimit: 200000, // Compute units for CCIP instruction
    });

    if (!result.success) {
      throw new Error(`Solana transaction failed: ${result.error || 'Unknown error'}`);
    }

    logger.info('CCIP bridge transaction successful', {
      requestId,
      signature: result.signature,
      slot: result.slot,
      amountBridged: amountToBridge.toString(),
      recipient: recipientAddress,
      fee: result.fee,
      logs: result.logs,
    });

    // Create transaction receipt
    const receipt: TransactionReceipt = {
      transactionHash: result.signature,
      status: result.success ? 1 : 0,
      blockNumber: result.slot,
      logs: result.logs,
      cumulativeGasUsed: result.fee.toString(),
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
  const { logger, requestId, config, chainService, rebalance, everclear, solanaSigner } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  // Check if SolanaSigner is available
  if (!solanaSigner) {
    logger.warn('SolanaSigner not configured - Solana USDC rebalancing is disabled', {
      requestId,
      reason: 'Missing solana.privateKey in configuration',
      action: 'Configure SOLANA_PRIVATE_KEY in SSM Parameter Store',
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
      balanceInPtUsde: (Number(solanaPtUsdeBalance) / 1e18).toFixed(6), // ptUSDe has 18 decimals
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
      balanceInUsdc: (Number(solanaUsdcBalance) / 1_000_000).toFixed(6),
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

  // Get all intents to Solana for USDC
  const intents = await everclear.fetchIntents({
    limit: 20,
    statuses: [IntentStatus.SETTLED_AND_COMPLETED],
    destinations: [SOLANA_CHAINID],
    tickerHash: USDC_TICKER_HASH,
    isFastPath: true,
  });

  // Process each intent to Solana
  for (const intent of intents) {
    logger.info('Processing Solana USDC intent', { requestId, intent });

    if (!intent.hub_settlement_domain) {
      logger.warn('Intent does not have a hub settlement domain, skipping', { requestId, intent });
      continue;
    }

    if (intent.destinations.length !== 1 || intent.destinations[0] !== SOLANA_CHAINID) {
      logger.warn('Intent does not have exactly one destination - Solana, skipping', { requestId, intent });
      continue;
    }

    // Check if an active earmark already exists for this intent
    const existingActive = await getActiveEarmarkForInvoice(intent.intent_id);
    if (existingActive) {
      logger.warn('Active earmark already exists for intent, skipping rebalance operations', {
        requestId,
        invoiceId: intent.intent_id,
        existingEarmarkId: existingActive.id,
        existingStatus: existingActive.status,
      });
      continue;
    }

    const origin = Number(intent.hub_settlement_domain);
    const destination = SOLANA_CHAINID;

    // USDC intent should be settled with USDC address on settlement domain
    const ticker = USDC_TICKER_HASH;
    const decimals = getDecimalsFromConfig(ticker, origin.toString(), config);

    // Convert min amount and intent amount from standardized decimals to asset's native decimals
    const minAmount = convertToNativeUnits(BigInt(MIN_REBALANCING_AMOUNT), decimals);
    const intentAmount = convertToNativeUnits(BigInt(intent.amount_out_min), decimals);
    if (intentAmount < minAmount) {
      logger.warn('Intent amount is less than min rebalancing amount, skipping', {
        requestId,
        intent,
        intentAmount: intentAmount.toString(),
        minAmount: minAmount.toString(),
      });
      continue;
    }

    // Check if ptUSDe balance is below threshold to trigger rebalancing
    // The logic is: if ptUSDe is low, we bridge USDC from Solana to eventually get more ptUSDe
    const ptUsdeBalance = solanaPtUsdeBalance; // Use direct Solana ptUSDe balance
    const ptUsdeThresholdEnv = process.env[`PTUSDE_${SOLANA_CHAINID}_THRESHOLD`];
    const ptUsdeThreshold = ptUsdeThresholdEnv
      ? BigInt(ptUsdeThresholdEnv)
      : convertToNativeUnits(MIN_REBALANCING_AMOUNT * 10n, 18); // ptUSDe has 18 decimals, use 10x threshold as fallback

    logger.info('Checking ptUSDe balance threshold for rebalancing decision', {
      requestId,
      intentId: intent.intent_id,
      ptUsdeBalance: ptUsdeBalance.toString(),
      ptUsdeBalanceFormatted: (Number(ptUsdeBalance) / 1e18).toFixed(6),
      ptUsdeThreshold: ptUsdeThreshold.toString(),
      ptUsdeThresholdFormatted: (Number(ptUsdeThreshold) / 1e18).toFixed(6),
      shouldTriggerRebalance: ptUsdeBalance < ptUsdeThreshold,
      availableSolanaUsdc: solanaUsdcBalance.toString(),
      availableSolanaUsdcFormatted: (Number(solanaUsdcBalance) / 1_000_000).toFixed(6),
    });

    if (ptUsdeBalance >= ptUsdeThreshold) {
      logger.info('ptUSDe balance is above threshold, no rebalancing needed', {
        requestId,
        intentId: intent.intent_id,
        ptUsdeBalance: ptUsdeBalance.toString(),
        ptUsdeThreshold: ptUsdeThreshold.toString(),
      });
      continue;
    }

    // Calculate how much USDC to bridge based on ptUSDe deficit and available Solana USDC
    const ptUsdeDeficit = ptUsdeThreshold - ptUsdeBalance;
    // Approximate 1:1 ratio between USDC and ptUSDe for initial calculation
    const usdcNeeded = convertToNativeUnits(ptUsdeDeficit, 6); // Convert to USDC decimals (6)
    const currentBalance = solanaUsdcBalance;

    if (currentBalance <= minAmount) {
      logger.warn('Solana USDC balance is below minimum rebalancing threshold, skipping intent', {
        requestId,
        intentId: intent.intent_id,
        currentBalance: currentBalance.toString(),
        currentBalanceFormatted: (Number(currentBalance) / 1_000_000).toFixed(6),
        minAmount: minAmount.toString(),
        minAmountFormatted: (Number(minAmount) / 1_000_000).toFixed(6),
        reason: 'Insufficient balance for rebalancing',
      });
      continue;
    }

    // Check if we have enough USDC to meaningfully address the ptUSDe deficit
    if (currentBalance < usdcNeeded) {
      logger.warn('Solana USDC balance is insufficient to fully cover ptUSDe deficit', {
        requestId,
        intentId: intent.intent_id,
        currentBalance: currentBalance.toString(),
        currentBalanceFormatted: (Number(currentBalance) / 1_000_000).toFixed(6),
        usdcNeeded: usdcNeeded.toString(),
        usdcNeededFormatted: (Number(usdcNeeded) / 1_000_000).toFixed(6),
        shortfall: (usdcNeeded - currentBalance).toString(),
        shortfallFormatted: (Number(usdcNeeded - currentBalance) / 1_000_000).toFixed(6),
        decision: 'Will bridge all available USDC (partial rebalancing)',
      });
    }

    // Calculate amount to bridge based on ptUSDe deficit and available Solana USDC
    // Bridge the minimum of: what we need, what we have available, and the intent amount
    const amountToBridge =
      currentBalance < usdcNeeded
        ? currentBalance // Bridge all available if insufficient
        : usdcNeeded < intentAmount
          ? usdcNeeded
          : intentAmount; // Otherwise bridge what's needed or intent amount

    // Final validation - ensure we're bridging a meaningful amount
    if (amountToBridge < minAmount) {
      logger.warn('Calculated bridge amount is below minimum threshold, skipping intent', {
        requestId,
        intentId: intent.intent_id,
        calculatedAmount: amountToBridge.toString(),
        calculatedAmountFormatted: (Number(amountToBridge) / 1_000_000).toFixed(6),
        minAmount: minAmount.toString(),
        minAmountFormatted: (Number(minAmount) / 1_000_000).toFixed(6),
        reason: 'Calculated bridge amount too small to be effective',
      });
      continue;
    }

    logger.info('Calculated bridge amount based on ptUSDe deficit and available balance', {
      requestId,
      intentId: intent.intent_id,
      balanceChecks: {
        ptUsdeDeficit: ptUsdeDeficit.toString(),
        usdcNeeded: usdcNeeded.toString(),
        usdcNeededFormatted: (Number(usdcNeeded) / 1_000_000).toFixed(6),
        availableSolanaUsdc: currentBalance.toString(),
        availableSolanaUsdcFormatted: (Number(currentBalance) / 1_000_000).toFixed(6),
        hasSufficientBalance: currentBalance >= usdcNeeded,
        intentAmount: intentAmount.toString(),
        intentAmountFormatted: (Number(intentAmount) / 1_000_000).toFixed(6),
      },
      bridgeDecision: {
        finalAmountToBridge: amountToBridge.toString(),
        finalAmountToBridgeFormatted: (Number(amountToBridge) / 1_000_000).toFixed(6),
        isPartialBridge: currentBalance < usdcNeeded,
        utilizationPercentage: ((Number(amountToBridge) / Number(currentBalance)) * 100).toFixed(2) + '%',
      },
    });

    let earmark: Earmark;
    try {
      earmark = await createEarmark({
        invoiceId: intent.intent_id,
        designatedPurchaseChain: Number(destination),
        tickerHash: ticker,
        minAmount: amountToBridge.toString(),
        status: EarmarkStatus.PENDING,
      });
    } catch (error: unknown) {
      logger.error('Failed to create earmark for intent', {
        requestId,
        intent,
        error: jsonifyError(error),
      });
      throw error;
    }

    logger.info('Created earmark for intent', {
      requestId,
      earmarkId: earmark.id,
      invoiceId: intent.intent_id,
    });

    let rebalanceSuccessful = false;

    // Prepare route for Solana to Mainnet bridge
    const solanaToMainnetRoute = {
      origin: Number(SOLANA_CHAINID),
      destination: Number(MAINNET_CHAIN_ID),
      asset: USDC_SOLANA_MINT.toString(),
    };

    logger.info('Starting Leg 1: Solana to Mainnet CCIP bridge', {
      requestId,
      intentId: intent.intent_id,
      earmarkId: earmark.id,
      route: solanaToMainnetRoute,
      amountToBridge: amountToBridge.toString(),
      amountToBridgeInUsdc: (Number(amountToBridge) / 1_000_000).toFixed(6),
      recipientAddress: config.ownAddress,
    });

    try {
      // Pre-flight checks
      logger.info('Performing pre-bridge validation checks', {
        requestId,
        intentId: intent.intent_id,
        checks: {
          solanaBalance: currentBalance.toString(),
          requiredAmount: amountToBridge.toString(),
          hasSufficientBalance: currentBalance >= amountToBridge,
          recipientValid: !!config.ownAddress,
        },
      });

      if (currentBalance < amountToBridge) {
        throw new Error(`Insufficient Solana USDC balance. Required: ${amountToBridge}, Available: ${currentBalance}`);
      }

      if (!config.ownAddress) {
        throw new Error('Recipient address (config.ownAddress) not configured');
      }

      // Execute Leg 1: Solana to Mainnet bridge
      const bridgeResult = await executeSolanaToMainnetBridge({
        context: { requestId, logger, config, chainService },
        solanaSigner,
        route: solanaToMainnetRoute,
        amountToBridge,
        recipientAddress: config.ownAddress, // needs to go on solver
      });

      if (!bridgeResult.receipt || bridgeResult.receipt.status !== 1) {
        throw new Error(`Bridge transaction failed: ${bridgeResult.receipt?.transactionHash || 'Unknown transaction'}`);
      }

      logger.info('Leg 1 bridge completed successfully', {
        requestId,
        intentId: intent.intent_id,
        earmarkId: earmark.id,
        transactionHash: bridgeResult.receipt.transactionHash,
        effectiveAmount: bridgeResult.effectiveBridgedAmount,
        blockNumber: bridgeResult.receipt.blockNumber,
        solanaSlot: bridgeResult.receipt.blockNumber,
      });

      // Create rebalance operation record for tracking all 3 legs
      try {
        await createRebalanceOperation({
          earmarkId: earmark.id,
          originChainId: Number(SOLANA_CHAINID),
          destinationChainId: Number(MAINNET_CHAIN_ID),
          tickerHash: ticker,
          amount: bridgeResult.effectiveBridgedAmount,
          slippage: 1000, // 1% slippage
          status: RebalanceOperationStatus.PENDING, // pending as CCIP takes 20 mins to bridge
          bridge: 'ccip-solana-mainnet',
          transactions: { [SOLANA_CHAINID]: bridgeResult.receipt },
          recipient: config.ownAddress,
        });

        logger.info('Rebalance operation record created for Leg 1', {
          requestId,
          intentId: intent.intent_id,
          earmarkId: earmark.id,
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

        rebalanceSuccessful = true;

        logger.info('Leg 1 rebalance completed successfully', {
          requestId,
          intentId: intent.intent_id,
          earmarkId: earmark.id,
          bridgedAmount: bridgeResult.effectiveBridgedAmount,
          bridgedAmountInUsdc: (Number(bridgeResult.effectiveBridgedAmount) / 1_000_000).toFixed(6),
          transactionHash: bridgeResult.receipt.transactionHash,
        });
      } catch (dbError) {
        logger.error('Failed to create rebalance operation record', {
          requestId,
          intentId: intent.intent_id,
          earmarkId: earmark.id,
          error: jsonifyError(dbError),
        });
        // Don't throw here - the bridge was successful, just the record creation failed
      }
    } catch (bridgeError) {
      logger.error('Leg 1 bridge operation failed', {
        requestId,
        intentId: intent.intent_id,
        earmarkId: earmark.id,
        route: solanaToMainnetRoute,
        amountToBridge: amountToBridge.toString(),
        error: jsonifyError(bridgeError),
        errorMessage: (bridgeError as Error)?.message,
        errorStack: (bridgeError as Error)?.stack,
      });

      // Continue to next intent instead of throwing to allow processing other intents
      continue;
    }

    if (!rebalanceSuccessful) {
      logger.warn('Failed to complete Leg 1 rebalance for intent', {
        requestId,
        intentId: intent.intent_id,
        route: solanaToMainnetRoute,
        amountToBridge: amountToBridge.toString(),
      });
    }
  }

  logger.info('Completed rebalancing Solana USDC', { requestId });

  // TODO: other two legs
  // Leg 2: Use pendle adapter to get ptUSDe,
  // further bridge to solana for ptUSDe is added in destinationCallback in pendle handler @preetham
  return rebalanceOperations;
}

export const executeSolanaUsdcCallbacks = async (context: ProcessingContext): Promise<void> => {
  const { logger, requestId, database: db } = context;
  logger.info('Executing destination callbacks for Solana USDC rebalance', { requestId });

  // Get all pending CCIP operations from Solana to Mainnet
  const { operations } = await db.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING],
  });

  logger.debug('Found pending Solana USDC rebalance operations', {
    count: operations.length,
    requestId,
    status: RebalanceOperationStatus.PENDING,
  });

  for (const operation of operations) {
    const logContext = {
      requestId,
      operationId: operation.id,
      earmarkId: operation.earmarkId,
      originChain: operation.originChainId,
      destinationChain: operation.destinationChainId,
    };

    // Only process Solana -> Mainnet CCIP operations
    if (!operation.bridge || operation.bridge !== 'ccip-solana-mainnet') {
      continue;
    }

    if (
      operation.originChainId !== Number(SOLANA_CHAINID) ||
      operation.destinationChainId !== Number(MAINNET_CHAIN_ID)
    ) {
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
          destinationTransactionHash: ccipStatus.destinationTransactionHash,
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
              status: RebalanceOperationStatus.FAILED,
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
          const ccipTxRequests = await ccipAdapter.send(recipient, recipient, effectivePtUsdeAmount, ccipRoute);

          let leg3CcipTxHash: string | undefined;

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
              leg3CcipTxHash = result.hash;
            }
          }

          // Update operation with Leg 3 CCIP transaction hash for status tracking
          if (leg3CcipTxHash) {
            const leg3Receipt: TransactionReceipt = {
              transactionHash: leg3CcipTxHash,
              blockNumber: 0,
              from: rebalanceConfig.ownAddress,
              to: '',
              cumulativeGasUsed: '0',
              effectiveGasPrice: '0',
              logs: [],
              status: 1,
              confirmations: 1,
            };

            const updatedTransactions = {
              ...operation.transactions,
              [MAINNET_CHAIN_ID]: leg3Receipt,
            };

            await db.updateRebalanceOperation(operation.id, {
              txHashes: updatedTransactions,
            });

            logger.info('Stored Leg 3 CCIP transaction hash for status tracking', {
              requestId,
              operationId: operation.id,
              leg3CcipTxHash,
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
            status: RebalanceOperationStatus.FAILED,
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
          status: RebalanceOperationStatus.FAILED,
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

    // Only process operations that should have Leg 3 CCIP (ptUSDe → Solana)
    if (operation.bridge !== 'ccip-solana-mainnet') {
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
