/**
 * Shamir's Secret Sharing implementation for 2-of-2 threshold scheme.
 *
 * Uses the secrets.js-grempe library for cryptographic operations.
 * Provides functions to split secrets into shares and reconstruct them.
 *
 * Mathematical basis:
 * - A degree-1 polynomial P(x) = S + a₁·x is created where S is the secret
 * - Share 1 = P(1), Share 2 = P(2)
 * - Reconstruction uses Lagrange interpolation to find P(0) = S
 *
 * Share format (secrets.js-grempe native):
 * - A hex string with embedded metadata
 * - First 3 chars: bits (1 char) + share ID (2 chars hex)
 * - Remaining chars: share data
 * - Example: "8014e4817757..." where 8=bits(8), 01=ID(1), rest=data
 */

import { ShamirShare, ShamirSplitConfig, SplitResult, ShardError, ShardErrorCode } from './types';

// Dynamic import to handle missing dependency gracefully
let secrets: typeof import('secrets.js-grempe') | null = null;

/**
 * Initialize the secrets library.
 * Called lazily on first use.
 */
async function ensureSecretsLoaded(): Promise<typeof import('secrets.js-grempe')> {
  if (secrets) {
    return secrets;
  }

  try {
    secrets = await import('secrets.js-grempe');
    return secrets;
  } catch {
    throw new ShardError(
      'secrets.js-grempe library not found. Install with: npm install secrets.js-grempe',
      ShardErrorCode.RECONSTRUCTION_FAILED,
      { suggestion: 'npm install secrets.js-grempe' },
    );
  }
}

/**
 * Synchronous version using require - for use when we know the module exists.
 * Falls back to throwing if not available.
 */
function getSecretsSync(): typeof import('secrets.js-grempe') {
  if (secrets) {
    return secrets;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    secrets = require('secrets.js-grempe');
    return secrets!;
  } catch {
    throw new ShardError(
      'secrets.js-grempe library not found. Install with: npm install secrets.js-grempe',
      ShardErrorCode.RECONSTRUCTION_FAILED,
      { suggestion: 'npm install secrets.js-grempe' },
    );
  }
}

/**
 * Split a secret into Shamir shares using polynomial interpolation.
 *
 * @param secret - The secret string to split
 * @param config - Optional configuration for the split operation
 * @returns Array of share strings in secrets.js-grempe native format
 *
 * @example
 * const shares = shamirSplit("my-secret-key");
 * // shares = ["8014e4817757...", "8029c902eeaf..."]
 */
export function shamirSplit(secret: string, config: ShamirSplitConfig = {}): string[] {
  const { numShares = 2, threshold = 2, padLength } = config;

  if (!secret) {
    throw new ShardError('Secret cannot be empty', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  if (threshold > numShares) {
    throw new ShardError(
      `Threshold (${threshold}) cannot exceed number of shares (${numShares})`,
      ShardErrorCode.INVALID_SHARE_FORMAT,
    );
  }

  if (threshold < 2) {
    throw new ShardError('Threshold must be at least 2', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  const lib = getSecretsSync();

  // Convert secret to hex
  let hexSecret = lib.str2hex(secret);

  // Optional: pad to fixed length to prevent length-based analysis
  // NOTE: When padding is used, the PADDED_SECRET_MARKER prefix indicates unpadding is needed.
  // Format: PADDED_SECRET_MARKER (4 hex) + originalLength (4 hex) + secret + random padding
  const PADDED_SECRET_MARKER = 'ffff'; // Magic marker to indicate padded secret
  if (padLength && hexSecret.length < padLength * 2) {
    const originalLength = hexSecret.length;
    const paddingNeeded = padLength * 2 - hexSecret.length - 8; // Account for marker + length prefix
    if (paddingNeeded > 0) {
      const padding = lib.random(paddingNeeded * 4); // random() takes bits, returns bits/4 hex chars
      // Format: marker + originalLength (hex) + secret + padding
      hexSecret = PADDED_SECRET_MARKER + originalLength.toString(16).padStart(4, '0') + hexSecret + padding;
    }
  }

  // Generate shares using Shamir's algorithm
  // Returns array of hex strings with embedded metadata
  const shares = lib.share(hexSecret, numShares, threshold);

  return shares;
}

/**
 * Split a secret and return a structured result object.
 * Convenience wrapper around shamirSplit for 2-of-2 splits.
 *
 * @param secret - The secret string to split
 * @returns Object with share1 and share2 properties
 */
export function shamirSplitPair(secret: string): SplitResult {
  const shares = shamirSplit(secret, { numShares: 2, threshold: 2 });

  if (shares.length !== 2) {
    throw new ShardError('Expected exactly 2 shares from split operation', ShardErrorCode.RECONSTRUCTION_FAILED);
  }

  return {
    share1: shares[0],
    share2: shares[1],
  };
}

/**
 * Parse a Shamir share string into its components.
 * Uses the secrets.js-grempe extractShareComponents function.
 *
 * Share format: A hex string with embedded metadata
 * - First char: bits indicator (usually '8' for 8-bit)
 * - Next 2 chars: share ID in hex (01, 02, etc.)
 * - Remaining: share data
 *
 * @param shareString - Share string to parse
 * @returns Parsed share with index and data
 * @throws ShardError if format is invalid
 *
 * @example
 * parseShare("8014e4817757...") // { index: 1, data: "4e4817757..." }
 */
export function parseShare(shareString: string): ShamirShare {
  if (!shareString || typeof shareString !== 'string') {
    throw new ShardError('Share must be a non-empty string', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  // Minimum length: 3 chars metadata + at least 1 char data
  if (shareString.length < 4) {
    throw new ShardError('Share string too short', ShardErrorCode.INVALID_SHARE_FORMAT, { length: shareString.length });
  }

  // Validate hex format
  // SECURITY: Never log share values, even partially - only log length for debugging
  if (!/^[0-9a-f]+$/i.test(shareString)) {
    throw new ShardError('Share must be valid hexadecimal', ShardErrorCode.INVALID_SHARE_FORMAT, {
      shareLength: shareString.length,
    });
  }

  const lib = getSecretsSync();

  try {
    const components = lib.extractShareComponents(shareString);
    return {
      index: components.id,
      data: components.data,
    };
  } catch (error) {
    throw new ShardError(`Failed to parse share: ${(error as Error).message}`, ShardErrorCode.INVALID_SHARE_FORMAT, {
      shareLength: shareString.length,
    });
  }
}

/**
 * Format a share object back to string representation.
 * Note: This creates a new share in secrets.js-grempe format.
 *
 * @param share - Share object with index and data
 * @returns Share string in secrets.js-grempe format
 */
export function formatShare(share: ShamirShare): string {
  if (!share || typeof share.index !== 'number' || typeof share.data !== 'string') {
    throw new ShardError('Invalid share object', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  // Reconstruct the native format: bits (1 char) + id (2 chars hex) + data
  // Default bits is '8' (8-bit mode)
  const idHex = share.index.toString(16).padStart(2, '0');
  return `8${idHex}${share.data}`;
}

/**
 * Validate that a share string is properly formatted.
 *
 * @param shareString - Share string to validate
 * @returns true if valid, false otherwise
 */
export function isValidShare(shareString: string): boolean {
  try {
    parseShare(shareString);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconstruct a secret from Shamir shares using Lagrange interpolation.
 * Requires at least 2 shares for a 2-of-2 threshold scheme.
 *
 * @param shares - Array of share strings in secrets.js-grempe format
 * @returns The reconstructed secret string
 * @throws ShardError if reconstruction fails
 *
 * @example
 * const secret = shamirReconstruct(["8014e48...", "8029c90..."]);
 */
export function shamirReconstruct(shares: string[]): string {
  if (!shares || !Array.isArray(shares)) {
    throw new ShardError('Shares must be a non-empty array', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  if (shares.length < 2) {
    throw new ShardError(
      `At least 2 shares required for reconstruction, got ${shares.length}`,
      ShardErrorCode.RECONSTRUCTION_FAILED,
    );
  }

  // Validate all shares are properly formatted and get parsed components
  const parsed = shares.map((share, idx) => {
    try {
      return parseShare(share);
    } catch (error) {
      throw new ShardError(`Share ${idx} is invalid: ${(error as Error).message}`, ShardErrorCode.INVALID_SHARE_FORMAT);
    }
  });

  // Validate all shares have unique indices
  const indices = new Set(parsed.map((s) => s.index));
  if (indices.size !== shares.length) {
    throw new ShardError('All shares must have unique indices', ShardErrorCode.INVALID_SHARE_FORMAT, {
      indices: parsed.map((s) => s.index),
    });
  }

  // Validate all shares have the same data length (same secret was split)
  const dataLengths = parsed.map((s) => s.data.length);
  const uniqueLengths = new Set(dataLengths);
  if (uniqueLengths.size !== 1) {
    throw new ShardError(
      'All shares must have the same data length. Shares may be from different secrets.',
      ShardErrorCode.LENGTH_MISMATCH,
      { dataLengths },
    );
  }

  const lib = getSecretsSync();

  try {
    // Combine shares using Lagrange interpolation
    let hexSecret = lib.combine(shares);

    // Check for padded secret marker and unpad if necessary
    const PADDED_SECRET_MARKER = 'ffff';
    if (hexSecret.startsWith(PADDED_SECRET_MARKER)) {
      // Extract original length from next 4 hex chars
      const originalLengthHex = hexSecret.substring(4, 8);
      const originalLength = parseInt(originalLengthHex, 16);

      // Extract the actual secret (skip marker and length prefix)
      hexSecret = hexSecret.substring(8, 8 + originalLength);
    }

    // Convert hex back to string
    const secret = lib.hex2str(hexSecret);

    return secret;
  } catch (error) {
    throw new ShardError(
      `Shamir reconstruction failed: ${(error as Error).message}`,
      ShardErrorCode.RECONSTRUCTION_FAILED,
      { shareCount: shares.length },
    );
  }
}

/**
 * Reconstruct a secret from exactly two shares.
 * Convenience wrapper for the common 2-of-2 case.
 *
 * @param share1 - First share (typically from AWS)
 * @param share2 - Second share (typically from GCP)
 * @returns The reconstructed secret string
 */
export function shamirReconstructPair(share1: string, share2: string): string {
  return shamirReconstruct([share1, share2]);
}

/**
 * Verify that two shares can successfully reconstruct to a given secret.
 * Useful for validating shares before storing them.
 *
 * @param secret - The original secret
 * @param share1 - First share
 * @param share2 - Second share
 * @returns true if shares reconstruct to the secret
 */
export function verifyShares(secret: string, share1: string, share2: string): boolean {
  try {
    const reconstructed = shamirReconstructPair(share1, share2);
    return reconstructed === secret;
  } catch {
    return false;
  }
}

/**
 * Generate random bytes for testing or padding.
 *
 * @param byteCount - Number of random bytes to generate
 * @returns Hex-encoded random string (2 hex chars per byte)
 */
export function generateRandomHex(byteCount: number = 32): string {
  const lib = getSecretsSync();
  // secrets.random(bits) returns bits/4 hex characters
  // For byteCount bytes, we need byteCount * 8 bits
  return lib.random(byteCount * 8);
}

/**
 * Async version of split for environments requiring dynamic import.
 */
export async function shamirSplitAsync(secret: string, config: ShamirSplitConfig = {}): Promise<string[]> {
  await ensureSecretsLoaded();
  return shamirSplit(secret, config);
}

/**
 * Async version of reconstruct for environments requiring dynamic import.
 */
export async function shamirReconstructAsync(shares: string[]): Promise<string> {
  await ensureSecretsLoaded();
  return shamirReconstruct(shares);
}

// Export the library getter for advanced usage
export { getSecretsSync as getSecretsLibrary };
