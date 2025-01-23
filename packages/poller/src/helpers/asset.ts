import { getTokenAddressFromConfig, MarkConfiguration } from '@mark/core';
import { padBytes, hexToBytes, keccak256, encodeAbiParameters, bytesToHex } from 'viem';
import { getHubStorageContract } from './contracts';

export const getTickers = (config: MarkConfiguration) => {
  const tickers = Object.values(config.chains)
    .map((c) => c.assets)
    .map((c) => c.map((a) => a.tickerHash.toLowerCase()))
    .flat();
  return tickers;
};

export const getAssetHash = (ticker: string, domain: string, config: MarkConfiguration): string | undefined => {
  // Get the token address
  const tokenAddr = getTokenAddressFromConfig(ticker, domain, config);
  if (!tokenAddr) {
    return undefined;
  }
  // Get the asset hash
  const assetHash = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [addressToBytes32(tokenAddr), parseInt(domain)]),
  );
  return assetHash;
};

/**
 * Returns true if the XERC20 strategy is supported on any of the domains for the
 * given ticker hash
 */
export const isXerc20Supported = async (
  ticker: string,
  domains: string[],
  config: MarkConfiguration,
): Promise<boolean> => {
  for (const domain of domains) {
    // Get the asset hash
    const assetHash = getAssetHash(ticker, domain, config);
    if (!assetHash) {
      // asset does not exist on this domain
      continue;
    }
    // Get the asset config
    const assetConfig = await getAssetConfig(assetHash, config);
    if (assetConfig.strategy === SettlementStrategy.XERC20) {
      // Exit if an asset config is xerc20
      return true;
    }
  }
  return false;
};

enum SettlementStrategy {
  DEFAULT,
  XERC20,
}
type AssetConfig = {
  tickerHash: string;
  adopted: string;
  domain: string;
  approval: boolean;
  strategy: SettlementStrategy;
};
const getAssetConfig = async (assetHash: string, config: MarkConfiguration): Promise<AssetConfig> => {
  const contract = getHubStorageContract(config);
  const assetConfig = (await contract.read.adoptedForAssets([assetHash])) as unknown as AssetConfig;
  return assetConfig;
};

const addressToBytes32 = (addr: string): `0x${string}` => {
  return bytesToHex(padBytes(hexToBytes(addr as `0x${string}`), { size: 32, dir: 'left' }));
};
