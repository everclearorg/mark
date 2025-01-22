import { axiosGet } from './axios';
import { config } from 'dotenv';
import {
  EverclearConfig,
  AssetConfiguration,
  ChainConfiguration,
  Environment,
  MarkConfiguration,
  Stage,
} from './types/config';
import { LogLevel } from './types/logging';

config();

export class ConfigurationError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export const EVERCLEAR_MAINNET_CONFIG_URL = 'https://raw.githubusercontent.com/connext/chaindata/main/everclear.json';
export const EVERCLEAR_TESTNET_CONFIG_URL =
  'https://raw.githubusercontent.com/connext/chaindata/main/everclear.testnet.json';

export const getEverclearConfig = async (_configUrl?: string): Promise<EverclearConfig | undefined> => {
  const configUrl = _configUrl ?? EVERCLEAR_MAINNET_CONFIG_URL;

  try {
    const res = await axiosGet(configUrl);
    if (!res.data) {
      throw new Error(`Failed to retrieve config from ${configUrl}`);
    }
    // TODO: add validation of config?
    return res.data as EverclearConfig;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err: unknown) {
    if (configUrl === EVERCLEAR_MAINNET_CONFIG_URL) {
      return undefined;
    }
    try {
      const res = await axiosGet(EVERCLEAR_MAINNET_CONFIG_URL);
      if (res.data) return res.data as EverclearConfig;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err: unknown) {
      return undefined;
    }

    return undefined;
  }
};

export async function loadConfiguration(): Promise<MarkConfiguration> {
  try {
    const environment = (process.env.ENVIRONMENT ?? 'local') as Environment;
    const url = environment === 'mainnet' ? EVERCLEAR_MAINNET_CONFIG_URL : EVERCLEAR_TESTNET_CONFIG_URL;

    const hostedConfig = await getEverclearConfig(url);

    const supportedAssets = parseSupportedAssets(requireEnv('SUPPORTED_ASSETS'));

    const config: MarkConfiguration = {
      invoiceAge: parseInt(requireEnv('INVOICE_AGE'), 10),
      web3SignerUrl: requireEnv('SIGNER_ADDRESS'),
      everclearApiUrl: requireEnv('EVERCLEAR_API_URL'),
      relayer: process.env.RELAYER_URL
        ? {
            url: process.env.RELAYER_URL,
            key: requireEnv('RELAYER_API_KEY'),
          }
        : undefined,
      ownAddress: 'Mark Address',
      supportedSettlementDomains: parseSettlementDomains(requireEnv('SUPPORTED_SETTLEMENT_DOMAINS')),
      supportedAssets,
      chains: parseChainConfigurations(hostedConfig, supportedAssets),
      logLevel: (process.env.LOG_LEVEL ?? 'debug') as LogLevel,
      stage: (process.env.STAGE ?? 'development') as Stage,
      environment: (process.env.ENVIRONMENT ?? 'local') as Environment,
    };

    validateConfiguration(config);
    return config;
  } catch (_error: unknown) {
    const error = _error as Error;
    throw new ConfigurationError('Failed to load configuration: ' + error.message, { error: JSON.stringify(error) });
  }
}

function validateConfiguration(config: MarkConfiguration): void {
  if (!config.invoiceAge || config.invoiceAge <= 0) {
    throw new ConfigurationError('Invalid invoice age');
  }

  if (!config.web3SignerUrl) {
    throw new ConfigurationError('Signer address is required');
  }

  if (!config.everclearApiUrl) {
    throw new ConfigurationError('Everclear API URL is required');
  }

  if (Object.keys(config.chains).length === 0) {
    throw new ConfigurationError('At least one chain configuration is required');
  }

  if (config.supportedSettlementDomains.length === 0) {
    throw new ConfigurationError('At least one settlement domain is required');
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigurationError(`Environment variable ${name} is required`);
  }
  return value;
}

function parseSettlementDomains(domains: string): number[] {
  return domains.split(',').map((domain) => parseInt(domain.trim(), 10));
}

const parseSupportedAssets = (symbols: string): string[] => {
  return symbols.split(',').map((symbol) => symbol.trim());
};

function parseChainConfigurations(
  config: EverclearConfig | undefined,
  supportedAssets: string[],
): Record<string, ChainConfiguration> {
  const chainIds = requireEnv('CHAIN_IDS')
    .split(',')
    .map((id) => id.trim());
  const chains: Record<string, ChainConfiguration> = {};

  for (const chainId of chainIds) {
    const providers =
      (process.env[`CHAIN_${chainId}_PROVIDERS`]
        ? parseProviders(process.env[`CHAIN_${chainId}_PROVIDERS`]!)
        : undefined) ??
      config?.chains[chainId]?.providers ??
      [];
    const assets =
      (process.env[`CHAIN_${chainId}_ASSETS`] ? parseAssets(process.env[`CHAIN_${chainId}_ASSETS`]!) : undefined) ??
      Object.values(config?.chains[chainId]?.assets ?? {});
    chains[chainId] = {
      providers,
      assets: assets.filter((asset) => supportedAssets.includes(asset.symbol)),
    };
  }

  return chains;
}

function parseProviders(providers: string): string[] {
  return providers.split(',').map((provider) => provider.trim());
}

function parseAssets(assets: string): AssetConfiguration[] {
  return assets.split(';').map((asset) => {
    const [symbol, address, decimals, tickerHash, isNative] = asset.split(',').map((s) => s.trim());
    return {
      symbol,
      address,
      decimals: parseInt(decimals, 10),
      tickerHash,
      isNative: isNative === 'true',
    };
  });
}

export const tokenAddressMapping: Record<string, Record<string, string>> = {
  '0xaaaebeba3810b1e6b70781f14b2d72c1cb89c0b2b320c43bb67ff79f562f5ff4': {
    '25327': '0x0000000000000000000000000000000000000000', // Hub ETH
    '1': '0x0000000000000000000000000000000000000000', // Ethereum ETH
  },
  '0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8': {
    '25327': '0x2e31ebD2eB114943630Db6ba8c7f7687bdA5835F', // Hub WETH
    '1': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Ethereum WETH
    '10': '0x4200000000000000000000000000000000000006', // Optimism WETH
  },
  '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa': {
    '1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum USDC
    '10': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Optimism USDC
    '56': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // BSC USDC
  },
  '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0': {
    '1': '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Ethereum USDT
    '10': '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // Optimism USDT
    '56': '0x55d398326f99059fF775485246999027B3197955', // BSC USDT
  },
  '0x7ca978c7f993c411238b0887969711b470a3133448ab70e4f18aa4d63dcb7907': {
    '48900': '0x9346A5043C590133FE900aec643D9622EDddBA57', // Zircuit xPufETH
    '1': '0xD7D2802f6b19843ac4DfE25022771FD83b5A7464', // Ethereum xPufETH
  },
  '0x06ac253a00ee13562eecafc06057c6db73566a05bdce988194aad3616e28e87c': {
    '25327': '0x58b9cB810A68a7f3e1E4f8Cb45D1B9B3c79705E8', // Hub CLEAR
  },
};

export const getTokenAddress = (ticker_hash: string, origin: string): string => {
  return fetchTokenAddress(ticker_hash, origin);
};

export const fetchTokenAddress = (ticker_hash: string, origin: string): string => {
  const tokenAddress = tokenAddressMapping[ticker_hash]?.[origin];
  if (!tokenAddress) {
    throw new Error(`No token address found in config for ticker_hash: ${ticker_hash} and origin: ${origin}`);
  }
  return tokenAddress;
};
