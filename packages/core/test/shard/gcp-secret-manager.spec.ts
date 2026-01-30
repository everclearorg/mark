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
  };
});

describe('gcp-secret-manager', () => {
  beforeEach(() => {
    resetGcpClient();
    jest.clearAllMocks();
    lastClientOptions = undefined;
    lastCredentialConfig = undefined;
    delete process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
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

  it('uses ECS container credentials URL when provided', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';

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
          url: 'http://169.254.170.2/v2/credentials/abc',
        }),
      }),
    );
  });
});
