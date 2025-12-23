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
import { PublicKey, TransactionInstruction, SystemProgram, Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { SolanaSigner } from '@mark/chainservice';
import { createRebalanceOperation, TransactionReceipt } from '@mark/database';
import { submitTransactionWithLogging } from '../helpers/transactions';
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
const CCIP_FEE_QUOTER_PROGRAM_ID = new PublicKey('FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi');
const CCIP_RMN_REMOTE_PROGRAM_ID = new PublicKey('RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7');
const CCIP_LOCK_RELEASE_POOL_PROGRAM_ID = new PublicKey('8eqh8wppT9c5rw4ERqNCffvU6cNFJWff9WmkcYtmGiqC');
const SOLANA_CHAIN_SELECTOR = '124615329519749607';
const ETHEREUM_CHAIN_SELECTOR = '5009297550715157269';
const USDC_SOLANA_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const PTUSDE_SOLANA_MINT = new PublicKey('PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA');
const LINK_TOKEN_MINT = new PublicKey('LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Derive CCIP Router PDAs
 * See: https://docs.chain.link/ccip/api-reference/svm/v1.6.0/router
 */
function deriveCCIPRouterPDAs(
  destChainSelector: bigint,
  userPubkey: PublicKey,
): {
  config: PublicKey;
  destChainState: PublicKey;
  nonce: PublicKey;
  feeBillingSigner: PublicKey;
} {
  // Config: ["config"]
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], CCIP_ROUTER_PROGRAM_ID);

  // Destination Chain State: ["dest_chain_state", destChainSelector (u64 LE)]
  const destChainSelectorBuf = Buffer.alloc(8);
  destChainSelectorBuf.writeBigUInt64LE(destChainSelector, 0);
  const [destChainState] = PublicKey.findProgramAddressSync(
    [Buffer.from('dest_chain_state'), destChainSelectorBuf],
    CCIP_ROUTER_PROGRAM_ID,
  );

  // Nonce: ["nonce", destChainSelector (u64 LE), userPubkey]
  const [nonce] = PublicKey.findProgramAddressSync(
    [Buffer.from('nonce'), destChainSelectorBuf, userPubkey.toBytes()],
    CCIP_ROUTER_PROGRAM_ID,
  );

  // Fee Billing Signer: ["fee_billing_signer"]
  const [feeBillingSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_billing_signer')],
    CCIP_ROUTER_PROGRAM_ID,
  );

  return { config, destChainState, nonce, feeBillingSigner };
}

/**
 * Derive Fee Quoter PDAs
 */
function deriveFeeQuoterPDAs(
  destChainSelector: bigint,
  billingTokenMint: PublicKey,
  linkTokenMint: PublicKey,
): {
  config: PublicKey;
  destChain: PublicKey;
  billingTokenConfig: PublicKey;
  linkTokenConfig: PublicKey;
} {
  const destChainSelectorBuf = Buffer.alloc(8);
  destChainSelectorBuf.writeBigUInt64LE(destChainSelector, 0);

  // Config: ["config"]
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], CCIP_FEE_QUOTER_PROGRAM_ID);

  // Dest Chain: ["dest_chain", destChainSelector (u64 LE)]
  const [destChain] = PublicKey.findProgramAddressSync(
    [Buffer.from('dest_chain'), destChainSelectorBuf],
    CCIP_FEE_QUOTER_PROGRAM_ID,
  );

  // Billing Token Config: ["billing_token_config", tokenMint]
  const [billingTokenConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('billing_token_config'), billingTokenMint.toBytes()],
    CCIP_FEE_QUOTER_PROGRAM_ID,
  );

  // Link Token Config: ["billing_token_config", linkTokenMint]
  const [linkTokenConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('billing_token_config'), linkTokenMint.toBytes()],
    CCIP_FEE_QUOTER_PROGRAM_ID,
  );

  return { config, destChain, billingTokenConfig, linkTokenConfig };
}

/**
 * Derive RMN Remote PDAs
 */
function deriveRMNRemotePDAs(): {
  curses: PublicKey;
  config: PublicKey;
} {
  // Curses: ["curses"]
  const [curses] = PublicKey.findProgramAddressSync([Buffer.from('curses')], CCIP_RMN_REMOTE_PROGRAM_ID);

  // Config: ["config"]
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], CCIP_RMN_REMOTE_PROGRAM_ID);

  return { curses, config };
}

/**
 * Fetch the Token Pool Lookup Table address from the Token Admin Registry
 * The lookup table address is stored in the registry account data
 *
 * TokenAdminRegistry PDA layout (Anchor/Borsh serialized):
 * - discriminator: 8 bytes (Anchor account discriminator)
 * - administrator: 32 bytes (Pubkey)
 * - pending_administrator: 32 bytes (Pubkey)
 * - pool_lookuptable: 32 bytes (Pubkey)
 *
 * Total offset to pool_lookuptable: 8 + 32 + 32 = 72 bytes
 *
 * See:
 * - https://docs.chain.link/ccip/concepts/cross-chain-token/svm/architecture
 * - https://docs.chain.link/ccip/concepts/cross-chain-token/svm/token-pools
 */
async function fetchTokenPoolLookupTable(connection: Connection, tokenMint: PublicKey): Promise<PublicKey> {
  // Derive Token Admin Registry PDA
  const [tokenAdminRegistry] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_admin_registry'), tokenMint.toBytes()],
    CCIP_ROUTER_PROGRAM_ID,
  );

  // Fetch the account data
  const accountInfo = await connection.getAccountInfo(tokenAdminRegistry);
  if (!accountInfo || !accountInfo.data) {
    throw new Error(`Token Admin Registry not found for mint: ${tokenMint.toBase58()}`);
  }

  // Parse the pool_lookuptable address from the account data
  // Layout: discriminator (8) + administrator (32) + pending_administrator (32) + pool_lookuptable (32)
  const ANCHOR_DISCRIMINATOR_SIZE = 8;
  const lookupTableOffset = ANCHOR_DISCRIMINATOR_SIZE + 32 + 32; // = 72 bytes

  const minRequiredSize = lookupTableOffset + 32;
  if (accountInfo.data.length < minRequiredSize) {
    throw new Error(
      `Token Admin Registry data too short: expected at least ${minRequiredSize} bytes, got ${accountInfo.data.length}`,
    );
  }

  const lookupTableBytes = accountInfo.data.slice(lookupTableOffset, lookupTableOffset + 32);
  const poolLookupTable = new PublicKey(lookupTableBytes);

  // Validate the lookup table is not zero/default pubkey
  if (poolLookupTable.equals(PublicKey.default)) {
    throw new Error(`Token ${tokenMint.toBase58()} is not enabled for CCIP (pool_lookuptable is zero address).`);
  }

  return poolLookupTable;
}

/**
 * Derive Token Pool PDAs for CCIP token transfers
 */
function deriveTokenPoolPDAs(
  destChainSelector: bigint,
  tokenMint: PublicKey,
  poolProgram: PublicKey,
): {
  tokenAdminRegistry: PublicKey;
  poolChainConfig: PublicKey;
  poolSigner: PublicKey;
  routerPoolsSigner: PublicKey;
  poolConfig: PublicKey;
} {
  const destChainSelectorBuf = Buffer.alloc(8);
  destChainSelectorBuf.writeBigUInt64LE(destChainSelector, 0);

  // Token Admin Registry: ["token_admin_registry", tokenMint] from CCIP Router
  const [tokenAdminRegistry] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_admin_registry'), tokenMint.toBytes()],
    CCIP_ROUTER_PROGRAM_ID,
  );

  // Pool Chain Config: ["ccip_tokenpool_chainconfig", destChainSelector, tokenMint] from Pool
  const [poolChainConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('ccip_tokenpool_chainconfig'), destChainSelectorBuf, tokenMint.toBytes()],
    poolProgram,
  );

  // Pool Signer: ["ccip_tokenpool_signer"] from Pool
  const [poolSigner] = PublicKey.findProgramAddressSync([Buffer.from('ccip_tokenpool_signer')], poolProgram);

  // Pool Config: ["ccip_tokenpool_config"] from Pool
  const [poolConfig] = PublicKey.findProgramAddressSync([Buffer.from('ccip_tokenpool_config')], poolProgram);

  // CCIP Router Pools Signer: ["external_token_pools_signer", poolProgram] from CCIP Router
  const [routerPoolsSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from('external_token_pools_signer'), poolProgram.toBytes()],
    CCIP_ROUTER_PROGRAM_ID,
  );

  return { tokenAdminRegistry, poolChainConfig, poolSigner, routerPoolsSigner, poolConfig };
}

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
 * Build CCIP EVMExtraArgsV2 for EVM destination (Borsh serialized)
 * See: https://docs.chain.link/ccip/api-reference/svm/v1.6.0/messages#evmextraargsv2
 *
 * Format:
 * - Tag: 4 bytes big-endian (0x181dcf10)
 * - gas_limit: u128 (16 bytes little-endian, Borsh)
 * - allow_out_of_order_execution: bool (1 byte)
 */
function buildEVMExtraArgsV2(gasLimit: number = 0, allowOutOfOrderExecution: boolean = true): Uint8Array {
  // EVM_EXTRA_ARGS_V2_TAG: 0x181dcf10 (4 bytes, big-endian)
  const typeTag = Buffer.alloc(4);
  typeTag.writeUInt32BE(0x181dcf10, 0);

  // gas_limit: u128 little-endian (16 bytes) - Borsh format
  // For token-only transfers, gas_limit MUST be 0
  const gasLimitBuf = Buffer.alloc(16);
  const gasLimitBigInt = BigInt(gasLimit);
  gasLimitBuf.writeBigUInt64LE(gasLimitBigInt & BigInt('0xFFFFFFFFFFFFFFFF'), 0);
  gasLimitBuf.writeBigUInt64LE(gasLimitBigInt >> BigInt(64), 8);

  // allow_out_of_order_execution: bool (1 byte)
  // MUST be true when sending from Solana
  const oooBuf = Buffer.alloc(1);
  oooBuf.writeUInt8(allowOutOfOrderExecution ? 1 : 0, 0);

  return Buffer.concat([typeTag, gasLimitBuf, oooBuf]);
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
      extraArgs: buildEVMExtraArgsV2(0, true), // gasLimit=0 for token-only, OOO=true required for Solana
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

    // Derive all required PDAs for CCIP send instruction
    // See: https://docs.chain.link/ccip/tutorials/svm/source/token-transfers
    const destChainSelector = BigInt(ETHEREUM_CHAIN_SELECTOR);

    // Core Router PDAs
    const routerPDAs = deriveCCIPRouterPDAs(destChainSelector, walletPublicKey);

    // Fee Quoter PDAs - using WSOL as fee token since we pay in native SOL
    const feeQuoterPDAs = deriveFeeQuoterPDAs(destChainSelector, WSOL_MINT, LINK_TOKEN_MINT);

    // RMN Remote PDAs
    const rmnPDAs = deriveRMNRemotePDAs();

    // Token Pool PDAs for USDC (using LockRelease pool)
    const tokenPoolPDAs = deriveTokenPoolPDAs(destChainSelector, USDC_SOLANA_MINT, CCIP_LOCK_RELEASE_POOL_PROGRAM_ID);

    // Fetch the Token Pool Lookup Table address from Token Admin Registry
    const tokenPoolLookupTable = await fetchTokenPoolLookupTable(connection, USDC_SOLANA_MINT);

    logger.debug('Fetched Token Pool Lookup Table', {
      requestId,
      tokenMint: USDC_SOLANA_MINT.toBase58(),
      lookupTable: tokenPoolLookupTable.toBase58(),
    });

    // Get pool's token account for USDC (where locked tokens go)
    const poolTokenAccount = await getAssociatedTokenAddress(USDC_SOLANA_MINT, tokenPoolPDAs.poolSigner, true);

    // Fee receiver account - derived from fee billing signer
    const [feeReceiver] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_receiver'), WSOL_MINT.toBytes()],
      CCIP_ROUTER_PROGRAM_ID,
    );

    logger.debug('CCIP PDAs derived', {
      requestId,
      routerConfig: routerPDAs.config.toBase58(),
      destChainState: routerPDAs.destChainState.toBase58(),
      nonce: routerPDAs.nonce.toBase58(),
      tokenAdminRegistry: tokenPoolPDAs.tokenAdminRegistry.toBase58(),
      poolChainConfig: tokenPoolPDAs.poolChainConfig.toBase58(),
    });

    // Create CCIP send instruction with all required accounts
    // See: https://docs.chain.link/ccip/tutorials/svm/source/token-transfers#account-requirements
    const ccipSendInstruction = new TransactionInstruction({
      keys: [
        // === Core Accounts (indices 0-4) ===
        { pubkey: routerPDAs.config, isSigner: false, isWritable: false }, // 0: Config PDA
        { pubkey: routerPDAs.destChainState, isSigner: false, isWritable: true }, // 1: Destination Chain State (writable)
        { pubkey: routerPDAs.nonce, isSigner: false, isWritable: true }, // 2: Nonce (writable)
        { pubkey: walletPublicKey, isSigner: true, isWritable: true }, // 3: Authority/Signer (writable, signer)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 4: System Program

        // === Fee Payment Accounts (indices 5-9) ===
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 5: Fee Token Program
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false }, // 6: Fee Token Mint (WSOL for internal accounting)
        { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // 7: User's Fee Token Account
        { pubkey: feeReceiver, isSigner: false, isWritable: true }, // 8: Fee Receiver (writable)
        { pubkey: routerPDAs.feeBillingSigner, isSigner: false, isWritable: false }, // 9: Fee Billing Signer PDA

        // === Fee Quoter Accounts (indices 10-14) ===
        { pubkey: CCIP_FEE_QUOTER_PROGRAM_ID, isSigner: false, isWritable: false }, // 10: Fee Quoter Program
        { pubkey: feeQuoterPDAs.config, isSigner: false, isWritable: false }, // 11: Fee Quoter Config
        { pubkey: feeQuoterPDAs.destChain, isSigner: false, isWritable: false }, // 12: Fee Quoter Dest Chain
        { pubkey: feeQuoterPDAs.billingTokenConfig, isSigner: false, isWritable: false }, // 13: Fee Quoter Billing Token Config
        { pubkey: feeQuoterPDAs.linkTokenConfig, isSigner: false, isWritable: false }, // 14: Fee Quoter Link Token Config

        // === RMN Remote Accounts (indices 15-17) ===
        { pubkey: CCIP_RMN_REMOTE_PROGRAM_ID, isSigner: false, isWritable: false }, // 15: RMN Remote Program
        { pubkey: rmnPDAs.curses, isSigner: false, isWritable: false }, // 16: RMN Remote Curses
        { pubkey: rmnPDAs.config, isSigner: false, isWritable: false }, // 17: RMN Remote Config

        // === Token Transfer Accounts (for USDC) ===
        // Per CCIP API Reference, token accounts must be in remaining_accounts with this structure:
        // See: https://docs.chain.link/ccip/api-reference/svm/v1.6.0/router
        { pubkey: sourceTokenAccount, isSigner: false, isWritable: true }, // 18: User Token Account (writable)
        { pubkey: feeQuoterPDAs.billingTokenConfig, isSigner: false, isWritable: false }, // 19: Token Billing Config (USDC)
        { pubkey: tokenPoolPDAs.poolChainConfig, isSigner: false, isWritable: true }, // 20: Pool Chain Config (writable)
        { pubkey: tokenPoolLookupTable, isSigner: false, isWritable: false }, // 21: Token Pool Lookup Table
        { pubkey: tokenPoolPDAs.tokenAdminRegistry, isSigner: false, isWritable: false }, // 22: Token Admin Registry
        { pubkey: CCIP_LOCK_RELEASE_POOL_PROGRAM_ID, isSigner: false, isWritable: false }, // 23: Pool Program
        { pubkey: tokenPoolPDAs.poolConfig, isSigner: false, isWritable: false }, // 24: Pool Config
        { pubkey: poolTokenAccount, isSigner: false, isWritable: true }, // 25: Pool Token Account (writable)
        { pubkey: tokenPoolPDAs.poolSigner, isSigner: false, isWritable: false }, // 26: Pool Signer
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 27: Token Program
        { pubkey: USDC_SOLANA_MINT, isSigner: false, isWritable: false }, // 28: Token Mint
        { pubkey: feeQuoterPDAs.billingTokenConfig, isSigner: false, isWritable: false }, // 29: Fee Token Config (for USDC billing)
        { pubkey: tokenPoolPDAs.routerPoolsSigner, isSigner: false, isWritable: false }, // 30: CCIP Router Pools Signer
      ],
      programId: CCIP_ROUTER_PROGRAM_ID,
      data: instructionData,
    });

    logger.info('CCIP instruction built with full account list', {
      requestId,
      totalAccounts: ccipSendInstruction.keys.length,
      instructionDataLength: instructionData.length,
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
  const { logger, requestId, config, chainService, rebalance, solanaSigner } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  logger.debug('Logging solana Private key', {
    requestId,
    solanaConfig: config.solana,
    signer: solanaSigner
  })

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
  const maxRebalanceAmount = maxRebalanceAmountEnv ? safeParseBigInt(maxRebalanceAmountEnv) : DEFAULT_MAX_REBALANCE_AMOUNT;

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
  const { operations: pendingOps } = await context.database.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });

  const inFlightSolanaOps = pendingOps.filter(
    (op) => op.bridge === 'ccip-solana-mainnet' && op.originChainId === Number(SOLANA_CHAINID),
  );

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
      context: { requestId, logger, config, chainService },
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

    // Check for operation timeout - mark as failed if stuck for too long
    if (operation.createdAt && isOperationTimedOut(new Date(operation.createdAt))) {
      logger.warn('Operation has exceeded TTL, marking as FAILED', {
        ...logContext,
        createdAt: operation.createdAt,
        ttlMinutes: DEFAULT_OPERATION_TTL_MINUTES,
      });
      await db.updateRebalanceOperation(operation.id, {
        status: RebalanceOperationStatus.FAILED,
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

    // Check for operation timeout - mark as failed if stuck for too long
    if (operation.createdAt && isOperationTimedOut(new Date(operation.createdAt))) {
      logger.warn('AWAITING_CALLBACK operation has exceeded TTL, marking as FAILED', {
        ...logContext,
        createdAt: operation.createdAt,
        ttlMinutes: DEFAULT_OPERATION_TTL_MINUTES,
        note: 'Leg 3 CCIP may have failed or taken too long',
      });
      await db.updateRebalanceOperation(operation.id, {
        status: RebalanceOperationStatus.FAILED,
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
