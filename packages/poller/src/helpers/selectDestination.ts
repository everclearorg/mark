import { ProcessInvoicesConfig } from 'src/invoice/processInvoices';
import { getHubStorageContract } from './contracts';
import { MarkConfiguration } from '@mark/core';

export const findBestDestination = async (
  origin: string,
  tickerHash: string,
  config: MarkConfiguration,
): Promise<number> => {
  try {
    const hubStorage = await getHubStorageContract(config);

    let bestDestination: number | null = null;
    let maxLiquidity = BigInt(0);

    for (const chainId in config.chains) {
      if (chainId === origin) {
        continue; // Skip the origin chain
      }

      const assetHash = await hubStorage.read.assetHash([tickerHash, chainId]);
      const custodiedLiquidity = (await hubStorage.read.custodiedAsset([assetHash])) as bigint;

      if (custodiedLiquidity > maxLiquidity) {
        bestDestination = parseInt(chainId, 10); // Convert string chainId to number
        maxLiquidity = custodiedLiquidity;
      }
    }

    if (bestDestination === null) {
      throw new Error('No suitable destination found with sufficient liquidity.');
    }

    return bestDestination;
  } catch (error) {
    console.error('Error in findBestDestination:', error);
    throw new Error(`Failed to find the best destination: ${(error as unknown as Error).message}`);
  }
};
