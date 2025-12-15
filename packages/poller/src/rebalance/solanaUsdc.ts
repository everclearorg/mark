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
} from '@mark/core';
import { ProcessingContext } from '../init';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  Keypair,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createTransferInstruction,
  getAccount,
} from '@solana/spl-token';
import * as bs58 from 'bs58';
import {
  createEarmark,
  createRebalanceOperation,
  Earmark,
  getActiveEarmarkForInvoice,
  TransactionReceipt,
} from '@mark/database';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { IntentStatus } from '@mark/everclear';
import * as CCIP from '@chainlink/ccip-js';

// USDC ticker hash
const USDC_TICKER_HASH = '0xa0b86991c431e59e3a13bdc4b0a7f6e4bb95f2d7d4f5a7f3a75e8b6e0e7b9f9a7';

// Minimum rebalancing amount (1 USDC in 6 decimals)
const MIN_REBALANCING_AMOUNT = 1000000n;

// Chainlink CCIP constants for Solana
const CCIP_ROUTER_PROGRAM_ID = new PublicKey('Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C');
const SOLANA_CHAIN_SELECTOR = '124615329519749607';
const ETHEREUM_CHAIN_SELECTOR = '5009297550715157269';
const USDC_SOLANA_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PTUSDE_SOLANA_MINT = new PublicKey('...'); // TODO: Add actual ptUSDe SPL token mint address on Solana

// Solana RPC configuration
const getSolanaConnection = (config: any): Connection => {
  const rpcUrl = config.chains[SOLANA_CHAINID]?.providers?.[0] || 'https://api.mainnet-beta.solana.com';
  return new Connection(rpcUrl, 'confirmed');
};

// Get Solana wallet keypair from private key
const getSolanaWallet = (config: any): Keypair => {
  // Assuming the private key is stored in config.solanaPrivateKey as base58 string
  const privateKeyBase58 = config.solanaPrivateKey;
  if (!privateKeyBase58) {
    throw new Error('Solana private key not found in configuration');
  }
  const privateKeyBytes = bs58.default.decode(privateKeyBase58);
  return Keypair.fromSecretKey(privateKeyBytes);
};

type ExecuteBridgeContext = Pick<ProcessingContext, 'logger' | 'chainService' | 'config' | 'requestId'>;

interface SolanaToMainnetBridgeParams {
  context: ExecuteBridgeContext;
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

// CCIP Message structure for Solana to EVM (placeholder for future implementation)
// interface SVM2AnyMessage {
//   receiver: Uint8Array; // EVM address (32 bytes)
//   data: Uint8Array; // Empty for token-only transfers
//   tokenAmounts: Array<{
//     token: string; // SPL token mint address
//     amount: bigint; // Amount in base units
//   }>;
//   feeToken: string; // Zero address for native SOL payment
//   extraArgs: Uint8Array; // CCIP execution parameters
// }

// Execute CCIP bridge transaction from Solana to Ethereum Mainnet
async function executeSolanaToMainnetBridge({
  context,
  route,
  amountToBridge,
  recipientAddress,
}: SolanaToMainnetBridgeParams): Promise<SolanaToMainnetBridgeResult> {
  const { logger, config, requestId } = context;

  try {
    logger.info('Preparing Solana to Mainnet CCIP bridge', {
      requestId,
      route,
      amountToBridge: amountToBridge.toString(),
      recipient: recipientAddress,
      solanaChainSelector: SOLANA_CHAIN_SELECTOR,
      ethereumChainSelector: ETHEREUM_CHAIN_SELECTOR,
    });

    // Initialize Solana connection and wallet
    const connection = getSolanaConnection(config);
    const wallet = getSolanaWallet(config);
    const walletPublicKey = wallet.publicKey;

    logger.info('Solana wallet and connection initialized', {
      requestId,
      walletAddress: walletPublicKey.toBase58(),
      rpcUrl: connection.rpcEndpoint,
    });

    // Get associated token accounts
    const sourceTokenAccount = await getAssociatedTokenAddress(
      USDC_SOLANA_MINT,
      walletPublicKey
    );

    // Verify USDC balance
    try {
      const tokenAccountInfo = await getAccount(connection, sourceTokenAccount);
      if (tokenAccountInfo.amount < amountToBridge) {
        throw new Error(
          `Insufficient USDC balance. Required: ${amountToBridge}, Available: ${tokenAccountInfo.amount}`
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

    // Convert EVM recipient address to bytes for CCIP message
    const evmRecipientBytes = Buffer.from(recipientAddress.slice(2), 'hex');
    if (evmRecipientBytes.length !== 20) {
      throw new Error(`Invalid EVM address format: ${recipientAddress}`);
    }

    // Build CCIP send instruction data
    const ccipMessageData = {
      destinationChainSelector: BigInt(ETHEREUM_CHAIN_SELECTOR),
      receiver: evmRecipientBytes,
      tokenAmounts: [{
        token: USDC_SOLANA_MINT.toBytes(),
        amount: amountToBridge,
      }],
      extraArgs: Buffer.from([1, 0, 0, 0]), // Enable out-of-order execution
      feeToken: PublicKey.default.toBytes(), // Pay with SOL
    };

    logger.info('CCIP message prepared', {
      requestId,
      destinationChain: ETHEREUM_CHAIN_SELECTOR,
      tokenAmount: amountToBridge.toString(),
      recipient: recipientAddress,
    });

    // Create CCIP send instruction
    // Note: This is a simplified instruction format - actual CCIP instruction would be more complex
    const ccipSendInstruction = new TransactionInstruction({
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
        { pubkey: USDC_SOLANA_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: CCIP_ROUTER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: CCIP_ROUTER_PROGRAM_ID,
      data: Buffer.from(JSON.stringify(ccipMessageData)), // Simplified data encoding
    });

    // Create and send transaction
    const transaction = new Transaction().add(ccipSendInstruction);

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = walletPublicKey;

    logger.info('Sending CCIP transaction to Solana', {
      requestId,
      transaction: {
        feePayer: walletPublicKey.toBase58(),
        blockhash,
        instructionCount: transaction.instructions.length,
      },
    });

    // Sign and send transaction
    const signature = await sendAndConfirmTransaction(connection, transaction, [wallet], {
      commitment: 'confirmed',
      maxRetries: 3,
    });

    logger.info('CCIP bridge transaction successful', {
      requestId,
      signature,
      amountBridged: amountToBridge.toString(),
      recipient: recipientAddress,
    });

    // Get transaction details
    const confirmedTx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
    });

    // Create transaction receipt
    const receipt: TransactionReceipt = {
      transactionHash: signature,
      status: confirmedTx?.meta?.err ? 0 : 1,
      blockNumber: confirmedTx?.slot || 0,
      logs: confirmedTx?.meta?.logMessages || [],
      cumulativeGasUsed: confirmedTx?.meta?.fee?.toString() || '0',
      effectiveGasPrice: '0',
      from: '',
      to: '',
      confirmations: undefined
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

// CCIP Transaction Status Types
interface CCIPTransactionStatus {
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  message?: string;
  destinationTransactionHash?: string;
}

// Check CCIP transaction status using official CCIP SDK
async function checkCCIPTransactionStatus(
  transactionHash: string,
  logger: any,
  requestId: string
): Promise<CCIPTransactionStatus> {
  try {
    logger.info('Checking CCIP transaction status using SDK', {
      requestId,
      transactionHash,
    });

    // Create a public client for Ethereum mainnet to check destination status
    const publicClient = createPublicClient({
      chain: mainnet,
      transport: http(),
    });

    // Use transaction hash directly as message ID for CCIP status check
    // According to docs: "Transfer status: Retrieve the status of a transfer by transaction hash"

    try {

      const ccipClient = CCIP.createClient()

      // Use official CCIP SDK to check transfer status
      const transferStatus = await ccipClient.getTransferStatus({
        client: publicClient as any, // Type casting for compatibility
        destinationRouterAddress: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D', // Mainnet CCIP router
        sourceChainSelector: SOLANA_CHAIN_SELECTOR,
        messageId: transactionHash as `0x${string}`, // Use transaction hash as message ID
      });

      logger.info('CCIP SDK transfer status check', {
        requestId,
        transactionHash,
        transferStatus,
        destinationRouter: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D',
        sourceChainSelector: SOLANA_CHAIN_SELECTOR,
      });

      if (transferStatus === null) {
        return {
          status: 'PENDING',
          message: 'Transfer not yet found on destination chain',
        };
      }

      // TransferStatus enum: Untouched = 0, InProgress = 1, Success = 2, Failure = 3
      switch (transferStatus) {
        case 2: // Success
          return {
            status: 'SUCCESS',
            message: 'CCIP transfer completed successfully',
            destinationTransactionHash: transactionHash,
          };
        case 3: // Failure
          return {
            status: 'FAILED',
            message: 'CCIP transfer failed',
          };
        case 1: // InProgress
        case 0: // Untouched
        default:
          return {
            status: 'PENDING',
            message: 'CCIP transfer in progress',
          };
      }

    } catch (fetchError) {
      logger.error('Failed to check CCIP transaction status', {
        requestId,
        transactionHash,
        error: jsonifyError(fetchError),
      });

      return {
        status: 'PENDING',
        message: 'Unable to check CCIP status',
      };
    }

  } catch (error) {
    logger.error('Error checking CCIP transaction status', {
      requestId,
      transactionHash,
      error: jsonifyError(error),
    });

    return {
      status: 'PENDING',
      message: 'Error checking CCIP status',
    };
  }
}

export async function rebalanceSolanaUsdc(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, chainService, rebalance, everclear } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  // Always check destination callbacks to ensure operations complete
  await executeSolanaUsdcCallbacks(context);

  const isPaused = await rebalance.isPaused();
  if (isPaused) {
    logger.warn('Solana USDC Rebalance loop is paused', { requestId });
    return rebalanceOperations;
  }

  logger.info('Starting to rebalance Solana USDC', { requestId });

  // Check solver's ptUSDe balance directly on Solana to determine if rebalancing is needed
  let solanaPtUsdeBalance: bigint = 0n;
  try {
    const connection = getSolanaConnection(config);
    const wallet = getSolanaWallet(config);
    const walletPublicKey = wallet.publicKey;

    const ptUsdeTokenAccount = await getAssociatedTokenAddress(
      PTUSDE_SOLANA_MINT,
      walletPublicKey
    );

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
      balanceInPtUsde: (Number(solanaPtUsdeBalance) / 1e18).toFixed(6) // ptUSDe has 18 decimals
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
    const connection = getSolanaConnection(config);
    const wallet = getSolanaWallet(config);
    const walletPublicKey = wallet.publicKey;

    const sourceTokenAccount = await getAssociatedTokenAddress(
      USDC_SOLANA_MINT,
      walletPublicKey
    );

    const tokenAccountInfo = await getAccount(connection, sourceTokenAccount);
    solanaUsdcBalance = tokenAccountInfo.amount;

    logger.info('Retrieved Solana USDC balance for potential bridging', {
      requestId,
      walletAddress: walletPublicKey.toBase58(),
      tokenAccount: sourceTokenAccount.toBase58(),
      balance: solanaUsdcBalance.toString(),
      balanceInUsdc: (Number(solanaUsdcBalance) / 1_000_000).toFixed(6)
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
    const ptUsdeThreshold = convertToNativeUnits(MIN_REBALANCING_AMOUNT * 10n, 18); // ptUSDe has 18 decimals, use 10x threshold

    logger.info('Checking ptUSDe balance threshold for rebalancing decision', {
      requestId,
      intentId: intent.intent_id,
      ptUsdeBalance: ptUsdeBalance.toString(),
      ptUsdeBalanceFormatted: (Number(ptUsdeBalance) / 1e18).toFixed(6),
      ptUsdeThreshold: ptUsdeThreshold.toString(),
      ptUsdeThresholdFormatted: (Number(ptUsdeThreshold) / 1e18).toFixed(6),
      shouldTriggerRebalance: ptUsdeBalance < ptUsdeThreshold,
      availableSolanaUsdc: solanaUsdcBalance.toString(),
      availableSolanaUsdcFormatted: (Number(solanaUsdcBalance) / 1_000_000).toFixed(6)
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
        reason: 'Insufficient balance for rebalancing'
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
        decision: 'Will bridge all available USDC (partial rebalancing)'
      });
    }

    // Calculate amount to bridge based on ptUSDe deficit and available Solana USDC
    // Bridge the minimum of: what we need, what we have available, and the intent amount
    const amountToBridge = currentBalance < usdcNeeded
      ? currentBalance  // Bridge all available if insufficient
      : (usdcNeeded < intentAmount ? usdcNeeded : intentAmount); // Otherwise bridge what's needed or intent amount

    // Final validation - ensure we're bridging a meaningful amount
    if (amountToBridge < minAmount) {
      logger.warn('Calculated bridge amount is below minimum threshold, skipping intent', {
        requestId,
        intentId: intent.intent_id,
        calculatedAmount: amountToBridge.toString(),
        calculatedAmountFormatted: (Number(amountToBridge) / 1_000_000).toFixed(6),
        minAmount: minAmount.toString(),
        minAmountFormatted: (Number(minAmount) / 1_000_000).toFixed(6),
        reason: 'Calculated bridge amount too small to be effective'
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
        utilizationPercentage: ((Number(amountToBridge) / Number(currentBalance)) * 100).toFixed(2) + '%'
      }
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
      asset: USDC_SOLANA_MINT.toString()
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
        }
      });

      if (currentBalance < amountToBridge) {
        throw new Error(
          `Insufficient Solana USDC balance. Required: ${amountToBridge}, Available: ${currentBalance}`
        );
      }

      if (!config.ownAddress) {
        throw new Error('Recipient address (config.ownAddress) not configured');
      }

      // Execute Leg 1: Solana to Mainnet bridge
      const bridgeResult = await executeSolanaToMainnetBridge({
        context: { requestId, logger, config, chainService },
        route: solanaToMainnetRoute,
        amountToBridge,
        recipientAddress: config.ownAddress // needs to go on solver
      });

      if (!bridgeResult.receipt || bridgeResult.receipt.status !== 1) {
        throw new Error(
          `Bridge transaction failed: ${bridgeResult.receipt?.transactionHash || 'Unknown transaction'}`
        );
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

      // Create rebalance operation record for tracking
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
          operationStatus: RebalanceOperationStatus.COMPLETED,
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

    if (operation.originChainId !== Number(SOLANA_CHAINID) ||
      operation.destinationChainId !== Number(MAINNET_CHAIN_ID)) {
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

      // Check CCIP transaction status using CCIP Explorer API
      const ccipStatus = await checkCCIPTransactionStatus(solanaTransactionHash, logger, requestId);

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

        // TODO: Trigger Leg 2 - Use Pendle adapter to swap USDC → ptUSDe on Mainnet
        // This would call the Pendle adapter's send() method to execute the swap
        // Then Pendle's destinationCallback() would handle Leg 3: bridge ptUSDe to Solana

        logger.info('Leg 2 trigger ready - Pendle adapter integration needed', {
          ...logContext,
          nextStep: 'Implement Pendle adapter call for USDC → ptUSDe swap',
          note: 'Pendle destinationCallback will handle Leg 3: ptUSDe → Solana bridge',
          destinationTransactionHash: ccipStatus.destinationTransactionHash,
        });

      } else if (ccipStatus.status === 'FAILED') {
        logger.error('CCIP bridge transaction failed', {
          ...logContext,
          solanaTransactionHash,
          ccipMessage: ccipStatus.message,
          shouldRetry: false,
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
};
