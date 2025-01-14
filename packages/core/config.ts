import { MarkConfiguration, ChainConfiguration, AssetConfiguration } from './types';

export class ConfigurationError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function loadConfiguration(): MarkConfiguration {
  try {
    const config: MarkConfiguration = {
      invoiceAge: parseInt(requireEnv('INVOICE_AGE'), 10),
      signer: requireEnv('SIGNER_ADDRESS'),
      everclear: {
        url: requireEnv('EVERCLEAR_API_URL'),
        key: process.env.EVERCLEAR_API_KEY,
      },
      relayer: process.env.RELAYER_URL
        ? {
            url: process.env.RELAYER_URL,
            key: requireEnv('RELAYER_API_KEY'),
          }
        : undefined,
      supportedSettlementDomains: parseSettlementDomains(requireEnv('SUPPORTED_SETTLEMENT_DOMAINS')),
      chains: parseChainConfigurations(),
    };

    validateConfiguration(config);
    return config;
  } catch (error) {
    throw new ConfigurationError('Failed to load configuration', { error: (error as Error).message });
  }
}

function validateConfiguration(config: MarkConfiguration): void {
  if (!config.invoiceAge || config.invoiceAge <= 0) {
    throw new ConfigurationError('Invalid invoice age');
  }

  if (!config.signer) {
    throw new ConfigurationError('Signer address is required');
  }

  if (!config.everclear.url) {
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

function parseChainConfigurations(): Record<string, ChainConfiguration> {
  const chainIds = requireEnv('CHAIN_IDS')
    .split(',')
    .map((id) => id.trim());
  const chains: Record<string, ChainConfiguration> = {};

  for (const chainId of chainIds) {
    chains[chainId] = {
      providers: parseProviders(requireEnv(`CHAIN_${chainId}_PROVIDERS`)),
      assets: parseAssets(requireEnv(`CHAIN_${chainId}_ASSETS`)),
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
