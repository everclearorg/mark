/**
 * Type definitions for the Shamir key sharding module.
 *
 * This module enables splitting sensitive configuration fields across
 * AWS SSM and GCP Secret Manager using Shamir's Secret Sharing.
 */

/**
 * AWS configuration defaults for the manifest.
 */
export interface AwsManifestConfig {
  /** Default AWS region for SSM operations */
  region?: string;
  /** Default SSM parameter path prefix (e.g., /mason/config) */
  parameterPrefix?: string;
}

/**
 * GCP configuration defaults for the manifest.
 */
export interface GcpManifestConfig {
  /** Default GCP project ID */
  project?: string;
}

/**
 * Manifest declaring which fields in the config JSON are sharded.
 */
export interface ShardManifest {
  /** Schema version for forward compatibility */
  version: '1.0';
  /** Optional description for the manifest */
  description?: string;
  /** AWS configuration defaults */
  awsConfig?: AwsManifestConfig;
  /** GCP configuration defaults */
  gcpConfig?: GcpManifestConfig;
  /** List of sharded field configurations */
  shardedFields: ShardedFieldConfig[];
}

/**
 * Configuration for a single sharded field.
 */
export interface ShardedFieldConfig {
  /**
   * JSON path to the field using dot notation.
   * Supports array indices: "chains.1.privateKey" or "chains[1].privateKey"
   */
  path: string;

  /**
   * AWS SSM Parameter name for Share 1.
   * If not provided, derived from path: /{prefix}/{path}_share1
   */
  awsParamName?: string;

  /**
   * GCP Secret Manager reference for Share 2.
   */
  gcpSecretRef: {
    /** GCP project ID */
    project: string;
    /** Secret name in GCP */
    secretId: string;
    /** Secret version (default: 'latest') */
    version?: string;
  };

  /**
   * Sharding method to use.
   * - 'shamir': Shamir's Secret Sharing (2-of-2 threshold) - recommended
   * - 'xor': XOR-based splitting - simpler alternative
   * - 'concat': Simple concatenation - not recommended for security
   */
  method: 'shamir' | 'xor' | 'concat';

  /**
   * Shamir-specific options (reserved for future use).
   *
   * Note: The secrets.js-grempe library automatically assigns share indices
   * based on the order of generation. Custom indices are not currently supported.
   * This field is preserved for future compatibility with libraries that support
   * custom share indices.
   *
   * @deprecated Reserved for future use - currently ignored
   */
  shamirOptions?: {
    /** The x-coordinate (index) of Share 1 stored in AWS (default: 1) */
    share1Index?: number;
    /** The x-coordinate (index) of Share 2 stored in GCP (default: 2) */
    share2Index?: number;
  };

  /**
   * Whether this field is required for startup.
   * If false, missing shards will be logged as warnings but won't fail startup.
   * Default: true
   */
  required?: boolean;
}

/**
 * Parsed Shamir share with index and data components.
 */
export interface ShamirShare {
  /** The x-coordinate (index) of this share point on the polynomial */
  index: number;
  /** The share data (hex-encoded polynomial evaluation) */
  data: string;
}

/**
 * Options for the stitcher module.
 */
export interface StitcherOptions {
  /**
   * GCP credentials configuration.
   * If not provided, uses Application Default Credentials (ADC).
   */
  gcpCredentials?: {
    projectId: string;
    keyFilename?: string;
  };

  /**
   * AWS Workload Identity Federation configuration for GCP authentication.
   * If not provided, reads from environment variables:
   * - GCP_WORKLOAD_IDENTITY_PROVIDER
   * - GCP_SERVICE_ACCOUNT_EMAIL
   */
  workloadIdentity?: {
    /** GCP Workload Identity Provider resource name */
    provider: string;
    /** GCP Service Account email to impersonate */
    serviceAccountEmail: string;
  };

  /**
   * Whether to fail startup when optional shards are missing.
   * Default: false
   */
  failOnMissingOptional?: boolean;

  /**
   * Logger instance for debug output.
   */
  logger?: StitcherLogger;
}

/**
 * Logger interface for stitcher operations.
 */
export interface StitcherLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Configuration for Shamir splitting operation.
 */
export interface ShamirSplitConfig {
  /** Number of shares to generate (default: 2) */
  numShares?: number;
  /** Threshold - minimum shares needed to reconstruct (default: 2) */
  threshold?: number;
  /**
   * Random padding length to prevent length-based analysis.
   * If set, secrets shorter than this will be padded.
   */
  padLength?: number;
}

/**
 * Result of a split operation, containing both shares.
 */
export interface SplitResult {
  /** Share 1 (to be stored in AWS SSM) */
  share1: string;
  /** Share 2 (to be stored in GCP Secret Manager) */
  share2: string;
}

/**
 * Error thrown when shard operations fail.
 */
export class ShardError extends Error {
  constructor(
    message: string,
    public readonly code: ShardErrorCode,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ShardError';
  }
}

/**
 * Error codes for shard operations.
 */
export enum ShardErrorCode {
  /** Invalid share format */
  INVALID_SHARE_FORMAT = 'INVALID_SHARE_FORMAT',
  /** Share reconstruction failed */
  RECONSTRUCTION_FAILED = 'RECONSTRUCTION_FAILED',
  /** GCP Secret Manager access failed */
  GCP_ACCESS_FAILED = 'GCP_ACCESS_FAILED',
  /** Manifest parsing failed */
  MANIFEST_PARSE_FAILED = 'MANIFEST_PARSE_FAILED',
  /** Field not found in config */
  FIELD_NOT_FOUND = 'FIELD_NOT_FOUND',
  /** Share length mismatch */
  LENGTH_MISMATCH = 'LENGTH_MISMATCH',
  /** Required shard missing */
  REQUIRED_SHARD_MISSING = 'REQUIRED_SHARD_MISSING',
}
