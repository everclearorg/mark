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
  PostBridgeActionConfig,
  LogLevel,
  TokenRebalanceConfig,
} from './types';
import yaml from 'js-yaml';
import fs, { existsSync, readFileSync } from 'fs';
import { getSsmParameter, SsmParameterReadError } from './ssm';
import { hexToBase58 } from './solana';
import { isTvmChain } from './tron';
import { getRebalanceConfigFromS3, getThresholdRebalanceConfigFromS3 } from './s3';
import { stitchConfig, loadManifest, setValueByPath } from './shard';

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
          postBridgeActions?: PostBridgeActionConfig[];
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
            postBridgeActions: route.postBridgeActions,
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

interface TokenRebalanceDefaults {
  mmThreshold?: string;
  mmTarget?: string;
  fsThreshold?: string;
  fsTarget?: string;
  slippageDbps?: number;
  minAmount?: string;
  maxAmount?: string;
}

/**
 * Convert empty strings to undefined so they don't short-circuit ?? fallback chains.
 * Fee-admin S3 export should already convert empty strings to null, but this
 * provides a defensive layer in mark to prevent empty string overrides.
 */
const nonEmpty = (value: string | undefined | null): string | undefined =>
  value === '' || value === null ? undefined : value;

async function loadTokenRebalanceConfig(
  s3Config: TokenRebalanceConfig | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configJson: Record<string, any>,
  configKey: string,
  envPrefix: string,
  defaults?: TokenRebalanceDefaults,
): Promise<TokenRebalanceConfig> {
  // Priority: S3 (fee-admin) > configJson (SSM) > env vars > defaults
  const s3 = s3Config;
  const cfg = configJson[configKey];
  return {
    enabled:
      s3?.enabled ??
      parseBooleanValue(cfg?.enabled) ??
      parseBooleanValue(await fromEnv(`${envPrefix}_ENABLED`, true)) ??
      false,
    marketMaker: {
      address:
        nonEmpty(s3?.marketMaker?.address) ??
        cfg?.marketMaker?.address ??
        (await fromEnv(`${envPrefix}_MARKET_MAKER_ADDRESS`, true)) ??
        undefined,
      onDemandEnabled:
        s3?.marketMaker?.onDemandEnabled ??
        parseBooleanValue(cfg?.marketMaker?.onDemandEnabled) ??
        parseBooleanValue(await fromEnv(`${envPrefix}_MARKET_MAKER_ON_DEMAND_ENABLED`, true)) ??
        false,
      thresholdEnabled:
        s3?.marketMaker?.thresholdEnabled ??
        parseBooleanValue(cfg?.marketMaker?.thresholdEnabled) ??
        parseBooleanValue(await fromEnv(`${envPrefix}_MARKET_MAKER_THRESHOLD_ENABLED`, true)) ??
        false,
      threshold:
        nonEmpty(s3?.marketMaker?.threshold) ??
        cfg?.marketMaker?.threshold ??
        (await fromEnv(`${envPrefix}_MARKET_MAKER_THRESHOLD`, true)) ??
        defaults?.mmThreshold ??
        undefined,
      targetBalance:
        nonEmpty(s3?.marketMaker?.targetBalance) ??
        cfg?.marketMaker?.targetBalance ??
        (await fromEnv(`${envPrefix}_MARKET_MAKER_TARGET_BALANCE`, true)) ??
        defaults?.mmTarget ??
        undefined,
    },
    fillService: {
      address:
        nonEmpty(s3?.fillService?.address) ??
        cfg?.fillService?.address ??
        (await fromEnv(`${envPrefix}_FILL_SERVICE_ADDRESS`, true)) ??
        undefined,
      senderAddress:
        nonEmpty(s3?.fillService?.senderAddress) ??
        cfg?.fillService?.senderAddress ??
        (await fromEnv(`${envPrefix}_FILL_SERVICE_SENDER_ADDRESS`, true)) ??
        undefined,
      thresholdEnabled:
        s3?.fillService?.thresholdEnabled ??
        parseBooleanValue(cfg?.fillService?.thresholdEnabled) ??
        parseBooleanValue(await fromEnv(`${envPrefix}_FILL_SERVICE_THRESHOLD_ENABLED`, true)) ??
        false,
      threshold:
        nonEmpty(s3?.fillService?.threshold) ??
        cfg?.fillService?.threshold ??
        (await fromEnv(`${envPrefix}_FILL_SERVICE_THRESHOLD`, true)) ??
        defaults?.fsThreshold ??
        undefined,
      targetBalance:
        nonEmpty(s3?.fillService?.targetBalance) ??
        cfg?.fillService?.targetBalance ??
        (await fromEnv(`${envPrefix}_FILL_SERVICE_TARGET_BALANCE`, true)) ??
        defaults?.fsTarget ??
        undefined,
      allowCrossWalletRebalancing:
        s3?.fillService?.allowCrossWalletRebalancing ??
        parseBooleanValue(cfg?.fillService?.allowCrossWalletRebalancing) ??
        parseBooleanValue(await fromEnv(`${envPrefix}_FILL_SERVICE_ALLOW_CROSS_WALLET`, true)) ??
        false,
    },
    bridge: {
      slippageDbps:
        s3?.bridge?.slippageDbps ??
        cfg?.bridge?.slippageDbps ??
        parseInt(
          (await fromEnv(`${envPrefix}_BRIDGE_SLIPPAGE_DBPS`, true)) ?? String(defaults?.slippageDbps ?? 500),
          10,
        ),
      minRebalanceAmount:
        nonEmpty(s3?.bridge?.minRebalanceAmount) ??
        cfg?.bridge?.minRebalanceAmount ??
        (await fromEnv(`${envPrefix}_BRIDGE_MIN_REBALANCE_AMOUNT`, true)) ??
        defaults?.minAmount ??
        '100000000', // Safe default: 100 units (6-decimal tokens like USDC/USDT)
      maxRebalanceAmount:
        nonEmpty(s3?.bridge?.maxRebalanceAmount) ??
        cfg?.bridge?.maxRebalanceAmount ??
        (await fromEnv(`${envPrefix}_BRIDGE_MAX_REBALANCE_AMOUNT`, true)) ??
        defaults?.maxAmount ??
        '100000000', // Safe default: 100 units (6-decimal tokens) — prevents unlimited bridging
    },
  };
}

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
    let configJson = existsSync('config.json')
      ? JSON.parse(readFileSync('config.json', 'utf8'))
      : JSON.parse(configStr ?? '{}');

    // ============ KEY SHARDING: Reconstruct sharded fields ============
    // Load manifest from: embedded in config, SSM parameter, or local file
    const manifestStr = await fromEnv('SHARD_MANIFEST', true);
    const localManifestPath = existsSync('shard-manifest.json') ? 'shard-manifest.json' : undefined;
    const manifest = loadManifest(configJson, manifestStr, localManifestPath);

    // If manifest exists with sharded fields, load Share 1 values from SSM, fetch GCP shares and reconstruct
    if (manifest && manifest.shardedFields && manifest.shardedFields.length > 0) {
      console.log(`🔐 Loading Share 1 values from SSM for ${manifest.shardedFields.length} sharded field(s)...`);

      // Load Share 1 values from AWS SSM and place them into config JSON
      const parameterPrefix = manifest.awsConfig?.parameterPrefix ?? '/mark/config';

      for (const fieldConfig of manifest.shardedFields) {
        // Determine SSM parameter name
        let ssmParamName: string;
        if (fieldConfig.awsParamName) {
          ssmParamName = fieldConfig.awsParamName;
        } else {
          // Derive from the path: convert dots to underscores and append _share1
          const safePath = fieldConfig.path.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
          ssmParamName = `${parameterPrefix}/${safePath}_share1`;
        }

        try {
          // Fetch Share 1 from SSM
          const share1Value = await getSsmParameter(ssmParamName);

          if (share1Value === undefined || share1Value === null) {
            const isRequired = fieldConfig.required !== false;
            if (isRequired) {
              throw new ConfigurationError(
                `Failed to load Share 1 from SSM parameter '${ssmParamName}' for field '${fieldConfig.path}'`,
                { ssmParamName, path: fieldConfig.path },
              );
            } else {
              console.warn(
                `  [shard] ⚠️  Skipping optional field '${fieldConfig.path}': Share 1 not found at '${ssmParamName}'`,
              );
              continue;
            }
          }

          // Place Share 1 into config JSON at the field's path
          setValueByPath(configJson, fieldConfig.path, share1Value);
          console.log(`  [shard] ✓ Loaded Share 1 for '${fieldConfig.path}' from '${ssmParamName}'`);
        } catch (error) {
          const isRequired = fieldConfig.required !== false;
          if (isRequired) {
            console.error(`  [shard] ❌ Failed to load Share 1 for '${fieldConfig.path}':`, (error as Error).message);
            throw error;
          } else {
            console.warn(`  [shard] ⚠️  Skipping optional field '${fieldConfig.path}': ${(error as Error).message}`);
          }
        }
      }

      // Now reconstruct the original values using Share 1 (from config JSON) and Share 2 (from GCP)
      console.log(`🔐 Reconstructing ${manifest.shardedFields.length} sharded field(s)...`);
      try {
        configJson = await stitchConfig(configJson, manifest, {
          logger: {
            debug: (msg) => console.log(`  [shard] ${msg}`),
            info: (msg) => console.log(`  [shard] ${msg}`),
            warn: (msg) => console.warn(`  [shard] ⚠️ ${msg}`),
            error: (msg) => console.error(`  [shard] ❌ ${msg}`),
          },
        });
        console.log('✓ Key sharding reconstruction complete');
      } catch (error) {
        console.error('❌ Key sharding reconstruction failed:', (error as Error).message);
        throw new ConfigurationError(`Failed to reconstruct sharded configuration: ${(error as Error).message}`, {
          error: JSON.stringify(error),
        });
      }
    }
    // ============ END KEY SHARDING ============

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

      return supportedAssets.includes(assetConfig.symbol) || assetConfig.isNative;
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

      return supportedAssets.includes(assetConfig.symbol) || assetConfig.isNative;
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
      // Fetch threshold configs from S3 (fee-admin) - highest priority source
      // Falls back gracefully to SSM/env if S3 is unavailable or empty
      ...(await (async () => {
        const thresholdS3 = await getThresholdRebalanceConfigFromS3();
        const solanaS3 = thresholdS3?.solanaPtusdeRebalance;
        return {
          tacRebalance: await loadTokenRebalanceConfig(
            thresholdS3?.tacRebalance,
            configJson,
            'tacRebalance',
            'TAC_REBALANCE',
          ),
          methRebalance: await loadTokenRebalanceConfig(
            thresholdS3?.methRebalance,
            configJson,
            'methRebalance',
            'METH_REBALANCE',
          ),
          aManUsdeRebalance: await loadTokenRebalanceConfig(
            thresholdS3?.aManUsdeRebalance,
            configJson,
            'aManUsdeRebalance',
            'AMANUSDE_REBALANCE',
          ),
          aMansyrupUsdtRebalance: await loadTokenRebalanceConfig(
            thresholdS3?.aMansyrupUsdtRebalance,
            configJson,
            'aMansyrupUsdtRebalance',
            'AMANSYRUPUSDT_REBALANCE',
          ),
          solanaPtusdeRebalance: {
            enabled:
              solanaS3?.enabled ??
              parseBooleanValue(configJson.solanaPtusdeRebalance?.enabled) ??
              parseBooleanValue(await fromEnv('SOLANA_PTUSDE_REBALANCE_ENABLED', true)) ??
              false,
            ptUsdeThreshold:
              nonEmpty(solanaS3?.ptUsdeThreshold) ??
              configJson.solanaPtusdeRebalance?.ptUsdeThreshold ??
              (await fromEnv('SOLANA_PTUSDE_REBALANCE_THRESHOLD', true)) ??
              '100000000000', // 100 ptUSDe (9 decimals on Solana)
            ptUsdeTarget:
              nonEmpty(solanaS3?.ptUsdeTarget) ??
              configJson.solanaPtusdeRebalance?.ptUsdeTarget ??
              (await fromEnv('SOLANA_PTUSDE_REBALANCE_TARGET', true)) ??
              '500000000000', // 500 ptUSDe (9 decimals on Solana)
            bridge: {
              slippageDbps:
                solanaS3?.bridge?.slippageDbps ??
                configJson.solanaPtusdeRebalance?.bridge?.slippageDbps ??
                parseInt((await fromEnv('SOLANA_PTUSDE_REBALANCE_BRIDGE_SLIPPAGE_DBPS', true)) ?? '50', 10), // 0.5% default
              minRebalanceAmount:
                nonEmpty(solanaS3?.bridge?.minRebalanceAmount) ??
                configJson.solanaPtusdeRebalance?.bridge?.minRebalanceAmount ??
                (await fromEnv('SOLANA_PTUSDE_REBALANCE_BRIDGE_MIN_REBALANCE_AMOUNT', true)) ??
                '1000000', // 1 USDC minimum (6 decimals)
              maxRebalanceAmount:
                nonEmpty(solanaS3?.bridge?.maxRebalanceAmount) ??
                configJson.solanaPtusdeRebalance?.bridge?.maxRebalanceAmount ??
                (await fromEnv('SOLANA_PTUSDE_REBALANCE_BRIDGE_MAX_REBALANCE_AMOUNT', true)) ??
                '100000000', // 100 USDC max (6 decimals)
            },
          },
        };
      })()),
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
      goldskyWebhookSecret: configJson.goldskyWebhookSecret ?? (await fromEnv('GOLDSKY_WEBHOOK_SECRET')) ?? undefined,
    };

    validateConfiguration(config);
    logThresholdRebalancerConfigs(config);
    return config;
  } catch (_error: unknown) {
    const error = _error as Error;
    throw new ConfigurationError('Failed to load configuration: ' + error.message, { error: JSON.stringify(error) });
  }
}

/**
 * Log loaded threshold rebalancer configs at startup.
 * Only logs non-secret operational parameters: addresses, thresholds,
 * targets, slippage, and amounts. No private keys, mnemonics, or API keys.
 */
function logThresholdRebalancerConfigs(config: MarkConfiguration): void {
  const logTokenRebalancer = (name: string, cfg: TokenRebalanceConfig) => {
    console.log(`[ThresholdConfig] ${name}:`, {
      enabled: cfg.enabled,
      marketMaker: {
        address: cfg.marketMaker.address,
        onDemandEnabled: cfg.marketMaker.onDemandEnabled,
        thresholdEnabled: cfg.marketMaker.thresholdEnabled,
        threshold: cfg.marketMaker.threshold,
        targetBalance: cfg.marketMaker.targetBalance,
      },
      fillService: {
        address: cfg.fillService.address,
        senderAddress: cfg.fillService.senderAddress,
        thresholdEnabled: cfg.fillService.thresholdEnabled,
        threshold: cfg.fillService.threshold,
        targetBalance: cfg.fillService.targetBalance,
        allowCrossWalletRebalancing: cfg.fillService.allowCrossWalletRebalancing,
      },
      bridge: {
        slippageDbps: cfg.bridge.slippageDbps,
        minRebalanceAmount: cfg.bridge.minRebalanceAmount,
        maxRebalanceAmount: cfg.bridge.maxRebalanceAmount,
      },
    });
  };

  if (config.tacRebalance) logTokenRebalancer('tacRebalance', config.tacRebalance);
  if (config.methRebalance) logTokenRebalancer('methRebalance', config.methRebalance);
  if (config.aManUsdeRebalance) logTokenRebalancer('aManUsdeRebalance', config.aManUsdeRebalance);
  if (config.aMansyrupUsdtRebalance) logTokenRebalancer('aMansyrupUsdtRebalance', config.aMansyrupUsdtRebalance);

  if (config.solanaPtusdeRebalance) {
    console.log('[ThresholdConfig] solanaPtusdeRebalance:', {
      enabled: config.solanaPtusdeRebalance.enabled,
      ptUsdeThreshold: config.solanaPtusdeRebalance.ptUsdeThreshold,
      ptUsdeTarget: config.solanaPtusdeRebalance.ptUsdeTarget,
      bridge: {
        slippageDbps: config.solanaPtusdeRebalance.bridge.slippageDbps,
        minRebalanceAmount: config.solanaPtusdeRebalance.bridge.minRebalanceAmount,
        maxRebalanceAmount: config.solanaPtusdeRebalance.bridge.maxRebalanceAmount,
      },
    });
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
    try {
      value = await getSsmParameter(name);
    } catch (error) {
      if (error instanceof SsmParameterReadError && process.env[name] !== undefined) {
        return process.env[name];
      }
      throw error;
    }
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

      // Reduce log noise
      // console.log(`Chain ${chainId} has no spoke address and is not a settlement domain, skipping`);
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

export const getIsNativeFromConfig = (ticker: string, domain: string, config: MarkConfiguration): boolean => {
  const asset = (config.chains[domain]?.assets ?? []).find((a) => a.tickerHash.toLowerCase() === ticker.toLowerCase());
  return asset?.isNative ?? false;
};
