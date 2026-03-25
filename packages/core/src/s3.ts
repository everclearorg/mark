import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { RebalanceConfig, ThresholdRebalanceS3Config } from './types/config';

// Singleton client to prevent race conditions
let s3Client: S3Client | null = null;
let clientInitializationFailed = false;

const getS3Client = (region?: string): S3Client | null => {
  if (clientInitializationFailed) {
    return null;
  }

  if (!s3Client) {
    // Check if AWS region is available before attempting to initialize
    const awsRegion = region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

    if (!awsRegion) {
      console.warn('AWS region not configured for S3 client, skipping S3 config fetch');
      clientInitializationFailed = true;
      return null;
    }

    try {
      s3Client = new S3Client({ region: awsRegion });
    } catch (error) {
      console.warn('S3 client initialization failed:', error instanceof Error ? error.message : error);
      clientInitializationFailed = true;
      return null;
    }
  }

  return s3Client;
};

export const getRebalanceConfigFromS3 = async (): Promise<RebalanceConfig | null> => {
  try {
    const bucket = process.env.REBALANCE_CONFIG_S3_BUCKET;
    const key = process.env.REBALANCE_CONFIG_S3_KEY;
    const region = process.env.REBALANCE_CONFIG_S3_REGION;

    if (!bucket || !key) {
      return null;
    }

    const client = getS3Client(region);
    if (!client) {
      return null;
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await client.send(command);

    if (!response.Body) {
      return null;
    }

    const bodyString = await response.Body.transformToString();
    const config = JSON.parse(bodyString) as RebalanceConfig;

    console.log('Successfully loaded rebalance config from S3', {
      bucket,
      key,
      routeCount: config.routes?.length || 0,
      onDemandRouteCount: config.onDemandRoutes?.length || 0,
      onDemandRoutes: config.onDemandRoutes?.map((r) => ({
        origin: r.origin,
        destination: r.destination,
        asset: r.asset,
        swapOutputAsset: r.swapOutputAsset,
      })),
    });

    return config;
  } catch (error) {
    console.warn('Failed to fetch rebalance config from S3:', error instanceof Error ? error.message : error);
    return null;
  }
};

/**
 * Fetch threshold-based rebalancer configs from S3.
 * These are exported by fee-admin as threshold-rebalance-config.json.
 * Uses the same S3 bucket as regular rebalance config.
 *
 * Priority chain: S3 (fee-admin) > SSM/configJson > env vars
 */
export const getThresholdRebalanceConfigFromS3 = async (): Promise<ThresholdRebalanceS3Config | null> => {
  try {
    const bucket = process.env.REBALANCE_CONFIG_S3_BUCKET;
    const key = process.env.THRESHOLD_REBALANCE_CONFIG_S3_KEY || 'threshold-rebalance-config.json';
    const region = process.env.REBALANCE_CONFIG_S3_REGION;

    if (!bucket) {
      return null;
    }

    const client = getS3Client(region);
    if (!client) {
      return null;
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await client.send(command);

    if (!response.Body) {
      return null;
    }

    const bodyString = await response.Body.transformToString();
    const config = JSON.parse(bodyString) as ThresholdRebalanceS3Config;

    const configKeys = Object.keys(config);
    console.log('Successfully loaded threshold rebalance config from S3', {
      bucket,
      key,
      configKeys,
      configCount: configKeys.length,
    });

    return config;
  } catch (error) {
    console.warn(
      'Failed to fetch threshold rebalance config from S3:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
