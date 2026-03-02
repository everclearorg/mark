/**
 * XOR-based secret splitting utilities.
 *
 * Provides an alternative to Shamir's Secret Sharing for simpler use cases.
 * Uses XOR operation: Secret = ShardA XOR ShardB
 *
 * Security: Each shard is uniformly random and reveals nothing about the secret.
 * However, unlike Shamir, XOR cannot be extended to k-of-n threshold schemes.
 */

import * as crypto from 'crypto';
import { ShardError, ShardErrorCode, SplitResult } from './types';

/**
 * Split a secret into two XOR shards.
 *
 * Algorithm:
 * 1. Convert secret to bytes
 * 2. Generate random bytes of same length for Shard B
 * 3. Compute Shard A = Secret XOR Shard B
 *
 * @param secret - Original secret string
 * @returns Object with base64-encoded shardA and shardB
 *
 * @example
 * const { shardA, shardB } = xorSplit("my-secret");
 * // shardA and shardB are base64-encoded
 */
export function xorSplit(secret: string): SplitResult {
  if (!secret) {
    throw new ShardError('Secret cannot be empty', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  const secretBytes = Buffer.from(secret, 'utf8');

  // Generate cryptographically random bytes for Shard B
  const shardBBytes = crypto.randomBytes(secretBytes.length);

  // Compute Shard A = Secret XOR Shard B
  const shardABytes = Buffer.alloc(secretBytes.length);
  for (let i = 0; i < secretBytes.length; i++) {
    shardABytes[i] = secretBytes[i] ^ shardBBytes[i];
  }

  return {
    share1: shardABytes.toString('base64'),
    share2: shardBBytes.toString('base64'),
  };
}

/**
 * Reconstruct a secret from two XOR shards.
 *
 * Algorithm: Secret = Shard A XOR Shard B
 *
 * @param shardA - Base64-encoded Shard A
 * @param shardB - Base64-encoded Shard B
 * @returns The reconstructed secret string
 *
 * @example
 * const secret = xorReconstruct(shardA, shardB);
 */
export function xorReconstruct(shardA: string, shardB: string): string {
  if (!shardA || !shardB) {
    throw new ShardError('Both shards are required for XOR reconstruction', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  let shardABytes: Buffer;
  let shardBBytes: Buffer;

  try {
    shardABytes = Buffer.from(shardA, 'base64');
  } catch {
    throw new ShardError('Shard A is not valid base64', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  try {
    shardBBytes = Buffer.from(shardB, 'base64');
  } catch {
    throw new ShardError('Shard B is not valid base64', ShardErrorCode.INVALID_SHARE_FORMAT);
  }

  if (shardABytes.length !== shardBBytes.length) {
    throw new ShardError(
      `Shard length mismatch: A=${shardABytes.length}, B=${shardBBytes.length}`,
      ShardErrorCode.LENGTH_MISMATCH,
      { shardALength: shardABytes.length, shardBLength: shardBBytes.length },
    );
  }

  // Compute Secret = Shard A XOR Shard B
  const secretBytes = Buffer.alloc(shardABytes.length);
  for (let i = 0; i < shardABytes.length; i++) {
    secretBytes[i] = shardABytes[i] ^ shardBBytes[i];
  }

  return secretBytes.toString('utf8');
}

/**
 * Verify that two XOR shards can reconstruct to a given secret.
 *
 * @param secret - The original secret
 * @param shardA - Base64-encoded Shard A
 * @param shardB - Base64-encoded Shard B
 * @returns true if shards reconstruct to the secret
 */
export function xorVerify(secret: string, shardA: string, shardB: string): boolean {
  try {
    const reconstructed = xorReconstruct(shardA, shardB);
    return reconstructed === secret;
  } catch {
    return false;
  }
}

/**
 * Check if a string is valid base64.
 */
export function isValidBase64(str: string): boolean {
  if (!str || typeof str !== 'string') {
    return false;
  }

  // Base64 regex pattern
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;

  if (!base64Regex.test(str)) {
    return false;
  }

  try {
    Buffer.from(str, 'base64');
    return true;
  } catch {
    return false;
  }
}
