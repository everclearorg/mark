import { SSMClient, DescribeParametersCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

// Singleton client to prevent race conditions
let ssmClient: SSMClient | null = null;
let clientInitializationFailed = false;

const getSSMClient = (): SSMClient | null => {
  if (clientInitializationFailed) {
    return null;
  }

  if (!ssmClient) {
    // Check if AWS region is available before attempting to initialize
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

/**
 * Gets a parameter from AWS Systems Manager Parameter Store
 * @param name - The name of the parameter
 * @returns - The parameter string value, or undefined if the parameter not found or SSM is unavailable.
 */
export const getSsmParameter = async (name: string): Promise<string | undefined> => {
  try {
    const client = getSSMClient();
    if (!client) {
      return undefined;
    }

    // Check if the parameter exists.
    const describeParametersCommand = new DescribeParametersCommand({
      ParameterFilters: [
        {
          Key: 'Name',
          Option: 'Equals',
          Values: [name],
        },
      ],
    });

    let describeParametersResponse;
    try {
      describeParametersResponse = await client.send(describeParametersCommand);
    } catch (error) {
      // Handle region-related and other AWS configuration errors
      console.warn(`⚠️  Failed to fetch SSM parameter '${name}':`, error instanceof Error ? error.message : error);
      return undefined;
    }

    if (!describeParametersResponse.Parameters?.length) {
      return undefined;
    }

    // Get the parameter value.
    const getParameterCommand = new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    });

    let getParameterResponse;
    try {
      getParameterResponse = await client.send(getParameterCommand);
    } catch (error) {
      // Handle region-related and other AWS configuration errors
      console.warn(`⚠️  Failed to fetch SSM parameter '${name}':`, error instanceof Error ? error.message : error);
      return undefined;
    }

    return getParameterResponse.Parameter?.Value;
  } catch (error) {
    // Fallback catch for any unexpected errors
    console.warn(`⚠️  Failed to fetch SSM parameter '${name}':`, error instanceof Error ? error.message : error);
    return undefined;
  }
};
