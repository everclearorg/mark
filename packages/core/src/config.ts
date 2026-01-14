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
  RouteRebalancingConfig,
} from './types/config';
import yaml from 'js-yaml';
import fs from 'fs';
import { LogLevel } from './types/logging';
import { getSsmParameter } from './ssm';
import { existsSync, readFileSync } from 'fs';
import { hexToBase58 } from './solana';
import { isTvmChain } from './tron';
import { getRebalanceConfigFromS3 } from './s3';

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

/**
 * Parses a boolean value from environment variable string or config JSON
 * Handles string values like "true", "false", "1", "0" from environment variables
 * @param value - The value to parse (could be boolean, string, undefined)
 * @returns boolean value, or undefined if value is undefined
 */
export function parseBooleanValue(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === '') {
      return false;
    }
  }
  // For any other type, coerce to boolean
  return Boolean(value);
}

export const DEFAULT_GAS_THRESHOLD = '5000000000000000'; // 0.005 eth
export const DEFAULT_BALANCE_THRESHOLD = '0'; // 0
export const DEFAULT_INVOICE_AGE = '1';
export const EVERCLEAR_MAINNET_CONFIG_URL = 'https://raw.githubusercontent.com/connext/chaindata/main/everclear.json';
export const EVERCLEAR_MAINNET_STAGING_CONFIG_URL =
  'https://raw.githubusercontent.com/connext/chaindata/main/everclear.mainnet.staging.json';
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
  const routesLocalYaml = process.env.ROUTES_LOCAL_YAML;
  if (routesLocalYaml) {
    try {
      const yamlContent = await fs.promises.readFile(routesLocalYaml, 'utf8');
      const parsedYaml = yaml.load(yamlContent) as {
        routes: Array<{
          asset: string;
          origin: number;
          destination: number;
          maximum: string;
          slippagesDbps: number[];
          preferences: string[];
          reserve?: string;
        }>;
      };

      console.log(parsedYaml);

      const routes: RouteRebalancingConfig[] = parsedYaml.routes.reduce((acc, route) => {
        try {
          const preferences = route.preferences.map((pref) => {
            const [key, value] = pref.split('.');
            switch (key) {
              case 'SupportedBridge':
                const bridge = SupportedBridge[value as keyof typeof SupportedBridge];
                if (bridge === undefined) {
                  throw new Error(`Unsupported bridge preference: ${pref}`);
                }
                return bridge;
              default:
                throw new Error(`Unsupported preference key: ${key}`);
            }
          });

          acc.push({
            asset: route.asset,
            origin: route.origin,
            destination: route.destination,
            maximum: route.maximum,
            slippagesDbps: route.slippagesDbps,
            preferences,
            reserve: route.reserve,
          });
        } catch (error) {
          console.error(`Failed to process route: ${route.asset} ${route.origin}>${route.destination}`, error);
        }
        return acc;
      }, [] as RouteRebalancingConfig[]);

      return {
        routes,
        onDemandRoutes: [],
      };
    } catch (error) {
      console.error('Failed to load routes from YAML:', error);
    }
  }

  // Try to fetch from S3 first
  const s3Config = await getRebalanceConfigFromS3();
  if (s3Config) {
    return s3Config;
  }

  // Fallback to no rebalancing routes
  return {
    routes: [],
    onDemandRoutes: [],
  };
};

export async function loadConfiguration(): Promise<MarkConfiguration> {
  try {
    const environment = ((await fromEnv('ENVIRONMENT')) ?? 'local') as Environment;
    const stage = ((await fromEnv('STAGE')) ?? 'development') as Stage;

    // Determine config URL based on environment and stage
    let url: string;
    if (environment === 'mainnet') {
      url = stage === 'staging' ? EVERCLEAR_MAINNET_STAGING_CONFIG_URL : EVERCLEAR_MAINNET_CONFIG_URL;
    } else {
      url = EVERCLEAR_TESTNET_CONFIG_URL;
    }

    const apiUrl = environment === 'mainnet' ? EVERCLEAR_MAINNET_API_URL : EVERCLEAR_TESTNET_API_URL;

    const hostedConfig = await getEverclearConfig(url);

    const ssmParameterName = (await fromEnv('MARK_CONFIG_SSM_PARAMETER')) ?? 'MARK_CONFIG_' + environment.toUpperCase();
    const configStr = await fromEnv(ssmParameterName, true);
    const configJson = existsSync('config.json')
      ? JSON.parse(readFileSync('config.json', 'utf8'))
      : JSON.parse(configStr ?? '{}');

    // Extract web3_signer_private_key from config JSON and make it available as an environment variable
    if (configJson.web3_signer_private_key && !process.env.WEB3_SIGNER_PRIVATE_KEY) {
      process.env.WEB3_SIGNER_PRIVATE_KEY = configJson.web3_signer_private_key;
    }

    const supportedAssets =
      configJson.supportedAssets ?? parseSupportedAssets(await requireEnv('SUPPORTED_ASSET_SYMBOLS'));

    const { routes, onDemandRoutes } = await loadRebalanceRoutes();

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

    const filteredOnDemandRoutes = onDemandRoutes?.filter((route) => {
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
      fillServiceSignerUrl:
        configJson.fillServiceSignerUrl ?? (await fromEnv('FILL_SERVICE_SIGNER_URL', true)) ?? undefined,
      everclearApiUrl: configJson.everclearApiUrl ?? (await fromEnv('EVERCLEAR_API_URL')) ?? apiUrl,
      relayer: {
        url: configJson?.relayer?.url ?? (await fromEnv('RELAYER_URL')) ?? undefined,
        key: configJson?.relayer?.key ?? (await fromEnv('RELAYER_API_KEY')) ?? undefined,
      },
      binance: {
        apiKey: configJson.binance_api_key ?? (await fromEnv('BINANCE_API_KEY', true)) ?? undefined,
        apiSecret: configJson.binance_api_secret ?? (await fromEnv('BINANCE_API_SECRET', true)) ?? undefined,
      },
      coinbase: {
        apiKey: configJson.coinbase_api_key ?? (await fromEnv('COINBASE_API_KEY', true)) ?? undefined,
        apiSecret: configJson.coinbase_api_secret ?? (await fromEnv('COINBASE_API_SECRET', true)) ?? undefined,
      },
      kraken: {
        apiKey: configJson.kraken_api_key ?? (await fromEnv('KRAKEN_API_KEY', true)) ?? undefined,
        apiSecret: configJson.kraken_api_secret ?? (await fromEnv('KRAKEN_API_SECRET', true)) ?? undefined,
      },
      near: {
        jwtToken: configJson.near_jwt_token ?? (await fromEnv('NEAR_JWT_TOKEN', true)) ?? undefined,
      },
      stargate: {
        apiUrl: configJson.stargate?.apiUrl ?? (await fromEnv('STARGATE_API_URL', true)) ?? undefined,
      },
      tac: {
        tonRpcUrl: configJson.tac?.tonRpcUrl ?? (await fromEnv('TAC_TON_RPC_URL', true)) ?? undefined,
        network:
          configJson.tac?.network ??
          ((await fromEnv('TAC_NETWORK', true)) as 'mainnet' | 'testnet' | undefined) ??
          undefined,
      },
      ton: {
        mnemonic: configJson.ton?.mnemonic ?? (await fromEnv('TON_MNEMONIC', true)) ?? undefined,
        rpcUrl: configJson.ton?.rpcUrl ?? (await fromEnv('TON_RPC_URL', true)) ?? undefined,
        apiKey: configJson.ton?.apiKey ?? (await fromEnv('TON_API_KEY', true)) ?? undefined,
        assets: configJson.ton?.assets ?? undefined, // TON assets with jetton addresses
      },
      solana: {
        privateKey: configJson.solana?.privateKey ?? (await fromEnv('SOLANA_PRIVATE_KEY', true)) ?? undefined,
        rpcUrl: configJson.solana?.rpcUrl ?? (await fromEnv('SOLANA_RPC_URL', true)) ?? undefined,
      },
      tacRebalance: {
        enabled:
          parseBooleanValue(configJson.tacRebalance?.enabled) ??
          parseBooleanValue(await fromEnv('TAC_REBALANCE_ENABLED', true)) ??
          false,
        marketMaker: {
          address:
            configJson.tacRebalance?.marketMaker?.address ??
            (await fromEnv('TAC_REBALANCE_MARKET_MAKER_ADDRESS', true)) ??
            undefined,
          onDemandEnabled:
            parseBooleanValue(configJson.tacRebalance?.marketMaker?.onDemandEnabled) ??
            parseBooleanValue(await fromEnv('TAC_REBALANCE_MARKET_MAKER_ON_DEMAND_ENABLED', true)) ??
            false,
          thresholdEnabled:
            parseBooleanValue(configJson.tacRebalance?.marketMaker?.thresholdEnabled) ??
            parseBooleanValue(await fromEnv('TAC_REBALANCE_MARKET_MAKER_THRESHOLD_ENABLED', true)) ??
            false,
          threshold:
            configJson.tacRebalance?.marketMaker?.threshold ??
            (await fromEnv('TAC_REBALANCE_MARKET_MAKER_THRESHOLD', true)) ??
            undefined,
          targetBalance:
            configJson.tacRebalance?.marketMaker?.targetBalance ??
            (await fromEnv('TAC_REBALANCE_MARKET_MAKER_TARGET_BALANCE', true)) ??
            undefined,
        },
        fillService: {
          address:
            configJson.tacRebalance?.fillService?.address ??
            (await fromEnv('TAC_REBALANCE_FILL_SERVICE_ADDRESS', true)) ??
            undefined,
          senderAddress:
            configJson.tacRebalance?.fillService?.senderAddress ??
            (await fromEnv('TAC_REBALANCE_FILL_SERVICE_SENDER_ADDRESS', true)) ??
            undefined, // Filler's ETH address for sending from mainnet
          thresholdEnabled:
            parseBooleanValue(configJson.tacRebalance?.fillService?.thresholdEnabled) ??
            parseBooleanValue(await fromEnv('TAC_REBALANCE_FILL_SERVICE_THRESHOLD_ENABLED', true)) ??
            false,
          threshold:
            configJson.tacRebalance?.fillService?.threshold ??
            (await fromEnv('TAC_REBALANCE_FILL_SERVICE_THRESHOLD', true)) ??
            undefined,
          targetBalance:
            configJson.tacRebalance?.fillService?.targetBalance ??
            (await fromEnv('TAC_REBALANCE_FILL_SERVICE_TARGET_BALANCE', true)) ??
            undefined,
          allowCrossWalletRebalancing:
            parseBooleanValue(configJson.tacRebalance?.fillService?.allowCrossWalletRebalancing) ??
            parseBooleanValue(await fromEnv('TAC_REBALANCE_FILL_SERVICE_ALLOW_CROSS_WALLET', true)) ??
            false,
        },
        bridge: {
          slippageDbps:
            configJson.tacRebalance?.bridge?.slippageDbps ??
            parseInt((await fromEnv('TAC_REBALANCE_BRIDGE_SLIPPAGE_DBPS', true)) ?? '500', 10),
          minRebalanceAmount:
            configJson.tacRebalance?.bridge?.minRebalanceAmount ??
            (await fromEnv('TAC_REBALANCE_BRIDGE_MIN_REBALANCE_AMOUNT', true)) ??
            undefined,
          maxRebalanceAmount:
            configJson.tacRebalance?.bridge?.maxRebalanceAmount ??
            (await fromEnv('TAC_REBALANCE_BRIDGE_MAX_REBALANCE_AMOUNT', true)) ??
            undefined, // Max amount per operation (optional cap)
        },
      },
      methRebalance: {
        enabled:
          parseBooleanValue(configJson.methRebalance?.enabled) ??
          parseBooleanValue(await fromEnv('METH_REBALANCE_ENABLED', true)) ??
          false,
        marketMaker: {
          address:
            configJson.methRebalance?.marketMaker?.address ??
            (await fromEnv('METH_REBALANCE_MARKET_MAKER_ADDRESS', true)) ??
            undefined,
          onDemandEnabled:
            parseBooleanValue(configJson.methRebalance?.marketMaker?.onDemandEnabled) ??
            parseBooleanValue(await fromEnv('METH_REBALANCE_MARKET_MAKER_ON_DEMAND_ENABLED', true)) ??
            false,
          thresholdEnabled:
            parseBooleanValue(configJson.methRebalance?.marketMaker?.thresholdEnabled) ??
            parseBooleanValue(await fromEnv('METH_REBALANCE_MARKET_MAKER_THRESHOLD_ENABLED', true)) ??
            false,
          threshold:
            configJson.methRebalance?.marketMaker?.threshold ??
            (await fromEnv('METH_REBALANCE_MARKET_MAKER_THRESHOLD', true)) ??
            undefined,
          targetBalance:
            configJson.methRebalance?.marketMaker?.targetBalance ??
            (await fromEnv('METH_REBALANCE_MARKET_MAKER_TARGET_BALANCE', true)) ??
            undefined,
        },
        fillService: {
          address:
            configJson.methRebalance?.fillService?.address ??
            (await fromEnv('METH_REBALANCE_FILL_SERVICE_ADDRESS', true)) ??
            undefined,
          senderAddress:
            configJson.methRebalance?.fillService?.senderAddress ??
            (await fromEnv('METH_REBALANCE_FILL_SERVICE_SENDER_ADDRESS', true)) ??
            undefined, // Filler's ETH address for sending from mainnet
          thresholdEnabled:
            parseBooleanValue(configJson.methRebalance?.fillService?.thresholdEnabled) ??
            parseBooleanValue(await fromEnv('METH_REBALANCE_FILL_SERVICE_THRESHOLD_ENABLED', true)) ??
            false,
          threshold:
            configJson.methRebalance?.fillService?.threshold ??
            (await fromEnv('METH_REBALANCE_FILL_SERVICE_THRESHOLD', true)) ??
            undefined,
          targetBalance:
            configJson.methRebalance?.fillService?.targetBalance ??
            (await fromEnv('METH_REBALANCE_FILL_SERVICE_TARGET_BALANCE', true)) ??
            undefined,
          allowCrossWalletRebalancing:
            parseBooleanValue(configJson.methRebalance?.fillService?.allowCrossWalletRebalancing) ??
            parseBooleanValue(await fromEnv('METH_REBALANCE_FILL_SERVICE_ALLOW_CROSS_WALLET', true)) ??
            false,
        },
        bridge: {
          slippageDbps:
            configJson.methRebalance?.bridge?.slippageDbps ??
            parseInt((await fromEnv('METH_REBALANCE_BRIDGE_SLIPPAGE_DBPS', true)) ?? '500', 10),
          minRebalanceAmount:
            configJson.methRebalance?.bridge?.minRebalanceAmount ??
            (await fromEnv('METH_REBALANCE_BRIDGE_MIN_REBALANCE_AMOUNT', true)) ??
            undefined,
          maxRebalanceAmount:
            configJson.methRebalance?.bridge?.maxRebalanceAmount ??
            (await fromEnv('METH_REBALANCE_BRIDGE_MAX_REBALANCE_AMOUNT', true)) ??
            undefined, // Max amount per operation (optional cap)
        },
      },
      solanaRebalance: {
        enabled:
          parseBooleanValue(configJson.solanaRebalance?.enabled) ??
          parseBooleanValue(await fromEnv('SOLANA_REBALANCE_ENABLED', true)) ??
          true,
        ptUsdeThreshold:
          configJson.solanaRebalance?.ptUsdeThreshold ??
          (await fromEnv('SOLANA_REBALANCE_PTUSDE_THRESHOLD', true)) ??
          '100000000000', // 100 ptUSDe (9 decimals on Solana)
        ptUsdeTarget:
          configJson.solanaRebalance?.ptUsdeTarget ??
          (await fromEnv('SOLANA_REBALANCE_PTUSDE_TARGET', true)) ??
          '500000000000', // 500 ptUSDe (9 decimals on Solana)
        bridge: {
          slippageDbps:
            configJson.solanaRebalance?.bridge?.slippageDbps ??
            parseInt((await fromEnv('SOLANA_REBALANCE_BRIDGE_SLIPPAGE_DBPS', true)) ?? '50', 10), // 0.5% default
          minRebalanceAmount:
            configJson.solanaRebalance?.bridge?.minRebalanceAmount ??
            (await fromEnv('SOLANA_REBALANCE_BRIDGE_MIN_REBALANCE_AMOUNT', true)) ??
            '1000000', // 1 USDC minimum (6 decimals)
          maxRebalanceAmount:
            configJson.solanaRebalance?.bridge?.maxRebalanceAmount ??
            (await fromEnv('SOLANA_REBALANCE_BRIDGE_MAX_REBALANCE_AMOUNT', true)) ??
            '100000000', // 100 USDC max (6 decimals)
        },
      },
      redis: configJson.redis ?? {
        host: await requireEnv('REDIS_HOST'),
        port: parseInt(await requireEnv('REDIS_PORT')),
      },
      database: configJson.database ?? {
        connectionString: await requireEnv('DATABASE_URL'),
      },
      ownAddress: configJson.signerAddress ?? (await requireEnv('SIGNER_ADDRESS')),
      ownSolAddress: configJson.solSignerAddress ?? (await requireEnv('SOL_SIGNER_ADDRESS')),
      ownTonAddress: configJson.tonSignerAddress ?? (await fromEnv('TON_SIGNER_ADDRESS', true)) ?? undefined,
      supportedSettlementDomains:
        configJson.supportedSettlementDomains ??
        parseSettlementDomains(await requireEnv('SUPPORTED_SETTLEMENT_DOMAINS')),
      supportedAssets,
      chains: await parseChainConfigurations(hostedConfig, supportedAssets, configJson),
      logLevel: ((await fromEnv('LOG_LEVEL')) ?? 'debug') as LogLevel,
      stage,
      environment,
      hub: configJson.hub ?? parseHubConfigurations(hostedConfig, environment),
      routes: filteredRoutes,
      onDemandRoutes: filteredOnDemandRoutes,
      purchaseCacheTtlSeconds: +(
        configJson.purchaseCacheTtlSeconds ??
        (await fromEnv('PURCHASE_CACHE_TTL_SECONDS')) ??
        '5400' // default to 90min
      ),
      earmarkTTLMinutes: configJson.earmarkTTLMinutes ?? parseInt((await fromEnv('EARMARK_TTL_MINUTES')) || '1440'),
      regularRebalanceOpTTLMinutes:
        configJson.regularRebalanceOpTTLMinutes ??
        parseInt((await fromEnv('REGULAR_REBALANCE_OP_TTL_MINUTES')) || '1440'),
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
    if (route.slippagesDbps.length !== route.preferences.length) {
      throw new ConfigurationError(
        `Route ${route.origin}->${route.destination} for ${route.asset}: slippagesDbpsDbps array length (${route.slippagesDbps.length}) must match preferences array length (${route.preferences.length})`,
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

  // Parse supported settlement domains for validation
  const supportedSettlementDomains: number[] =
    configJson.supportedSettlementDomains ??
    (process.env.SUPPORTED_SETTLEMENT_DOMAINS
      ? process.env.SUPPORTED_SETTLEMENT_DOMAINS.split(',').map((d) => parseInt(d.trim(), 10))
      : []);

  const chains: Record<string, ChainConfiguration> = {};

  for (const chainId of chainIds) {
    const chainConfig = config?.chains?.[chainId];
    const localChainConfig = configJson.chains?.[chainId];

    // Skip if chain is not in either hosted or local config
    if (!chainConfig && !localChainConfig) {
      console.log(`Chain ${chainId} not found in Everclear config or local config, skipping`);
      continue;
    }

    const providers = (
      localChainConfig?.providers ??
      ((await fromEnv(`CHAIN_${chainId}_PROVIDERS`))
        ? parseProviders((await fromEnv(`CHAIN_${chainId}_PROVIDERS`))!)
        : undefined) ??
      []
    ).concat(chainConfig?.providers ?? []);

    // Load assets from hosted config if available, otherwise use local config assets
    const hostedAssets = chainConfig?.assets ? Object.values(chainConfig.assets) : [];
    const localAssets = (
      localChainConfig?.assets ? Object.values(localChainConfig.assets) : []
    ) as AssetConfiguration[];

    // Merge assets: prefer hosted config, fall back to local config for missing assets
    const mergedAssets = [...hostedAssets];
    for (const localAsset of localAssets) {
      const existsInHosted = hostedAssets.some(
        (a: AssetConfiguration) =>
          a.tickerHash?.toLowerCase() === localAsset.tickerHash?.toLowerCase() ||
          a.address?.toLowerCase() === localAsset.address?.toLowerCase(),
      );
      if (!existsInHosted) {
        mergedAssets.push(localAsset);
      }
    }

    const assets = await Promise.all(
      mergedAssets.map(async (a: AssetConfiguration) => {
        const jsonThreshold = (localAssets ?? []).find(
          (asset: { symbol: string; balanceThreshold?: string }) =>
            a.symbol.toLowerCase() === asset.symbol?.toLowerCase(),
        )?.balanceThreshold;
        const envThreshold = await fromEnv(`${a.symbol.toUpperCase()}_${chainId}_THRESHOLD`);
        return {
          ...a,
          balanceThreshold: jsonThreshold ?? envThreshold ?? DEFAULT_BALANCE_THRESHOLD,
        };
      }),
    );

    // Get the invoice age
    // First, check if there is a configured invoice age in local config or env
    const invoiceAge =
      localChainConfig?.invoiceAge?.toString() ??
      (await fromEnv(`CHAIN_${chainId}_INVOICE_AGE`)) ??
      (await fromEnv('INVOICE_AGE')) ??
      DEFAULT_INVOICE_AGE;
    const gasThreshold =
      configJson?.chains?.[chainId]?.gasThreshold ??
      (await fromEnv(`CHAIN_${chainId}_GAS_THRESHOLD`)) ??
      (await fromEnv(`GAS_THRESHOLD`)) ??
      DEFAULT_GAS_THRESHOLD;

    // Extract Everclear spoke address from the config (prefer hosted, fall back to local)
    const everclear = chainConfig?.deployments?.everclear ?? localChainConfig?.deployments?.everclear;

    // Check if this chain is a settlement domain (requires spoke address)
    const isSettlementDomain = supportedSettlementDomains.includes(parseInt(chainId, 10));

    if (!everclear) {
      if (isSettlementDomain) {
        throw new ConfigurationError(
          `No spoke address found for chain ${chainId}. Make sure it's defined in the config under chains.${chainId}.deployments.everclear`,
        );
      }
      // Skip non-settlement chains without spoke addresses - they may only be used for RPC access
      console.log(`Chain ${chainId} has no spoke address and is not a settlement domain, skipping`);
      continue;
    }

    // Get chain-specific contract addresses or use config values if provided (prefer hosted, fall back to local)
    const permit2 =
      chainConfig?.deployments?.permit2 ||
      localChainConfig?.deployments?.permit2 ||
      UTILITY_CONTRACTS_OVERRIDE[chainId]?.permit2 ||
      UTILITY_CONTRACTS_DEFAULT.permit2;

    const multicall3 =
      chainConfig?.deployments?.multicall3 ||
      localChainConfig?.deployments?.multicall3 ||
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
      ...(isTvmChain(chainId) && {
        bandwidthThreshold: configJson?.chains?.[chainId]?.bandwidthThreshold,
        energyThreshold: configJson?.chains?.[chainId]?.energyThreshold,
      }),
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
