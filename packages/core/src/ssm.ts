import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

let ssmClient: SSMClient | null = null;
let clientInitializationFailed = false;

export class SsmParameterReadError extends Error {
  constructor(
    public readonly parameterName: string,
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'SsmParameterReadError';
  }
}

const getSSMClient = (): SSMClient | null => {
  if (clientInitializationFailed) {
    return null;
  }

  if (!ssmClient) {
    if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
      console.warn('AWS region not configured, using environment variable fallbacks');
      clientInitializationFailed = true;
      return null;
    }

    try {
      ssmClient = new SSMClient();
    } catch (error) {
      console.warn(
        'SSM client initialization failed, using environment variable fallbacks:',
        error instanceof Error ? error.message : error,
      );
      clientInitializationFailed = true;
      return null;
    }
  }

  return ssmClient;
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = error.message ?? '';
  return (
    name === 'ThrottlingException' ||
    name === 'TooManyRequestsException' ||
    name === 'ProvisionedThroughputExceededException' ||
    name === 'InternalServerError' ||
    name === 'ServiceUnavailableException' ||
    message.includes('Rate exceeded') ||
    message.includes('Throttling') ||
    message.includes('ECONNRESET') ||
    message.includes('socket hang up')
  );
}

/**
 * Gets a parameter from AWS Systems Manager Parameter Store.
 * Uses GetParameter directly (no DescribeParameters pre-check) to halve API calls.
 * Retries on transient/throttling errors with exponential backoff.
 *
 * @param name - The name of the parameter
 * @returns The parameter string value, or undefined if not found or SSM is unavailable.
 */
export const getSsmParameter = async (name: string): Promise<string | undefined> => {
  const client = getSSMClient();
  if (!client) {
    throw new SsmParameterReadError(name, `SSM client unavailable while fetching parameter '${name}'`);
  }

  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.send(command);
      return response.Parameter?.Value;
    } catch (error) {
      const errorName = (error as { name?: string }).name ?? '';

      if (errorName === 'ParameterNotFound') {
        return undefined;
      }

      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 100;
        console.warn(
          `⚠️  SSM parameter '${name}' read failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms):`,
          error instanceof Error ? error.message : error,
        );
        await sleep(delay);
        continue;
      }

      console.warn(
        `⚠️  Failed to fetch SSM parameter '${name}' after ${attempt + 1} attempt(s):`,
        error instanceof Error ? error.message : error,
      );
      throw new SsmParameterReadError(
        name,
        `Failed to fetch SSM parameter '${name}' after ${attempt + 1} attempt(s): ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  throw new SsmParameterReadError(name, `Unexpected failure while fetching SSM parameter '${name}'`);
};
