/**
 * Cross-Cloud Key Sharding Module
 *
 * This module enables splitting sensitive configuration fields across
 * AWS SSM and GCP Secret Manager using Shamir's Secret Sharing.
 *
 * At runtime, both shares are fetched and reconstructed transparently,
 * requiring no changes to downstream code.
 *
 * @example
 * // In loadConfiguration():
 * import { stitchConfig, loadManifest } from './shard';
 *
 * const manifest = loadManifest(configJson, envManifest, localPath);
 * if (manifest) {
 *   configJson = await stitchConfig(configJson, manifest);
 * }
 *
 * @packageDocumentation
 */

// ============================================================================
// Main stitcher functionality
// ============================================================================
export {
  stitchConfig,
  loadManifest,
  hasShardedFields,
  createEmptyManifest,
  createSingleFieldManifest,
} from './stitcher';

// ============================================================================
// Shamir Secret Sharing utilities
// ============================================================================
export {
  shamirSplit,
  shamirSplitPair,
  shamirReconstruct,
  shamirReconstructPair,
  shamirSplitAsync,
  shamirReconstructAsync,
  parseShare,
  formatShare,
  isValidShare,
  verifyShares,
  generateRandomHex,
  getSecretsLibrary,
} from './shamir';

// ============================================================================
// XOR splitting utilities (backward compatibility)
// ============================================================================
export { xorSplit, xorReconstruct, xorVerify, isValidBase64 } from './xor';

// ============================================================================
// GCP Secret Manager client
// ============================================================================
export {
  getGcpSecret,
  setGcpSecret,
  listGcpSecrets,
  deleteGcpSecret,
  isGcpAvailable,
  resetGcpClient,
  getInitializationError,
  configureGcpClient,
  clearSecretCache,
  getCacheStats,
} from './gcp-secret-manager';
export type { GcpClientConfig } from './gcp-secret-manager';

// ============================================================================
// Retry utilities
// ============================================================================
export { withRetry, withTimeout, isRetryableError } from './retry';
export type { RetryOptions } from './retry';

// ============================================================================
// Path utilities
// ============================================================================
export { parsePath, getValueByPath, setValueByPath, deleteValueByPath, hasPath, findPaths } from './path-utils';

// ============================================================================
// Types
// ============================================================================
export {
  ShardManifest,
  ShardedFieldConfig,
  ShamirShare,
  StitcherOptions,
  StitcherLogger,
  ShamirSplitConfig,
  SplitResult,
  ShardError,
  ShardErrorCode,
} from './types';
