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
import { getSsmParameter } from './ssm';
import { existsSync, readFileSync } from 'fs';

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
export const DEFAULT_BALANCE_THRESHOLD = '0'; // 0
export const DEFAULT_INVOICE_AGE = '1';
export const EVERCLEAR_MAINNET_CONFIG_URL = 'https://raw.githubusercontent.com/connext/chaindata/main/everclear.json';
export const EVERCLEAR_TESTNET_CONFIG_URL =
  'https://raw.githubusercontent.com/connext/chaindata/main/everclear.testnet.json';
export const EVERCLEAR_MAINNET_API_URL = 'https://api.everclear.org';
export const EVERCLEAR_TESTNET_API_URL = 'https://api.testnet.everclear.org';

export const UTILITY_CONTRACTS_DEFAULT = {
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
export const UTILITY_CONTRACTS_OVERRIDE: Record<string, { permit2?: string; multicall3?: string }> = {
  '324': {
    permit2: '0x0000000000225e31D15943971F47aD3022F714Fa',
    multicall3: '0xF9cda624FBC7e059355ce98a31693d299FACd963',
  },
  '2020': {
    permit2: '0x771ca29e483df5447e20a89e0f00e1daf09ef534',
  },
  // '167000': {
  //   // Contract exists here but unverified: https://taikoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3
  //   permit2: '0x0000000000225e31D15943971F47aD3022F714Fa',
  // },
  // '33139': {
  //   // Contract exists here but unverified: https://apescan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3
  //   permit2: '0x0000000000225e31D15943971F47aD3022F714Fa',
  // },
};

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
    const environment = ((await fromEnv('ENVIRONMENT')) ?? 'local') as Environment;
    const url = environment === 'mainnet' ? EVERCLEAR_MAINNET_CONFIG_URL : EVERCLEAR_TESTNET_CONFIG_URL;
    const apiUrl = environment === 'mainnet' ? EVERCLEAR_MAINNET_API_URL : EVERCLEAR_TESTNET_API_URL;

    const hostedConfig = await getEverclearConfig(url);

    const configStr = await fromEnv('MARK_CONFIG_' + environment.toUpperCase(), true);
    const configJson = existsSync('config.json')
      ? JSON.parse(readFileSync('config.json', 'utf8'))
      : JSON.parse(configStr ?? '{}');

    const supportedAssets =
      configJson.supportedAssets ?? parseSupportedAssets(await requireEnv('SUPPORTED_ASSET_SYMBOLS'));

    const config: MarkConfiguration = {
      pushGatewayUrl: configJson.pushGatewayUrl ?? (await requireEnv('PUSH_GATEWAY_URL')),
      web3SignerUrl: configJson.web3SignerUrl ?? (await requireEnv('SIGNER_URL')),
      everclearApiUrl: configJson.everclearApiUrl ?? (await fromEnv('EVERCLEAR_API_URL')) ?? apiUrl,
      relayer: {
        url: configJson?.relayer?.url ?? (await fromEnv('RELAYER_URL')) ?? undefined,
        key: configJson?.relayer?.key ?? (await fromEnv('RELAYER_API_KEY')) ?? undefined,
      },
      redis: configJson.redis ?? {
        host: await requireEnv('REDIS_HOST'),
        port: parseInt(await requireEnv('REDIS_PORT')),
      },
      ownAddress: configJson.signerAddress ?? (await requireEnv('SIGNER_ADDRESS')),
      supportedSettlementDomains:
        configJson.supportedSettlementDomains ??
        parseSettlementDomains(await requireEnv('SUPPORTED_SETTLEMENT_DOMAINS')),
      supportedAssets,
      chains: await parseChainConfigurations(hostedConfig, supportedAssets, configJson),
      logLevel: ((await fromEnv('LOG_LEVEL')) ?? 'debug') as LogLevel,
      stage: ((await fromEnv('STAGE')) ?? 'development') as Stage,
      environment,
      hub: configJson.hub ?? parseHubConfigurations(hostedConfig, environment),
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

const requireEnv = async (name: string, checkSsm = false): Promise<string> => {
  const value = await fromEnv(name, checkSsm);
  if (!value) {
    throw new ConfigurationError(`Environment variable ${name} is required`);
  }
  return value;
};

const fromEnv = async (name: string, checkSsm = false): Promise<string | undefined> => {
  let value = undefined;
  if (checkSsm) {
    value = await getSsmParameter(name);
  }
  return value ?? process.env[name];
};

function parseSettlementDomains(domains: string): number[] {
  return domains.split(',').map((domain) => parseInt(domain.trim(), 10));
}

const parseSupportedAssets = (symbols: string): string[] => {
  return symbols.split(',').map((symbol) => symbol.trim());
};

const parseChainConfigurations = async (
  config: EverclearConfig | undefined,
  supportedAssets: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configJson: any,
): Promise<Record<string, ChainConfiguration>> => {
  // If config is undefined or doesn't have chains, we can't proceed
  if (!config?.chains) {
    throw new ConfigurationError('No chain configurations found in the Everclear config');
  }

  // Use chainIds from configJson if available, otherwise from environment variable,
  // or as a last resort, use the keys from the hosted config
  const chainIds = configJson.chains
    ? Object.keys(configJson.chains)
    : (await fromEnv('CHAIN_IDS'))
      ? (await fromEnv('CHAIN_IDS'))!.split(',').map((id) => id.trim())
      : Object.keys(config.chains);

  const chains: Record<string, ChainConfiguration> = {};

  for (const chainId of chainIds) {
    if (!config.chains[chainId]) {
      console.log(`Chain ${chainId} not found in Everclear config, skipping`);
      continue;
    }

    const chainConfig = config.chains[chainId]!;

    const providers = (
      configJson.chains?.[chainId]?.providers ??
      ((await fromEnv(`CHAIN_${chainId}_PROVIDERS`))
        ? parseProviders((await fromEnv(`CHAIN_${chainId}_PROVIDERS`))!)
        : undefined) ??
      []
    ).concat(chainConfig.providers ?? []);

    const assets = await Promise.all(
      Object.values(chainConfig.assets ?? {}).map(async (a) => {
        const jsonThreshold = (configJson.chains?.[chainId]?.assets ?? []).find(
          (asset: { symbol: string; balanceThreshold: string }) =>
            a.symbol.toLowerCase() === asset.symbol.toLowerCase(),
        )?.balanceThreshold;
        const envThreshold = await fromEnv(`${a.symbol.toUpperCase()}_${chainId}_THRESHOLD`);
        return {
          ...a,
          balanceThreshold: jsonThreshold ?? envThreshold ?? DEFAULT_BALANCE_THRESHOLD,
        };
      }),
    );

    // Get the invoice age
    // First, check if there is a configured invoice age in the env
    const invoiceAge =
      (await fromEnv(`CHAIN_${chainId}_INVOICE_AGE`)) ?? (await fromEnv('INVOICE_AGE')) ?? DEFAULT_INVOICE_AGE;
    const gasThreshold =
      configJson?.chains?.[chainId]?.gasThreshold ??
      (await fromEnv(`CHAIN_${chainId}_GAS_THRESHOLD`)) ??
      (await fromEnv(`GAS_THRESHOLD`)) ??
      DEFAULT_GAS_THRESHOLD;

    // Extract Everclear spoke address from the config
    const everclear = chainConfig.deployments?.everclear;

    if (!everclear) {
      throw new ConfigurationError(
        `No spoke address found for chain ${chainId}. Make sure it's defined in the config under chains.${chainId}.deployments.everclear`,
      );
    }

    // Get chain-specific contract addresses or use config values if provided
    const permit2 =
      chainConfig.deployments?.permit2 ||
      UTILITY_CONTRACTS_OVERRIDE[chainId]?.permit2 ||
      UTILITY_CONTRACTS_DEFAULT.permit2;

    const multicall3 =
      chainConfig.deployments?.multicall3 ||
      UTILITY_CONTRACTS_OVERRIDE[chainId]?.multicall3 ||
      UTILITY_CONTRACTS_DEFAULT.multicall3;

    chains[chainId] = {
      providers,
      assets: assets.filter((asset) => supportedAssets.includes(asset.symbol)),
      invoiceAge: parseInt(invoiceAge),
      gasThreshold,
      deployments: {
        everclear,
        permit2,
        multicall3,
      },
    };
  }

  return chains;
};

function parseHubConfigurations(
  config: EverclearConfig | undefined,
  environment: Environment,
): Omit<HubConfig, 'confirmations' | 'subgraphUrls'> {
  const chainId = process.env.HUB_CHAIN ?? config?.hub.domain ?? (environment === 'mainnet' ? '25327' : '6398');

  const assets =
    (process.env[`CHAIN_${chainId}_ASSETS`] ? parseAssets(process.env[`CHAIN_${chainId}_ASSETS`]!) : undefined) ??
    Object.values(config?.hub.assets ?? {}).map((a) => ({ ...a, balanceThreshold: '0' }));

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
      isNative: isNative?.toLowerCase() === 'true',
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
