/**
 * Google Cloud Secret Manager client for fetching Share 2 values.
 *
 * Uses the @google-cloud/secret-manager SDK.
 * Supports:
 * - Application Default Credentials (ADC)
 * - Explicit service account key files
 * - AWS Workload Identity Federation (for cross-cloud authentication)
 */

import { ShardError, ShardErrorCode } from './types';
import { withRetry, withTimeout, isRetryableError } from './retry';

/**
 * Configuration for GCP client initialization.
 */
export interface GcpClientConfig {
  /** GCP project ID for default operations */
  projectId?: string;
  /** Path to service account key file */
  keyFilename?: string;
  /** Timeout for API calls in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Optional logger for warnings and errors. Falls back to console if not provided. */
  logger?: {
    info?: (message: string) => void;
    debug?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  /**
   * Workload Identity Federation configuration for AWS-to-GCP authentication.
   * If provided, uses federated credentials instead of ADC.
   */
  workloadIdentity?: {
    /** GCP Workload Identity Provider resource name */
    provider: string;
    /** GCP Service Account email to impersonate */
    serviceAccountEmail: string;
  };
}

// Lazy-loaded GCP client
let gcpClient: import('@google-cloud/secret-manager').SecretManagerServiceClient | null = null;
let clientConfig: GcpClientConfig = {};
let clientInitializationFailed = false;
let initializationError: Error | null = null;

// Secret cache for performance
const secretCache = new Map<string, { value: string; timestamp: number; version: string }>();
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMEOUT_MS = 10000; // 10 seconds
const DEFAULT_MAX_RETRIES = 3;

/**
 * Type for the GCP Secret Manager client.
 * Using dynamic import to avoid requiring the package at module load time.
 */
type SecretManagerClient = import('@google-cloud/secret-manager').SecretManagerServiceClient;

/**
 * Configure the GCP client before initialization.
 * Call this before any other GCP operations if you need custom credentials.
 *
 * @param config - GCP client configuration
 */
export function configureGcpClient(config: GcpClientConfig): void {
  clientConfig = { ...config };
  // Reset client to apply new config
  gcpClient = null;
  clientInitializationFailed = false;
  initializationError = null;
}

/**
 * Create Workload Identity Federation auth client.
 * Uses google-auth-library's GoogleAuth for compatibility with google-gax.
 *
 * This approach:
 * - Automatically detects AWS credentials from environment (Lambda) or IMDS (EC2/ECS)
 * - Handles IMDSv2 token requirements
 * - Supports all AWS compute environments
 */
async function createWorkloadIdentityAuthClient(
  provider: string,
  serviceAccountEmail: string,
): Promise<import('google-auth-library').GoogleAuth> {
  // Validate provider format
  // Format: projects/{project_number}/locations/global/workloadIdentityPools/{pool_id}/providers/{provider_id}
  const providerPattern = /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/;

  if (!providerPattern.test(provider)) {
    throw new Error(`Invalid workload identity provider format: ${provider}`);
  }

  // Dynamic import google-auth-library
  const { GoogleAuth } = await import('google-auth-library');

  // Create external account credentials configuration for AWS
  // See: https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds
  //
  // Environment detection:
  // - Lambda: Has AWS_LAMBDA_FUNCTION_NAME, credentials in env vars
  // - ECS Fargate: Has AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, NO IMDS access
  // - EC2/ECS on EC2: Has IMDS at 169.254.169.254
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const isFargate =
    !!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const imdsBaseUrl = process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT ?? 'http://169.254.169.254';

  // Validate region is available for Lambda/Fargate
  if ((isLambda || isFargate) && !process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    throw new Error('AWS_REGION environment variable is required for Workload Identity Federation in Lambda/Fargate');
  }

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';

  // Build credential source based on environment
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let credentialConfig: any;

  if (isLambda || isFargate) {
    // For Lambda and Fargate: Use a custom credential supplier that fetches fresh credentials
    // This ensures credentials are always valid even for long-running ECS tasks
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    const credentialProvider = defaultProvider();

    // Create a custom AwsSecurityCredentialsSupplier that fetches fresh credentials
    // This is more secure than setting env vars because:
    // 1. Credentials are fetched on-demand, not stored globally
    // 2. Credentials auto-refresh when expired
    // 3. No risk of accidentally logging env vars with credentials
    const awsSecurityCredentialsSupplier = {
      getAwsRegion: async () => region,
      getAwsSecurityCredentials: async () => {
        const creds = await credentialProvider();
        return {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          token: creds.sessionToken,
        };
      },
    };

    credentialConfig = {
      type: 'external_account' as const,
      audience: `//iam.googleapis.com/${provider}`,
      subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
      token_url: 'https://sts.googleapis.com/v1/token',
      // Use programmatic credential supplier instead of static credential_source
      aws_security_credentials_supplier: awsSecurityCredentialsSupplier,
    };
  } else {
    // EC2 or ECS on EC2: Use IMDS for region and credentials
    credentialConfig = {
      type: 'external_account' as const,
      audience: `//iam.googleapis.com/${provider}`,
      subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
      token_url: 'https://sts.googleapis.com/v1/token',
      credential_source: {
        environment_id: 'aws1',
        region_url: `${imdsBaseUrl}/latest/meta-data/placement/availability-zone`,
        url: `${imdsBaseUrl}/latest/meta-data/iam/security-credentials`,
        regional_cred_verification_url:
          'https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15',
        imdsv2_session_token_url: `${imdsBaseUrl}/latest/api/token`,
      },
    };
  }

  const authClient = new GoogleAuth({
    credentials: credentialConfig,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  return authClient;
}

/**
 * Get or create the GCP Secret Manager client.
 * Uses lazy initialization to avoid startup failures when GCP isn't configured.
 *
 * Supports:
 * - Standard ADC (Application Default Credentials)
 * - Explicit service account key file
 * - AWS Workload Identity Federation (for Lambda/ECS running in AWS)
 *
 * @returns The client instance, or null if initialization failed
 */
async function getGcpClient(): Promise<SecretManagerClient | null> {
  if (clientInitializationFailed) {
    return null;
  }

  if (gcpClient) {
    return gcpClient;
  }

  try {
    // Dynamic import to handle missing dependency gracefully
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientOptions: any = {};

    if (clientConfig.projectId) {
      clientOptions.projectId = clientConfig.projectId;
    }

    // Check for Workload Identity Federation configuration
    if (clientConfig.workloadIdentity) {
      const { provider, serviceAccountEmail } = clientConfig.workloadIdentity;

      // Log environment detection for debugging
      const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
      const isFargate =
        !!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
      clientConfig.logger?.debug?.(
        `[GCP] Environment: Lambda=${isLambda}, Fargate=${isFargate}, Region=${process.env.AWS_REGION}`,
      );
      if (isFargate) {
        clientConfig.logger?.debug?.(
          `[GCP] Fargate credentials: RELATIVE_URI=${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}, FULL_URI=${process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ? 'set' : 'not set'}`,
        );
      }

      // Create auth client using google-auth-library's ExternalAccountClient
      // This handles AWS credential detection automatically (env vars for Lambda, IMDS for EC2/ECS)
      const authClient = await createWorkloadIdentityAuthClient(provider, serviceAccountEmail);

      // Pass auth client to Secret Manager - uses 'auth' option (not 'authClient')
      // See: https://github.com/googleapis/google-cloud-node
      clientOptions.auth = authClient;

      clientConfig.logger?.debug?.('[GCP] Using AWS Workload Identity Federation for authentication');
    } else if (clientConfig.keyFilename) {
      // Use explicit key file
      clientOptions.keyFilename = clientConfig.keyFilename;
    }
    // Otherwise, rely on ADC (Application Default Credentials)

    gcpClient = new SecretManagerServiceClient(Object.keys(clientOptions).length > 0 ? clientOptions : undefined);

    return gcpClient;
  } catch (error) {
    clientInitializationFailed = true;
    initializationError = error as Error;
    const message = `GCP Secret Manager client initialization failed: ${error instanceof Error ? error.message : error}`;
    if (clientConfig.logger?.warn) {
      clientConfig.logger.warn(message);
    } else {
      console.warn(message);
    }
    return null;
  }
}

/**
 * Reset the client state (useful for testing or reconfiguration).
 */
export function resetGcpClient(): void {
  gcpClient = null;
  clientInitializationFailed = false;
  initializationError = null;
  clientConfig = {};
  secretCache.clear();
}

/**
 * Check if GCP Secret Manager is available.
 *
 * @returns true if the client can be initialized
 */
export async function isGcpAvailable(): Promise<boolean> {
  const client = await getGcpClient();
  return client !== null;
}

/**
 * Get the initialization error if any.
 */
export function getInitializationError(): Error | null {
  return initializationError;
}

/**
 * Clear the secret cache.
 */
export function clearSecretCache(): void {
  secretCache.clear();
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: secretCache.size,
    keys: Array.from(secretCache.keys()),
  };
}

/**
 * Fetch a secret value from Google Cloud Secret Manager.
 *
 * Features:
 * - Automatic retry with exponential backoff
 * - Timeout protection
 * - Optional caching
 *
 * @param project - GCP project ID
 * @param secretId - Secret name in GCP
 * @param version - Secret version (default: 'latest')
 * @param options - Additional options
 * @returns Secret value as string
 * @throws ShardError if the secret cannot be accessed
 *
 * @example
 * const share2 = await getGcpSecret("my-project", "my-secret");
 */
export async function getGcpSecret(
  project: string,
  secretId: string,
  version: string = 'latest',
  options: {
    useCache?: boolean;
    cacheTtlMs?: number;
    timeoutMs?: number;
    maxRetries?: number;
  } = {},
): Promise<string> {
  const {
    useCache = true,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    timeoutMs = clientConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries = clientConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
  } = options;

  // Check cache first
  const cacheKey = `${project}/${secretId}/${version}`;
  if (useCache) {
    const cached = secretCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
      return cached.value;
    }
  }

  const client = await getGcpClient();

  if (!client) {
    throw new ShardError(
      'GCP Secret Manager client not available. Ensure @google-cloud/secret-manager is installed and GCP credentials are configured.',
      ShardErrorCode.GCP_ACCESS_FAILED,
      {
        suggestion: 'npm install @google-cloud/secret-manager',
        initError: initializationError?.message,
      },
    );
  }

  const name = `projects/${project}/secrets/${secretId}/versions/${version}`;

  // Wrap the API call with retry and timeout
  const fetchSecret = async (): Promise<string> => {
    try {
      const apiCall = client.accessSecretVersion({ name });
      const [response] = await withTimeout(apiCall, timeoutMs, `GCP secret access timed out after ${timeoutMs}ms`);

      if (!response.payload?.data) {
        throw new ShardError(`Secret payload is empty: ${name}`, ShardErrorCode.GCP_ACCESS_FAILED, {
          secretPath: name,
        });
      }

      // Handle both string and Uint8Array payloads
      const data = response.payload.data;
      if (typeof data === 'string') {
        return data;
      }

      return Buffer.from(data).toString('utf8');
    } catch (error) {
      // Re-throw ShardError as-is
      if (error instanceof ShardError) {
        throw error;
      }

      // Extract error message, handling nested error objects
      let message: string;
      if (error instanceof Error) {
        // Handle gRPC/nested errors that may have details in cause or other properties
        const err = error as Error & { code?: string; details?: string; cause?: Error };
        message = err.message || '';
        if (err.details) {
          message = `${message} - ${err.details}`;
        }
        if (err.cause?.message) {
          message = `${message} - Caused by: ${err.cause.message}`;
        }
        // Handle case where message contains [object Object]
        if (message.includes('[object Object]')) {
          try {
            message = message.replace('[object Object]', JSON.stringify(error));
          } catch {
            message = `${message} (error details could not be serialized)`;
          }
        }
      } else if (typeof error === 'object' && error !== null) {
        try {
          message = JSON.stringify(error);
        } catch {
          message = String(error);
        }
      } else {
        message = String(error);
      }

      // Check for common GCP errors
      if (message.includes('NOT_FOUND') || message.includes('404')) {
        throw new ShardError(`Secret not found: ${name}`, ShardErrorCode.GCP_ACCESS_FAILED, { secretPath: name });
      }

      if (message.includes('PERMISSION_DENIED') || message.includes('403')) {
        throw new ShardError(
          `Permission denied accessing secret: ${name}. Ensure the service account has secretmanager.versions.access permission.`,
          ShardErrorCode.GCP_ACCESS_FAILED,
          { secretPath: name },
        );
      }

      throw new ShardError(`Failed to access GCP secret '${name}': ${message}`, ShardErrorCode.GCP_ACCESS_FAILED, {
        secretPath: name,
        originalError: message,
      });
    }
  };

  // Execute with retry
  const value = await withRetry(fetchSecret, {
    maxAttempts: maxRetries,
    isRetryable: (error) => {
      // Don't retry NOT_FOUND or PERMISSION_DENIED
      if (error instanceof ShardError) {
        const msg = error.message;
        if (msg.includes('not found') || msg.includes('Permission denied')) {
          return false;
        }
      }
      return isRetryableError(error);
    },
    onRetry: (attempt, error, delayMs) => {
      const message = `GCP secret fetch retry ${attempt}: ${error.message} (waiting ${delayMs}ms)`;
      if (clientConfig.logger?.warn) {
        clientConfig.logger.warn(message);
      } else {
        console.warn(message);
      }
    },
  });

  // Update cache
  if (useCache) {
    secretCache.set(cacheKey, { value, timestamp: Date.now(), version });
  }

  return value;
}

/**
 * Store a secret value in Google Cloud Secret Manager.
 * Creates the secret if it doesn't exist.
 *
 * This is primarily for administrative/setup use, not runtime.
 *
 * @param project - GCP project ID
 * @param secretId - Secret name to create/update
 * @param value - Secret value to store
 * @param createIfNotExists - Whether to create the secret if it doesn't exist
 * @returns The version name of the stored secret
 */
export async function setGcpSecret(
  project: string,
  secretId: string,
  value: string,
  createIfNotExists: boolean = true,
): Promise<string> {
  const client = await getGcpClient();

  if (!client) {
    throw new ShardError('GCP Secret Manager client not available', ShardErrorCode.GCP_ACCESS_FAILED);
  }

  const parent = `projects/${project}`;
  const secretName = `projects/${project}/secrets/${secretId}`;

  // Check if secret exists
  try {
    await client.getSecret({ name: secretName });
  } catch (error: unknown) {
    const err = error as { code?: number };
    if (err.code === 5 && createIfNotExists) {
      // NOT_FOUND - create the secret
      await client.createSecret({
        parent,
        secretId,
        secret: {
          replication: { automatic: {} },
          labels: {
            purpose: 'shamir-share',
            component: 'key-sharding',
          },
        },
      });
    } else {
      throw new ShardError(
        `Failed to access secret ${secretId}: ${(error as Error).message}`,
        ShardErrorCode.GCP_ACCESS_FAILED,
      );
    }
  }

  // Add new version
  const [version] = await client.addSecretVersion({
    parent: secretName,
    payload: {
      data: Buffer.from(value, 'utf8'),
    },
  });

  // Invalidate cache for this secret
  for (const key of secretCache.keys()) {
    if (key.startsWith(`${project}/${secretId}/`)) {
      secretCache.delete(key);
    }
  }

  return version.name || '';
}

/**
 * List all secrets in a project (for debugging/admin purposes).
 *
 * @param project - GCP project ID
 * @returns Array of secret IDs
 */
export async function listGcpSecrets(project: string): Promise<string[]> {
  const client = await getGcpClient();

  if (!client) {
    throw new ShardError('GCP Secret Manager client not available', ShardErrorCode.GCP_ACCESS_FAILED);
  }

  const parent = `projects/${project}`;
  const [secrets] = await client.listSecrets({ parent });

  return secrets
    .map((s) => {
      // Extract secret ID from full name: projects/xxx/secrets/yyy
      const parts = s.name?.split('/') || [];
      return parts[parts.length - 1] || '';
    })
    .filter(Boolean);
}

/**
 * Delete a secret (for testing/cleanup purposes).
 *
 * @param project - GCP project ID
 * @param secretId - Secret name to delete
 */
export async function deleteGcpSecret(project: string, secretId: string): Promise<void> {
  const client = await getGcpClient();

  if (!client) {
    throw new ShardError('GCP Secret Manager client not available', ShardErrorCode.GCP_ACCESS_FAILED);
  }

  const name = `projects/${project}/secrets/${secretId}`;

  try {
    await client.deleteSecret({ name });
  } catch (error: unknown) {
    const err = error as { code?: number };
    if (err.code === 5) {
      // NOT_FOUND - already deleted, ignore
      return;
    }
    throw error;
  }

  // Clear cache entries for this secret
  for (const key of secretCache.keys()) {
    if (key.startsWith(`${project}/${secretId}/`)) {
      secretCache.delete(key);
    }
  }
}
