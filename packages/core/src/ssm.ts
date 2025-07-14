import { SSMClient, DescribeParametersCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * Gets a parameter from AWS Systems Manager Parameter Store
 * @param name - The name of the parameter
 * @returns - The parameter string value, or undefined if the parameter not found or SSM is unavailable.
 */
export const getSsmParameter = async (name: string): Promise<string | undefined> => {
  try {
    const client = new SSMClient();

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
    const describeParametersResponse = await client.send(describeParametersCommand);
    if (!describeParametersResponse.Parameters?.length) {
      return;
    }

    // Get the parameter value.
    const getParameterCommand = new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    });
    const getParameterResponse = await client.send(getParameterCommand);

    return getParameterResponse.Parameter?.Value;
  } catch (error) {
    // Log the error but don't fail - allows fallback to environment variables
    console.warn(`Failed to fetch SSM parameter '${name}':`, error instanceof Error ? error.message : error);
    return undefined;
  }
};
