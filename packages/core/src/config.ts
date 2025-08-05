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
  RebalanceConfig,
  SupportedBridge,
} from './types/config';
import { LogLevel } from './types/logging';
import { getSsmParameter } from './ssm';
import { existsSync, readFileSync } from 'fs';
import { hexToBase58 } from './solana';

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

export const loadRebalanceRoutes = async (): Promise<RebalanceConfig> => {
  return {
    routes: [
      // bnb    ethereum    WETH    5000000000000000000 30
      {
        origin: 56,
        destination: 1,
        asset: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        maximum: '5000000000000000000',
        slippages: [30],
        preferences: [SupportedBridge.Binance],
      },
      // optimism    ethereum    WETH
      {
        origin: 10,
        destination: 1,
        asset: '0x4200000000000000000000000000000000000006',
        maximum: '55000000000000000000',
        reserve: '50000000000000000000',
        slippages: [30],
        preferences: [SupportedBridge.Binance],
      },
      // arbitrum    ethereum    WETH
      {
        origin: 42161,
        destination: 1,
        asset: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        maximum: '105000000000000000000',
        reserve: '100000000000000000000',
        slippages: [-1000, 30],
        preferences: [SupportedBridge.Near, SupportedBridge.Binance],
      },
      // base    ethereum    WETH    20000000000000000000 30
      {
        origin: 8453,
        destination: 1,
        asset: '0x4200000000000000000000000000000000000006',
        maximum: '25000000000000000000',
        reserve: '20000000000000000000',
        slippages: [-1000, 30],
        preferences: [SupportedBridge.Near, SupportedBridge.Binance],
      },
      // blast ethereum WETH    7000000000000000000 160
      // {
      //   origin: 81457,
      //   destination: 1,
      //   asset: '0x4300000000000000000000000000000000000004',
      //   maximum: '7000000000000000000',
      //   slippages: [160],
      //   preferences: [SupportedBridge.Across],
      // },
      // linea ethereum WETH    7000000000000000000 30
      {
        origin: 59144,
        destination: 1,
        asset: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
        maximum: '21000000000000000000',
        reserve: '20000000000000000000',
        slippages: [30],
        preferences: [SupportedBridge.Across],
      },
      // // unichain    ethereum    WETH    10000000000000000000    150
      // {
      //   origin: 130,
      //   destination: 1,
      //   asset: '0x4200000000000000000000000000000000000006',
      //   maximum: '35000000000000000000',
      //   reserve: '30000000000000000000',
      //   slippages: [150],
      //   preferences: [SupportedBridge.Across],
      // },
      // // zksync    ethereum    WETH    10000000000000000000 20
      // {
      //   origin: 324,
      //   destination: 1,
      //   asset: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
      //   maximum: '10000000000000000000',
      //   slippages: [20],
      //   preferences: [SupportedBridge.Across],
      // },
      // scroll    ethereum    WETH    10000000000000000000 20
      {
        origin: 324,
        destination: 1,
        asset: '0x5300000000000000000000000000000000000004',
        maximum: '10000000000000000000',
        reserve: '5000000000000000000',
        slippages: [20],
        preferences: [SupportedBridge.Binance],
      },
      // polygon ethereum USDC
      {
        origin: 137,
        destination: 1,
        asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        maximum: '55000000000000000000000',
        reserve: '50000000000000000000000',
        slippages: [-1000],
        preferences: [SupportedBridge.Near],
      },
      // polygon ethereum USDT
      {
        origin: 137,
        destination: 1,
        asset: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
        maximum: '55000000000000000000000',
        reserve: '50000000000000000000000',
        slippages: [-1000],
        preferences: [SupportedBridge.Near],
      },
      // optimism ethereum USDC
      {
        origin: 10,
        destination: 1,
        asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        maximum: '65000000000000000000000',
        reserve: '60000000000000000000000',
        slippages: [30],
        preferences: [SupportedBridge.Binance],
      },
      // optimism ethereum    USDT    5000000000000000000000 140
      {
        origin: 10,
        destination: 1,
        asset: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        maximum: '5000000000000000000000',
        slippages: [30],
        preferences: [SupportedBridge.Binance],
      },
      // bnb ethereum    USDC    5000000000000000000000 140
      {
        origin: 56,
        destination: 1,
        asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        maximum: '5500000000000000000000',
        reserve: '5000000000000000000000',
        slippages: [-1000, 30],
        preferences: [SupportedBridge.Near, SupportedBridge.Binance],
      },
      // bnb ethereum    USDT    10000000000000000000000 140
      {
        origin: 56,
        destination: 1,
        asset: '0x55d398326f99059fF775485246999027B3197955',
        maximum: '5500000000000000000000',
        reserve: '5000000000000000000000',
        slippages: [-1000, 30],
        preferences: [SupportedBridge.Near, SupportedBridge.Binance],
      },
      // base ethereum    USDC    10000000000000000000000 140
      {
        origin: 8453,
        destination: 1,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        maximum: '65000000000000000000000',
        reserve: '60000000000000000000000',
        slippages: [-1000, 30],
        preferences: [SupportedBridge.Near, SupportedBridge.Binance],
      },
      // arbitrum ethereum    USDC
      {
        origin: 42161,
        destination: 1,
        asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        maximum: '65000000000000000000000',
        reserve: '60000000000000000000000',
        slippages: [-1000, 30],
        preferences: [SupportedBridge.Near, SupportedBridge.Binance],
      },
      // arbitrum ethereum    USDT
      {
        origin: 42161,
        destination: 1,
        asset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        maximum: '55000000000000000000000',
        reserve: '50000000000000000000000',
        slippages: [-1000, 30],
        preferences: [SupportedBridge.Near, SupportedBridge.Binance],
      },
      // linea ethereum    USDC    10000000000000000000000 140
      {
        origin: 59144,
        destination: 1,
        asset: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
        maximum: '10000000000000000000000',
        slippages: [140],
        preferences: [SupportedBridge.Across],
      },
      // // unichain    ethereum    USDC    20000000000000000000000 30
      // {
      //   origin: 130,
      //   destination: 1,
      //   asset: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
      //   maximum: '20000000000000000000000',
      //   slippages: [30],
      //   preferences: [SupportedBridge.Across],
      // },
      // // zksync    ethereum    USDC    10000000000000000000000 30
      // {
      //   origin: 324,
      //   destination: 1,
      //   asset: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
      //   maximum: '10000000000000000000000',
      //   slippages: [30],
      //   preferences: [SupportedBridge.Across],
      // },
      // ink    ethereum    USDC    70000000000000000000000 20
      {
        origin: 57073,
        destination: 1,
        asset: '0xF1815bd50389c46847f0Bda824eC8da914045D14',
        maximum: '70000000000000000000000',
        reserve: '65000000000000000000000',
        slippages: [20],
        preferences: [SupportedBridge.Across],
      },
      // solana ethereum USDC
      {
        origin: 1399811149,
        destination: 1,
        asset: '0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61',
        maximum: '75000000000000000000000',
        reserve: '70000000000000000000000',
        slippages: [-1000],
        preferences: [SupportedBridge.Near],
      },
      // solana ethereum USDT
      {
        origin: 1399811149,
        destination: 1,
        asset: '0xce010e60afedb22717bd63192f54145a3f965a33bb82d2c7029eb2ce1e208264',
        maximum: '75000000000000000000000',
        reserve: '70000000000000000000000',
        slippages: [-1000],
        preferences: [SupportedBridge.Near],
      },
      // base ethereum    cbBTC    10000000000000000000000 140
      {
        origin: 8453,
        destination: 1,
        asset: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
        maximum: '65000000000000000000000',
        reserve: '60000000000000000000000',
        slippages: [-1000],
        preferences: [SupportedBridge.Near],
      },
    ],
  };
};

export async function loadConfiguration(): Promise<MarkConfiguration> {
  try {
    const environment = ((await fromEnv('ENVIRONMENT')) ?? 'local') as Environment;
    const url = environment === 'mainnet' ? EVERCLEAR_MAINNET_CONFIG_URL : EVERCLEAR_TESTNET_CONFIG_URL;
    const apiUrl = environment === 'mainnet' ? EVERCLEAR_MAINNET_API_URL : EVERCLEAR_TESTNET_API_URL;

    const hostedConfig = await getEverclearConfig(url);

    const ssmParameterName = (await fromEnv('MARK_CONFIG_SSM_PARAMETER')) ?? 'MARK_CONFIG_' + environment.toUpperCase();
    const configStr = await fromEnv(ssmParameterName, true);
    const configJson = existsSync('config.json')
      ? JSON.parse(readFileSync('config.json', 'utf8'))
      : JSON.parse(configStr ?? '{}');

    const supportedAssets =
      configJson.supportedAssets ?? parseSupportedAssets(await requireEnv('SUPPORTED_ASSET_SYMBOLS'));

    const { routes } = await loadRebalanceRoutes();

    // Filter routes to include those with assets specified in the config
    const filteredRoutes = routes.filter((route) => {
      const originChainConfig = hostedConfig?.chains?.[route.origin.toString()];
      if (!originChainConfig) {
        return false;
      }

      const assetConfig = Object.values(originChainConfig.assets ?? {}).find(
        (asset) => asset.address.toLowerCase() === route.asset.toLowerCase(),
      );

      if (!assetConfig) {
        return false;
      }

      const isSupported = supportedAssets.includes(assetConfig.symbol) || assetConfig.isNative;
      return isSupported;
    });

    const config: MarkConfiguration = {
      pushGatewayUrl: configJson.pushGatewayUrl ?? (await requireEnv('PUSH_GATEWAY_URL')),
      web3SignerUrl: configJson.web3SignerUrl ?? (await requireEnv('SIGNER_URL')),
      everclearApiUrl: configJson.everclearApiUrl ?? (await fromEnv('EVERCLEAR_API_URL')) ?? apiUrl,
      relayer: {
        url: configJson?.relayer?.url ?? (await fromEnv('RELAYER_URL')) ?? undefined,
        key: configJson?.relayer?.key ?? (await fromEnv('RELAYER_API_KEY')) ?? undefined,
      },
      binance: {
        apiKey: configJson.binance_api_key ?? (await fromEnv('BINANCE_API_KEY', true)) ?? undefined,
        apiSecret: configJson.binance_api_secret ?? (await fromEnv('BINANCE_API_SECRET', true)) ?? undefined,
      },
      kraken: {
        apiKey: configJson.binance_api_key ?? (await fromEnv('KRAKEN_API_KEY', true)) ?? undefined,
        apiSecret: configJson.binance_api_secret ?? (await fromEnv('KRAKEN_API_SECRET', true)) ?? undefined,
      },
      near: {
        jwtToken: configJson.near_jwt_token ?? (await fromEnv('NEAR_JWT_TOKEN', true)) ?? undefined,
      },
      redis: configJson.redis ?? {
        host: await requireEnv('REDIS_HOST'),
        port: parseInt(await requireEnv('REDIS_PORT')),
      },
      ownAddress: configJson.signerAddress ?? (await requireEnv('SIGNER_ADDRESS')),
      ownSolAddress: configJson.solSignerAddress ?? (await requireEnv('SOL_SIGNER_ADDRESS')),
      supportedSettlementDomains:
        configJson.supportedSettlementDomains ??
        parseSettlementDomains(await requireEnv('SUPPORTED_SETTLEMENT_DOMAINS')),
      supportedAssets,
      chains: await parseChainConfigurations(hostedConfig, supportedAssets, configJson),
      logLevel: ((await fromEnv('LOG_LEVEL')) ?? 'debug') as LogLevel,
      stage: ((await fromEnv('STAGE')) ?? 'development') as Stage,
      environment,
      hub: configJson.hub ?? parseHubConfigurations(hostedConfig, environment),
      routes: filteredRoutes,
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

  // Validate route configurations
  for (const route of config.routes) {
    if (route.slippages.length !== route.preferences.length) {
      throw new ConfigurationError(
        `Route ${route.origin}->${route.destination} for ${route.asset}: slippages array length (${route.slippages.length}) must match preferences array length (${route.preferences.length})`,
      );
    }
  }
}

export const requireEnv = async (name: string, checkSsm = false): Promise<string> => {
  const value = await fromEnv(name, checkSsm);
  if (!value) {
    throw new ConfigurationError(`Environment variable ${name} is required`);
  }
  return value;
};

export const fromEnv = async (name: string, checkSsm = false): Promise<string | undefined> => {
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

export const parseChainConfigurations = async (
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

    // Parse Zodiac configuration for this chain
    const zodiacRoleModuleAddress =
      configJson?.chains?.[chainId]?.zodiacRoleModuleAddress ??
      (await fromEnv(`CHAIN_${chainId}_ZODIAC_ROLE_MODULE_ADDRESS`));

    const zodiacRoleKey =
      configJson?.chains?.[chainId]?.zodiacRoleKey ?? (await fromEnv(`CHAIN_${chainId}_ZODIAC_ROLE_KEY`));

    const gnosisSafeAddress =
      configJson?.chains?.[chainId]?.gnosisSafeAddress ?? (await fromEnv(`CHAIN_${chainId}_GNOSIS_SAFE_ADDRESS`));

    const squadsAddress =
      configJson?.chains?.[chainId]?.squadsAddress ?? (await fromEnv(`CHAIN_${chainId}_SQUADS_ADDRESS`));

    const privateKey = configJson?.chains?.[chainId]?.privateKey ?? (await fromEnv(`CHAIN_${chainId}_PRIVATE_KEY`));

    chains[chainId] = {
      providers,
      assets: assets.filter((asset) => supportedAssets.includes(asset.symbol) || asset.isNative),
      invoiceAge: parseInt(invoiceAge),
      gasThreshold,
      deployments: {
        everclear,
        permit2,
        multicall3,
      },
      zodiacRoleModuleAddress,
      zodiacRoleKey,
      gnosisSafeAddress,
      squadsAddress,
      privateKey,
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

export enum AddressFormat {
  Hex,
  Base58,
}

export const getTokenAddressFromConfig = (
  tickerHash: string,
  domain: string,
  config: MarkConfiguration,
  format: AddressFormat = AddressFormat.Hex,
): string | undefined => {
  const asset = (config.chains[domain]?.assets ?? []).find(
    (a) => a.tickerHash.toLowerCase() === tickerHash.toLowerCase(),
  );
  if (!asset) {
    return undefined;
  }
  if (format === AddressFormat.Base58) {
    return hexToBase58(asset.address);
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
