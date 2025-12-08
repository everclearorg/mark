import { padBytes, hexToBytes, keccak256, encodeAbiParameters, bytesToHex, formatUnits, parseUnits } from 'viem';
import {
  getTokenAddressFromConfig,
  MarkConfiguration,
  base58ToHex,
  isSvmChain,
  isAddress,
  isTvmChain,
} from '@mark/core';
import { getHubStorageContract } from './contracts';
import { safeStringToBigInt } from './balance';

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
 * Convert amount from standardized 18 decimals to native token decimals
 * @param amount Amount in 18 decimal representation
 * @param decimals Native token decimals
 * @returns Amount in native token units
 */
export const convertToNativeUnits = (amount: bigint, decimals: number | undefined): bigint => {
  const targetDecimals = decimals ?? 18;
  if (targetDecimals === 18) {
    return amount;
  }

  const divisor = BigInt(10 ** (18 - targetDecimals));
  return amount / divisor;
};

/**
 * Convert amount from native token decimals to standardized 18 decimals
 * @param amount Amount in native token units
 * @param decimals Native token decimals
 * @returns Amount in 18 decimal representation
 */
export const convertTo18Decimals = (amount: bigint, decimals: number | undefined): bigint => {
  return parseUnits(formatUnits(amount, decimals ?? 18), 18);
};

/**
 * Get the scale factor for converting string amounts to bigint with proper decimals
 * @param decimals Token decimals
 * @returns Scale factor as bigint
 */
export const getScaleFactor = (decimals: number | undefined): bigint => {
  return BigInt(10 ** (decimals ?? 18));
};

/**
 * Parse a string amount with the given decimals into a bigint
 * @param amount String amount to parse
 * @param decimals Token decimals
 * @returns Parsed amount as bigint in smallest unit
 */
export const parseAmountWithDecimals = (amount: string, decimals: number | undefined): bigint => {
  const scaleFactor = getScaleFactor(decimals);
  return safeStringToBigInt(amount, scaleFactor);
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

export const getAssetHash = (
  ticker: string,
  domain: string,
  config: MarkConfiguration,
  getTokenAddressFn: (ticker: string, domain: string, config: MarkConfiguration) => string | undefined,
): string | undefined => {
  const tokenAddr = getTokenAddressFn(ticker, domain, config);
  if (!tokenAddr) {
    return undefined;
  }

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
    if (isSvmChain(domain) || isTvmChain(domain)) {
      continue;
    }
    // Get the asset hash
    const assetHash = getAssetHash(ticker, domain, config, getTokenAddressFromConfig);
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

const addressToBytes32 = (addr: string): `0x${string}` => {
  return bytesToHex(padBytes(hexToBytes(addr as `0x${string}`), { size: 32, dir: 'left' }));
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

/**
 * Gets the TON jetton address for a given ticker hash from config.
 * TON is not an EVM chain, so assets are stored separately in config.ton.assets
 * instead of the chains block.
 *
 * @param tickerHash The ticker hash to look up
 * @param config The Mark configuration
 * @returns The TON jetton address or undefined if not found
 */
export function getTonAssetAddress(tickerHash: string, config: MarkConfiguration): string | undefined {
  if (!config.ton?.assets) {
    return undefined;
  }

  const asset = config.ton.assets.find((a) => a.tickerHash.toLowerCase() === tickerHash.toLowerCase());

  return asset?.jettonAddress;
}

/**
 * Gets the TON asset decimals for a given ticker hash from config.
 *
 * @param tickerHash The ticker hash to look up
 * @param config The Mark configuration
 * @returns The decimals or undefined if not found
 */
export function getTonAssetDecimals(tickerHash: string, config: MarkConfiguration): number | undefined {
  if (!config.ton?.assets) {
    return undefined;
  }

  const asset = config.ton.assets.find((a) => a.tickerHash.toLowerCase() === tickerHash.toLowerCase());

  return asset?.decimals;
}
