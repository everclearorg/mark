/**
 * Tests for GCP Secret Manager client configuration and authentication.
 */

import {
  configureGcpClient,
  getGcpSecret,
  resetGcpClient,
} from '../../src/shard/gcp-secret-manager';

let lastClientOptions: unknown;
let lastCredentialConfig: unknown;
let lastAuthOptions: unknown;
let lastAwsClientOptions: unknown;
let accessSecretVersionMock: jest.Mock;

jest.mock('@google-cloud/secret-manager', () => {
  return {
    SecretManagerServiceClient: jest.fn().mockImplementation((options) => {
      lastClientOptions = options;
      accessSecretVersionMock = jest.fn().mockResolvedValue([
        { payload: { data: 'secret-value' } },
      ]);
      return {
        accessSecretVersion: accessSecretVersionMock,
      };
    }),
  };
});

jest.mock('google-auth-library', () => {
  return {
    GoogleAuth: jest.fn().mockImplementation((options) => {
      lastAuthOptions = options;
      lastCredentialConfig = options?.credentials;
      return {
        getUniverseDomain: jest.fn().mockResolvedValue('googleapis.com'),
      };
    }),
    AwsClient: jest.fn().mockImplementation((options) => {
      lastAwsClientOptions = options;
      // Also set lastCredentialConfig for backward compatibility with tests
      lastCredentialConfig = options;
      return {
        getUniverseDomain: jest.fn().mockResolvedValue('googleapis.com'),
        getAccessToken: jest.fn().mockResolvedValue({ token: 'mock-token' }),
      };
    }),
    ExternalAccountClient: {
      fromJSON: jest.fn(),
    },
  };
});

// Mock AWS SDK credential provider
jest.mock('@aws-sdk/credential-provider-node', () => {
  return {
    defaultProvider: jest.fn().mockReturnValue(() =>
      Promise.resolve({
        accessKeyId: 'MOCK_ACCESS_KEY',
        secretAccessKey: 'MOCK_SECRET_KEY',
        sessionToken: 'MOCK_SESSION_TOKEN',
      }),
    ),
  };
});

describe('gcp-secret-manager', () => {
  beforeEach(() => {
    resetGcpClient();
    jest.clearAllMocks();
    lastClientOptions = undefined;
    lastCredentialConfig = undefined;
    lastAwsClientOptions = undefined;
    // Clean up environment variables
    delete process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    // Clean up credentials that may have been set by previous tests
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  });

  it('uses Workload Identity auth client and passes auth option', async () => {
    const logger = { debug: jest.fn() };

    configureGcpClient({
      workloadIdentity: {
        provider:
          'projects/123456789/locations/global/workloadIdentityPools/aws-pool/providers/aws-provider',
        serviceAccountEmail: 'shard-reader@example.iam.gserviceaccount.com',
      },
      logger,
    });

    const value = await getGcpSecret('proj', 'secret');

    expect(value).toBe('secret-value');
    expect(lastClientOptions).toEqual(expect.objectContaining({ auth: expect.any(Object) }));
    expect(lastAuthOptions).toEqual(
      expect.objectContaining({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    );
    expect(lastCredentialConfig).toEqual(
      expect.objectContaining({
        type: 'external_account',
        audience:
          '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/aws-pool/providers/aws-provider',
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      '[GCP] Using AWS Workload Identity Federation for authentication',
    );
  });

  it('uses AWS SDK credentials supplier for Fargate environment', async () => {
    // Simulate Fargate environment
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
    process.env.AWS_REGION = 'us-east-1';

    configureGcpClient({
      workloadIdentity: {
        provider:
          'projects/123456789/locations/global/workloadIdentityPools/aws-pool/providers/aws-provider',
        serviceAccountEmail: 'shard-reader@example.iam.gserviceaccount.com',
      },
    });

    await getGcpSecret('proj', 'secret');

    // For Fargate, we use a programmatic credential supplier (more secure)
    expect(lastCredentialConfig).toEqual(
      expect.objectContaining({
        aws_security_credentials_supplier: expect.objectContaining({
          getAwsRegion: expect.any(Function),
          getAwsSecurityCredentials: expect.any(Function),
        }),
      }),
    );
    // Credentials should NOT be set in environment (security improvement)
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('uses IMDS for EC2 environment (no Lambda/Fargate env vars)', async () => {
    // No Lambda or Fargate env vars set - should use IMDS
    configureGcpClient({
      workloadIdentity: {
        provider:
          'projects/123456789/locations/global/workloadIdentityPools/aws-pool/providers/aws-provider',
        serviceAccountEmail: 'shard-reader@example.iam.gserviceaccount.com',
      },
    });

    await getGcpSecret('proj', 'secret');

    expect(lastCredentialConfig).toEqual(
      expect.objectContaining({
        credential_source: expect.objectContaining({
          region_url: 'http://169.254.169.254/latest/meta-data/placement/availability-zone',
          imdsv2_session_token_url: 'http://169.254.169.254/latest/api/token',
        }),
      }),
    );
  });

  it('uses AWS SDK credentials supplier for Lambda environment', async () => {
    // Simulate Lambda environment
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
    process.env.AWS_REGION = 'sa-east-1';

    configureGcpClient({
      workloadIdentity: {
        provider:
          'projects/123456789/locations/global/workloadIdentityPools/aws-pool/providers/aws-provider',
        serviceAccountEmail: 'shard-reader@example.iam.gserviceaccount.com',
      },
    });

    await getGcpSecret('proj', 'secret');

    // For Lambda, we use a programmatic credential supplier
    expect(lastCredentialConfig).toEqual(
      expect.objectContaining({
        aws_security_credentials_supplier: expect.objectContaining({
          getAwsRegion: expect.any(Function),
          getAwsSecurityCredentials: expect.any(Function),
        }),
      }),
    );
    // Should NOT have credential_source (uses supplier instead)
    expect((lastCredentialConfig as { credential_source?: unknown })?.credential_source).toBeUndefined();
  });

  it('fails gracefully when Lambda/Fargate without AWS_REGION', async () => {
    // Simulate Fargate without AWS_REGION
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
    // AWS_REGION not set

    const logger = { warn: jest.fn() };

    configureGcpClient({
      workloadIdentity: {
        provider:
          'projects/123456789/locations/global/workloadIdentityPools/aws-pool/providers/aws-provider',
        serviceAccountEmail: 'shard-reader@example.iam.gserviceaccount.com',
      },
      logger,
    });

    // Should fail with client not available (initialization fails gracefully)
    await expect(getGcpSecret('proj', 'secret')).rejects.toThrow(
      'GCP Secret Manager client not available',
    );

    // The underlying error should be logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS_REGION environment variable is required'),
    );
  });
});
