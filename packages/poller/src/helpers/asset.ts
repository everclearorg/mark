import { getTokenAddressFromConfig, MarkConfiguration, base58ToHex, isSvmChain, isAddress } from '@mark/core';
import { formatUnits, zeroHash } from 'viem';
import { getHubStorageContract } from './contracts';

export const getTickers = (config: MarkConfiguration) => {
  const tickers = Object.values(config.chains)
    .map((c) => c.assets)
    .map((c) => c.map((a) => a.tickerHash.toLowerCase()))
    .flat();

  return [...new Set(tickers)];
};

export const getTickerForAsset = (asset: string, chain: number, config: MarkConfiguration) => {
  const chainConfig = config.chains[chain.toString()];
  if (!chainConfig || !chainConfig.assets) {
    return undefined;
  }
  const assetConfig = chainConfig.assets.find((a) => a.address.toLowerCase() === asset.toLowerCase());
  if (!assetConfig) {
    return undefined;
  }
  return assetConfig.tickerHash;
};

/**
 * @notice Invoices are always normalized to 18 decimal units. This will convert the given invoice amount
 * to the local units (ie USDC is 6 decimals on ethereum, but represents as an 18 decimal invoice)
 * @dev This will round up if there is precision loss
 */
export const convertHubAmountToLocalDecimals = (
  amount: bigint,
  asset: string,
  domain: string,
  config: MarkConfiguration,
): string => {
  const assetAddr = isAddress(asset) ? '0x' + base58ToHex(asset) : asset.toLowerCase();
  const assetDecimals =
    (config.chains[domain]?.assets ?? []).find((a) => a.address.toLowerCase() === assetAddr)?.decimals ?? 18;
  const [integer, decimal] = formatUnits(amount, 18 - assetDecimals).split('.');
  const ret = decimal ? (BigInt(integer) + 1n).toString() : integer;
  return ret;
};

export const getAssetHash = async (
  ticker: string,
  domain: string,
  config: MarkConfiguration,
  getTokenAddressFn: (ticker: string, domain: string, config: MarkConfiguration) => string | undefined,
): Promise<string | undefined> => {
  const tokenAddr = getTokenAddressFn(ticker, domain, config);
  if (!tokenAddr) {
    return undefined;
  }

  const assetHash = (await getHubStorageContract(config).read.assetHash([ticker, BigInt(domain)])) as string;

  return assetHash === zeroHash ? undefined : assetHash;
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
    if (isSvmChain(domain)) {
      continue;
    }
    // Get the asset hash
    const assetHash = await getAssetHash(ticker, domain, config, getTokenAddressFromConfig);
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
export const getAssetConfig = async (assetHash: string, config: MarkConfiguration): Promise<AssetConfig> => {
  const contract = getHubStorageContract(config);
  const assetConfig = (await contract.read.adoptedForAssets([assetHash])) as unknown as AssetConfig;
  return assetConfig;
};

/**
 * Gets the list of domains that support a given ticker
 * @param ticker The ticker hash
 * @param config The Mark configuration
 * @returns Array of domain IDs that support the ticker
 */
export function getSupportedDomainsForTicker(ticker: string, config: MarkConfiguration): string[] {
  const configDomains = config.supportedSettlementDomains.map((d) => d.toString());

  // Filter for domains that support the given asset, maintaining the original config order
  return configDomains.filter((domain) => {
    const chainConfig = config.chains[domain];
    if (!chainConfig) return false;
    const tickers = chainConfig.assets.map((a) => a.tickerHash.toLowerCase());
    return tickers.includes(ticker.toLowerCase());
  });
}
