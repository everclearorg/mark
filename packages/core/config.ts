import { existsSync, readFileSync } from 'fs';
import { MarkConfiguration, ChainConfiguration, AssetConfiguration } from './types';

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigurationError(`Environment variable ${name} is required`);
  }
  return value;
}

export const loadConfiguration = (): MarkConfiguration => {
  let configJson: Record<string, any> = {};

  // Try loading from config file first
  try {
    const path = process.env.MARK_CONFIG_FILE ?? 'config.json';
    if (existsSync(path)) {
      const json = readFileSync(path, { encoding: 'utf-8' });
      configJson = JSON.parse(json);
    }
  } catch (e) {
    console.info('No config file found, using env vars');
  }

  const config: MarkConfiguration = {
    logLevel: process.env.LOG_LEVEL || configJson.logLevel || 'info',
    stage: process.env.STAGE || configJson.stage || 'testnet',
    environment: process.env.ENVIRONMENT || configJson.environment || 'production',
    invoiceAge: parseInt(process.env.INVOICE_AGE || configJson.invoiceAge || '3600', 10),
    signer: process.env.MARK_SIGNER || configJson.signer || requireEnv('MARK_SIGNER'),
    everclear: {
      url: process.env.EVERCLEAR_URL || configJson.everclear?.url || requireEnv('EVERCLEAR_URL'),
      key: process.env.EVERCLEAR_KEY || configJson.everclear?.key,
    },
    supportedSettlementDomains: process.env.SUPPORTED_SETTLEMENT_DOMAINS
      ? process.env.SUPPORTED_SETTLEMENT_DOMAINS.split(',').map(Number)
      : configJson.supportedSettlementDomains || [],
    chains: process.env.CHAINS ? JSON.parse(process.env.CHAINS) : configJson.chains || parseChainConfigurations(),
  };

  validateConfiguration(config);
  return config;
};

function parseChainConfigurations(): Record<string, ChainConfiguration> {
  const chainIds = requireEnv('CHAIN_IDS')
    .split(',')
    .map((id) => id.trim());
  const chains: Record<string, ChainConfiguration> = {};

  for (const chainId of chainIds) {
    chains[chainId] = {
      providers: requireEnv(`CHAIN_${chainId}_PROVIDERS`)
        .split(',')
        .map((p) => p.trim()),
      assets: parseAssets(requireEnv(`CHAIN_${chainId}_ASSETS`)),
    };
  }

  return chains;
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

const validateConfiguration = (config: MarkConfiguration): void => {
  if (!config.signer) {
    throw new ConfigurationError('Signer is required');
  }

  if (!config.everclear.url) {
    throw new ConfigurationError('Everclear URL is required');
  }

  if (Object.keys(config.chains).length === 0) {
    throw new ConfigurationError('At least one chain configuration is required');
  }

  if (config.supportedSettlementDomains.length === 0) {
    throw new ConfigurationError('At least one settlement domain is required');
  }
};
