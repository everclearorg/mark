import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { RebalanceConfig } from './types/config';

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
    });

    return config;
  } catch (error) {
    console.warn('Failed to fetch rebalance config from S3:', error instanceof Error ? error.message : error);
    return null;
  }
};
