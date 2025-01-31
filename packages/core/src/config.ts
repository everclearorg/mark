import { axiosGet } from './axios';
import { config } from 'dotenv';
import {
  EverclearConfig,
  AssetConfiguration,
  ChainConfiguration,
  Environment,
  MarkConfiguration,
  Stage,
  HubConfig,
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

export const DEFAULT_GAS_THRESHOLD = '5000000000000000'; // 0.005 eth
export const DEFAULT_BALANCE_THRESHOLD = '100000000000000000'; // 0.1 eth
export const DEFAULT_INVOICE_AGE = '600';
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
      web3SignerUrl: requireEnv('SIGNER_URL'),
      everclearApiUrl: requireEnv('EVERCLEAR_API_URL'),
      relayer: process.env.RELAYER_URL
        ? {
            url: process.env.RELAYER_URL,
            key: requireEnv('RELAYER_API_KEY'),
          }
        : undefined,
      ownAddress: requireEnv('SIGNER_ADDRESS'),
      supportedSettlementDomains: parseSettlementDomains(requireEnv('SUPPORTED_SETTLEMENT_DOMAINS')),
      supportedAssets,
      chains: parseChainConfigurations(hostedConfig, supportedAssets),
      logLevel: (process.env.LOG_LEVEL ?? 'debug') as LogLevel,
      stage: (process.env.STAGE ?? 'development') as Stage,
      environment: (process.env.ENVIRONMENT ?? 'local') as Environment,
      hub: parseHubConfigurations(hostedConfig, environment),
    };

    validateConfiguration(config);
    return config;
  } catch (_error: unknown) {
    const error = _error as Error;
    throw new ConfigurationError('Failed to load configuration: ' + error.message, { error: JSON.stringify(error) });
  }
}

function validateConfiguration(config: MarkConfiguration): void {
  if (!config.web3SignerUrl) {
    throw new ConfigurationError('Signer address is required');
  }

  if (!config.everclearApiUrl) {
    throw new ConfigurationError('Everclear API URL is required');
  }

  if (Object.keys(config.chains).length === 0) {
    throw new ConfigurationError('At least one chain configuration is required');
  }

  for (const chain of Object.keys(config.chains)) {
    const invoiceAge = config.chains[chain].invoiceAge;
    if (!invoiceAge || invoiceAge <= 0) {
      throw new ConfigurationError('Invalid invoice age for chain:' + chain);
    }
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
      Object.values(config?.chains[chainId]?.assets ?? {}).map((a) => ({
        ...a,
        balanceThreshold: DEFAULT_BALANCE_THRESHOLD,
      }));

    // Get the invoice age
    // First, check if there is a configured invoice age in the env
    const invoiceAge = process.env[`CHAIN_${chainId}_INVOICE_AGE`] ?? process.env[`INVOICE_AGE`] ?? DEFAULT_INVOICE_AGE;
    const gasThreshold =
      process.env[`CHAIN_${chainId}_GAS_THRESHOLD`] ?? process.env[`GAS_THRESHOLD`] ?? DEFAULT_GAS_THRESHOLD;
    chains[chainId] = {
      providers,
      assets: assets.filter((asset) => supportedAssets.includes(asset.symbol)),
      invoiceAge: parseInt(invoiceAge),
      gasThreshold,
    };
  }

  return chains;
}

function parseHubConfigurations(
  config: EverclearConfig | undefined,
  environment: Environment,
): Omit<HubConfig, 'confirmations' | 'subgraphUrls'> {
  const chainId = process.env.HUB_CHAIN ?? config?.hub.domain ?? (environment === 'mainnet' ? '25327' : '6398');

  const assets =
    (process.env[`CHAIN_${chainId}_ASSETS`] ? parseAssets(process.env[`CHAIN_${chainId}_ASSETS`]!) : undefined) ??
    Object.values(config?.hub.assets ?? {});

  const providers =
    (process.env[`CHAIN_${chainId}_PROVIDERS`]
      ? parseProviders(process.env[`CHAIN_${chainId}_PROVIDERS`]!)
      : undefined) ??
    config?.hub.providers ??
    [];
  return {
    domain: chainId,
    providers,
    assets: assets.length > 0 ? assets : undefined,
  };
}

function parseProviders(providers: string): string[] {
  return providers.split(',').map((provider) => provider.trim());
}

function parseAssets(assets: string): AssetConfiguration[] {
  return assets.split(';').map((asset) => {
    const [symbol, address, decimals, tickerHash, isNative, balanceThreshold] = asset.split(',').map((s) => s.trim());
    return {
      symbol,
      address,
      decimals: parseInt(decimals, 10),
      tickerHash,
      isNative: isNative === 'true',
      balanceThreshold,
    };
  });
}

export const getTokenAddressFromConfig = (
  tickerHash: string,
  domain: string,
  config: MarkConfiguration,
): string | undefined => {
  const asset = (config.chains[domain]?.assets ?? []).find(
    (a) => a.tickerHash.toLowerCase() === tickerHash.toLowerCase(),
  );
  if (!asset) {
    return undefined;
  }
  return asset.address;
};

export const getDecimalsFromConfig = (ticker: string, domain: string, config: MarkConfiguration) => {
  const asset = (config.chains[domain]?.assets ?? []).find((a) => a.tickerHash.toLowerCase() === ticker.toLowerCase());
  if (!asset) {
    return undefined;
  }
  return asset.decimals;
};
