/**
 * Solana Signing Service
 *
 * This module provides Solana transaction signing following the same patterns
 * as the existing ChainService for EVM chains.
 *
 * Key Management:
 * - Private keys loaded from AWS SSM Parameter Store (SecureString)
 * - Keys decoded from base58 format at runtime
 * - Signing happens in-memory using @solana/web3.js Keypair
 * - Connection pooling for RPC efficiency
 *
 * Security:
 * - Private keys never leave the AWS environment
 * - Keys are not logged or exposed in error messages
 * - SSM Parameter Store provides encryption at rest
 * - Lambda execution role requires ssm:GetParameter permission
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Configuration for the Solana signer
 */
export interface SolanaSignerConfig {
  /** Base58-encoded private key (64 bytes / 88 characters) */
  privateKey: string;
  /** Solana RPC URL (defaults to mainnet-beta) */
  rpcUrl?: string;
  /** Connection commitment level for confirmations */
  commitment?: 'confirmed' | 'finalized';
  /** Maximum retries for transaction confirmation */
  maxRetries?: number;
  /** Whether to skip preflight checks */
  skipPreflight?: boolean;
}

/**
 * Result of a Solana transaction submission
 */
export interface SolanaTransactionResult {
  /** Transaction signature (base58 encoded) */
  signature: string;
  /** Slot number where the transaction was processed */
  slot: number;
  /** Block time (Unix timestamp) */
  blockTime: number | null;
  /** Whether the transaction was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Transaction fee in lamports */
  fee: number;
  /** Log messages from the transaction */
  logs: string[];
}

/**
 * Solana transaction request structure
 */
export interface SolanaTransactionRequest {
  /** Transaction instructions */
  instructions: TransactionInstruction[];
  /** Optional fee payer (defaults to signer) */
  feePayer?: PublicKey;
  /** Optional compute budget (priority fee) */
  computeUnitPrice?: number;
  /** Optional compute unit limit */
  computeUnitLimit?: number;
}

/**
 * Solana signing service
 *
 * Usage:
 * ```typescript
 * const signer = new SolanaSigner({
 *   privateKey: config.solana.privateKey, // Loaded from SSM
 *   rpcUrl: config.solana.rpcUrl,
 * });
 *
 * const result = await signer.signAndSendTransaction({
 *   instructions: [myInstruction],
 * });
 * ```
 */
export class SolanaSigner {
  private readonly keypair: Keypair;
  private readonly connection: Connection;
  private readonly config: Required<SolanaSignerConfig>;

  constructor(config: SolanaSignerConfig) {
    // Validate and decode private key
    if (!config.privateKey) {
      throw new Error('Solana private key is required');
    }

    try {
      const privateKeyBytes = bs58.decode(config.privateKey);

      // Validate key length (should be 64 bytes for ed25519 keypair)
      if (privateKeyBytes.length !== 64) {
        throw new Error(`Invalid Solana private key length: expected 64 bytes, got ${privateKeyBytes.length}`);
      }

      this.keypair = Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      // Don't expose key details in error
      throw new Error(
        `Failed to decode Solana private key: ${(error as Error).message.replace(/[A-Za-z0-9]{32,}/g, '[REDACTED]')}`,
      );
    }

    // Set defaults
    this.config = {
      privateKey: config.privateKey,
      rpcUrl: config.rpcUrl || 'https://api.mainnet-beta.solana.com',
      commitment: config.commitment || 'confirmed',
      maxRetries: config.maxRetries || 3,
      skipPreflight: config.skipPreflight ?? false,
    };

    // Create connection with retry and timeout settings
    this.connection = new Connection(this.config.rpcUrl, {
      commitment: this.config.commitment,
      confirmTransactionInitialTimeout: 60000, // 60 seconds
    });
  }

  /**
   * Get the public key of the signer
   */
  getPublicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  /**
   * Get the base58 address of the signer
   */
  getAddress(): string {
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Get the underlying connection for read operations
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Sign a transaction without sending it
   */
  signTransaction(transaction: Transaction): Transaction {
    transaction.sign(this.keypair);
    return transaction;
  }

  /**
   * Sign a versioned transaction without sending it
   */
  signVersionedTransaction(transaction: VersionedTransaction): VersionedTransaction {
    transaction.sign([this.keypair]);
    return transaction;
  }

  /**
   * Build a transaction from instructions with optional compute budget
   */
  async buildTransaction(request: SolanaTransactionRequest): Promise<Transaction> {
    const { instructions, feePayer, computeUnitPrice, computeUnitLimit } = request;

    const transaction = new Transaction();

    // Add compute budget instructions if specified (for priority fees)
    if (computeUnitLimit) {
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: computeUnitLimit,
        }),
      );
    }

    if (computeUnitPrice) {
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: computeUnitPrice,
        }),
      );
    }

    // Add user instructions
    for (const instruction of instructions) {
      transaction.add(instruction);
    }

    // Set fee payer and recent blockhash
    transaction.feePayer = feePayer || this.keypair.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.config.commitment);
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;

    return transaction;
  }

  /**
   * Sign and send a transaction with automatic retry and confirmation
   */
  async signAndSendTransaction(request: SolanaTransactionRequest): Promise<SolanaTransactionResult> {
    // Build the transaction
    const transaction = await this.buildTransaction(request);

    // Sign and send with retries
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const signature = await sendAndConfirmTransaction(this.connection, transaction, [this.keypair], {
          commitment: this.config.commitment,
          skipPreflight: this.config.skipPreflight,
          maxRetries: 0, // We handle retries ourselves
        });

        // Get transaction details
        const txDetails = await this.connection.getTransaction(signature, {
          commitment: this.config.commitment,
          maxSupportedTransactionVersion: 0,
        });

        return {
          signature,
          slot: txDetails?.slot || 0,
          blockTime: txDetails?.blockTime || null,
          success: txDetails?.meta?.err === null,
          error: txDetails?.meta?.err ? JSON.stringify(txDetails.meta.err) : undefined,
          fee: txDetails?.meta?.fee || 0,
          logs: txDetails?.meta?.logMessages || [],
        };
      } catch (error) {
        lastError = error as Error;

        // Check if this is a retryable error
        const isRetryable = this.isRetryableError(error);

        if (!isRetryable || attempt >= this.config.maxRetries) {
          break;
        }

        // Exponential backoff
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await this.delay(backoffMs);

        // Get fresh blockhash for retry
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.config.commitment);
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
      }
    }

    // All retries exhausted
    const errorMessage = this.sanitizeErrorMessage(lastError);
    return {
      signature: '',
      slot: 0,
      blockTime: null,
      success: false,
      error: errorMessage,
      fee: 0,
      logs: [],
    };
  }

  /**
   * Send a pre-signed transaction
   */
  async sendSignedTransaction(transaction: Transaction | VersionedTransaction): Promise<SolanaTransactionResult> {
    try {
      const serialized = transaction.serialize();
      const signature = await this.connection.sendRawTransaction(serialized, {
        skipPreflight: this.config.skipPreflight,
        maxRetries: this.config.maxRetries,
      });

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(signature, this.config.commitment);

      if (confirmation.value.err) {
        return {
          signature,
          slot: confirmation.context.slot,
          blockTime: null,
          success: false,
          error: JSON.stringify(confirmation.value.err),
          fee: 0,
          logs: [],
        };
      }

      // Get full transaction details
      const txDetails = await this.connection.getTransaction(signature, {
        commitment: this.config.commitment,
        maxSupportedTransactionVersion: 0,
      });

      return {
        signature,
        slot: txDetails?.slot || confirmation.context.slot,
        blockTime: txDetails?.blockTime || null,
        success: true,
        fee: txDetails?.meta?.fee || 0,
        logs: txDetails?.meta?.logMessages || [],
      };
    } catch (error) {
      return {
        signature: '',
        slot: 0,
        blockTime: null,
        success: false,
        error: this.sanitizeErrorMessage(error),
        fee: 0,
        logs: [],
      };
    }
  }

  /**
   * Get SOL balance for the signer
   */
  async getBalance(): Promise<number> {
    return this.connection.getBalance(this.keypair.publicKey);
  }

  /**
   * Get SPL token balance
   */
  async getTokenBalance(tokenAccount: PublicKey): Promise<bigint> {
    try {
      const balance = await this.connection.getTokenAccountBalance(tokenAccount);
      return BigInt(balance.value.amount);
    } catch {
      return 0n;
    }
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (!error) return false;

    const errorMessage = (error as Error).message || '';
    const retryablePatterns = [
      'blockhash not found',
      'block height exceeded',
      'network error',
      'timeout',
      'ECONNRESET',
      'ETIMEDOUT',
      'socket hang up',
      'rate limit',
      '429',
      '503',
      '502',
    ];

    return retryablePatterns.some((pattern) => errorMessage.toLowerCase().includes(pattern.toLowerCase()));
  }

  /**
   * Sanitize error message to avoid exposing sensitive data
   */
  private sanitizeErrorMessage(error: unknown): string {
    if (!error) return 'Unknown error';

    let message = (error as Error).message || String(error);

    // Redact potential private key or address patterns
    message = message.replace(/[A-Za-z0-9]{44,}/g, '[REDACTED]');

    // Limit message length
    if (message.length > 500) {
      message = message.substring(0, 500) + '...';
    }

    return message;
  }

  /**
   * Async delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Factory function to create a SolanaSigner from configuration
 * This follows the same pattern as EthWallet in chainservice
 */
export function createSolanaSigner(config: SolanaSignerConfig): SolanaSigner {
  return new SolanaSigner(config);
}
