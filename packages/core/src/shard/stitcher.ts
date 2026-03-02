/**
 * Stitcher module for reconstructing sharded configuration fields.
 *
 * This is the main orchestration layer that:
 * 1. Loads the shard manifest
 * 2. Fetches Share 1 from AWS SSM Parameter Store
 * 3. Fetches Share 2 from GCP Secret Manager
 * 4. Reconstructs original values using Shamir or XOR
 * 5. Returns the complete configuration JSON with secrets restored
 *
 * The stitcher is designed to be a drop-in addition to existing config loading,
 * requiring no changes to downstream code.
 */

import { ShardManifest, ShardedFieldConfig, StitcherOptions, ShardError, ShardErrorCode } from './types';
import { getGcpSecret, configureGcpClient } from './gcp-secret-manager';
import { shamirReconstructPair, isValidShare } from './shamir';
import { xorReconstruct } from './xor';
import { setValueByPath, deleteValueByPath } from './path-utils';
import { getSsmParameter } from '../ssm';

/**
 * Read Workload Identity configuration from environment variables.
 * Returns undefined if not configured.
 *
 * Environment variables:
 * - GCP_WORKLOAD_IDENTITY_PROVIDER: Full provider resource name
 * - GCP_SERVICE_ACCOUNT_EMAIL: Service account to impersonate
 */
function getWorkloadIdentityFromEnv(): { provider: string; serviceAccountEmail: string } | undefined {
  const provider = process.env.GCP_WORKLOAD_IDENTITY_PROVIDER;
  const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

  if (provider && serviceAccountEmail) {
    return { provider, serviceAccountEmail };
  }

  return undefined;
}

/**
 * Stitch sharded fields in a config JSON by fetching shares from both
 * AWS SSM and GCP Secret Manager, then reconstructing the original values.
 *
 * This function:
 * 1. Deep clones the input to avoid mutations
 * 2. For each sharded field in the manifest:
 *    - Fetches Share 1 from AWS SSM Parameter Store (using awsParamName)
 *    - Fetches Share 2 from GCP Secret Manager (using gcpSecretRef)
 *    - Reconstructs the original value using Shamir or XOR
 *    - Sets the reconstructed value at the field path in the config
 * 3. Removes the manifest from the output
 *
 * @param configJson - The config JSON loaded from AWS SSM (containing Share 1 values)
 * @param manifest - The shard manifest declaring which fields are sharded
 * @param options - Optional configuration
 * @returns The config JSON with all sharded fields reconstructed
 * @throws ShardError if a required field cannot be reconstructed
 *
 * @example
 * const manifest = { version: '1.0', shardedFields: [...] };
 * const fullConfig = await stitchConfig(partialConfig, manifest);
 */
export async function stitchConfig<T extends object>(
  configJson: T,
  manifest: ShardManifest,
  options: StitcherOptions = {},
): Promise<T> {
  const { logger, failOnMissingOptional = false, gcpCredentials, workloadIdentity } = options;

  // Determine Workload Identity configuration
  // Priority: explicit options > environment variables
  const effectiveWorkloadIdentity = workloadIdentity ?? getWorkloadIdentityFromEnv();

  // Configure GCP client with credentials, workload identity, and logger
  configureGcpClient({
    projectId: gcpCredentials?.projectId ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT,
    keyFilename: gcpCredentials?.keyFilename,
    workloadIdentity: effectiveWorkloadIdentity,
    logger: logger
      ? {
          info: logger.info,
          debug: logger.debug,
          warn: logger.warn,
          error: logger.error,
        }
      : undefined,
  });

  // Validate manifest
  if (!manifest || manifest.version !== '1.0') {
    throw new ShardError('Invalid shard manifest: version must be "1.0"', ShardErrorCode.MANIFEST_PARSE_FAILED);
  }

  if (!manifest.shardedFields || !Array.isArray(manifest.shardedFields)) {
    throw new ShardError(
      'Invalid shard manifest: shardedFields must be an array',
      ShardErrorCode.MANIFEST_PARSE_FAILED,
    );
  }

  // Deep clone to avoid mutating input
  const result = JSON.parse(JSON.stringify(configJson)) as T;

  // Track reconstruction results for logging
  const stats = {
    total: manifest.shardedFields.length,
    successful: 0,
    skipped: 0,
    failed: 0,
  };

  // Process each sharded field
  for (const fieldConfig of manifest.shardedFields) {
    try {
      await processShardedField(result, fieldConfig, logger);
      stats.successful++;
    } catch (error) {
      const isRequired = fieldConfig.required !== false;

      if (isRequired || failOnMissingOptional) {
        stats.failed++;
        throw new ShardError(
          `Failed to reconstruct sharded field '${fieldConfig.path}': ${(error as Error).message}`,
          ShardErrorCode.RECONSTRUCTION_FAILED,
          { path: fieldConfig.path, originalError: (error as Error).message },
        );
      }

      stats.skipped++;
      logger?.warn?.(`Skipping optional sharded field '${fieldConfig.path}': ${(error as Error).message}`);
    }
  }

  logger?.info?.(
    `Shard stitching complete: ${stats.successful}/${stats.total} fields reconstructed` +
      (stats.skipped > 0 ? `, ${stats.skipped} skipped` : ''),
  );

  return result;
}

/**
 * Process a single sharded field: fetch shares from AWS SSM and GCP, then reconstruct.
 */
async function processShardedField(
  configJson: object,
  fieldConfig: ShardedFieldConfig,
  logger?: StitcherOptions['logger'],
): Promise<void> {
  const { path, awsParamName, gcpSecretRef, method = 'shamir' } = fieldConfig;

  // Validate field config
  if (!path || typeof path !== 'string') {
    throw new ShardError('Field path must be a non-empty string', ShardErrorCode.MANIFEST_PARSE_FAILED);
  }

  if (!awsParamName || typeof awsParamName !== 'string') {
    throw new ShardError(
      `Invalid awsParamName for field '${path}': awsParamName is required`,
      ShardErrorCode.MANIFEST_PARSE_FAILED,
    );
  }

  if (!gcpSecretRef?.project || !gcpSecretRef?.secretId) {
    throw new ShardError(
      `Invalid gcpSecretRef for field '${path}': project and secretId are required`,
      ShardErrorCode.MANIFEST_PARSE_FAILED,
    );
  }

  // Fetch Share 1 from AWS SSM Parameter Store
  logger?.debug?.(`Fetching Share 1 for '${path}' from AWS SSM: ${awsParamName}`);

  const share1Value = await getSsmParameter(awsParamName);

  if (share1Value === undefined || share1Value === null) {
    throw new ShardError(
      `Share 1 not found in AWS SSM at '${awsParamName}' for field '${path}'`,
      ShardErrorCode.FIELD_NOT_FOUND,
      { path, awsParamName },
    );
  }

  if (typeof share1Value !== 'string') {
    throw new ShardError(
      `Share 1 from AWS SSM '${awsParamName}' must be a string, got ${typeof share1Value}`,
      ShardErrorCode.INVALID_SHARE_FORMAT,
      { path, awsParamName, type: typeof share1Value },
    );
  }

  // Fetch Share 2 from GCP Secret Manager
  logger?.debug?.(`Fetching Share 2 for '${path}' from GCP: ${gcpSecretRef.project}/${gcpSecretRef.secretId}`);

  const share2Value = await getGcpSecret(gcpSecretRef.project, gcpSecretRef.secretId, gcpSecretRef.version);

  // Reconstruct the original value based on method
  let reconstructedValue: string;

  switch (method) {
    case 'shamir':
      reconstructedValue = reconstructShamir(share1Value, share2Value, path);
      break;

    case 'xor':
      reconstructedValue = reconstructXor(share1Value, share2Value, path);
      break;

    case 'concat':
      // Simple concatenation (not recommended)
      reconstructedValue = share1Value + share2Value;
      logger?.warn?.(`Field '${path}' uses 'concat' method which is not recommended for security`);
      break;

    default:
      throw new ShardError(
        `Unknown shard method '${method}' for field '${path}'`,
        ShardErrorCode.MANIFEST_PARSE_FAILED,
        { path, method },
      );
  }

  // Set the reconstructed value back into the config
  setValueByPath(configJson, path, reconstructedValue);

  logger?.debug?.(`Reconstructed field '${path}' using ${method} method`);
}

/**
 * Reconstruct using Shamir's Secret Sharing.
 */
function reconstructShamir(share1: string, share2: string, path: string): string {
  // Validate share formats (secrets.js-grempe native format)
  // SECURITY: Never log share values, even partially
  if (!isValidShare(share1)) {
    throw new ShardError(
      `Invalid Shamir share format for Share 1 at '${path}'. Share must be a valid hex string in secrets.js-grempe format.`,
      ShardErrorCode.INVALID_SHARE_FORMAT,
      { path, shareLength: share1?.length ?? 0 },
    );
  }

  if (!isValidShare(share2)) {
    throw new ShardError(
      `Invalid Shamir share format for Share 2 at '${path}'. Share must be a valid hex string in secrets.js-grempe format.`,
      ShardErrorCode.INVALID_SHARE_FORMAT,
      { path, shareLength: share2?.length ?? 0 },
    );
  }

  return shamirReconstructPair(share1, share2);
}

/**
 * Reconstruct using XOR.
 */
function reconstructXor(share1: string, share2: string, path: string): string {
  try {
    return xorReconstruct(share1, share2);
  } catch (error) {
    throw new ShardError(
      `XOR reconstruction failed for '${path}': ${(error as Error).message}`,
      ShardErrorCode.RECONSTRUCTION_FAILED,
      { path },
    );
  }
}

/**
 * Load the shard manifest from various sources.
 *
 * Checks in order:
 * 1. Embedded in config JSON under __shardManifest key
 * 2. From environment variable (as JSON string)
 * 3. From local file path (for development)
 *
 * @param configJson - The config JSON to check for embedded manifest
 * @param envManifest - Optional manifest JSON string from environment
 * @param localPath - Optional path to local manifest file
 * @returns The parsed manifest, or undefined if no manifest found
 */
export function loadManifest(configJson: object, envManifest?: string, localPath?: string): ShardManifest | undefined {
  // 1. Check for embedded manifest in config JSON
  const configWithManifest = configJson as { __shardManifest?: ShardManifest };
  if (configWithManifest.__shardManifest) {
    const manifest = configWithManifest.__shardManifest;

    // Remove the manifest from the config so downstream doesn't see it
    deleteValueByPath(configJson, '__shardManifest');

    return validateManifest(manifest);
  }

  // 2. Check for manifest from environment (SSM parameter value)
  if (envManifest && envManifest.trim()) {
    try {
      const manifest = JSON.parse(envManifest) as ShardManifest;
      return validateManifest(manifest);
    } catch (error) {
      throw new ShardError(
        `Failed to parse SHARD_MANIFEST from environment: ${(error as Error).message}`,
        ShardErrorCode.MANIFEST_PARSE_FAILED,
      );
    }
  }

  // 3. Check for local file (development mode)
  if (localPath) {
    try {
      // Dynamic require for fs to support both Node.js and bundlers
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs');
      if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf8');
        const manifest = JSON.parse(content) as ShardManifest;
        return validateManifest(manifest);
      }
    } catch (error) {
      throw new ShardError(
        `Failed to load manifest from '${localPath}': ${(error as Error).message}`,
        ShardErrorCode.MANIFEST_PARSE_FAILED,
        { path: localPath },
      );
    }
  }

  // No manifest found - no sharding configured
  return undefined;
}

/**
 * Validate a manifest object structure.
 */
function validateManifest(manifest: unknown): ShardManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new ShardError('Manifest must be an object', ShardErrorCode.MANIFEST_PARSE_FAILED);
  }

  const m = manifest as ShardManifest;

  if (m.version !== '1.0') {
    throw new ShardError(
      `Unsupported manifest version: ${m.version}. Expected "1.0"`,
      ShardErrorCode.MANIFEST_PARSE_FAILED,
    );
  }

  if (!Array.isArray(m.shardedFields)) {
    throw new ShardError('Manifest shardedFields must be an array', ShardErrorCode.MANIFEST_PARSE_FAILED);
  }

  // Validate each field config
  for (const field of m.shardedFields) {
    if (!field.path || typeof field.path !== 'string') {
      throw new ShardError('Each shardedField must have a non-empty string path', ShardErrorCode.MANIFEST_PARSE_FAILED);
    }

    if (!field.gcpSecretRef || !field.gcpSecretRef.project || !field.gcpSecretRef.secretId) {
      throw new ShardError(
        `Field '${field.path}' must have gcpSecretRef with project and secretId`,
        ShardErrorCode.MANIFEST_PARSE_FAILED,
      );
    }

    if (field.method && !['shamir', 'xor', 'concat'].includes(field.method)) {
      throw new ShardError(
        `Field '${field.path}' has invalid method '${field.method}'. Must be 'shamir', 'xor', or 'concat'`,
        ShardErrorCode.MANIFEST_PARSE_FAILED,
      );
    }
  }

  return m;
}

/**
 * Check if a config JSON has any sharded fields that need reconstruction.
 *
 * @param configJson - The config JSON to check
 * @returns true if the config has an embedded manifest with fields to process
 */
export function hasShardedFields(configJson: object): boolean {
  const configWithManifest = configJson as { __shardManifest?: ShardManifest };
  const manifest = configWithManifest.__shardManifest;

  return !!(manifest && manifest.shardedFields && manifest.shardedFields.length > 0);
}

/**
 * Create an empty manifest (useful for testing).
 */
export function createEmptyManifest(): ShardManifest {
  return {
    version: '1.0',
    shardedFields: [],
  };
}

/**
 * Create a manifest with a single field (useful for testing).
 */
export function createSingleFieldManifest(
  path: string,
  gcpProject: string,
  gcpSecretId: string,
  method: 'shamir' | 'xor' = 'shamir',
): ShardManifest {
  return {
    version: '1.0',
    shardedFields: [
      {
        path,
        gcpSecretRef: {
          project: gcpProject,
          secretId: gcpSecretId,
        },
        method,
      },
    ],
  };
}
