import { MarkConfiguration } from './types';

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
      chain: {
        chainId: parseInt(process.env.CHAIN_ID || '', 10),
        providers: parseProviders(process.env.RPC_PROVIDERS || ''),
      },
      everclear: {
        apiUrl: requireEnv('EVERCLEAR_API_URL'),
        apiKey: requireEnv('EVERCLEAR_API_KEY'),
      },
      web3Signer: {
        url: requireEnv('WEB3_SIGNER_URL'),
        publicKey: requireEnv('WEB3_SIGNER_PUBLIC_KEY'),
      },
    };

    validateConfiguration(config);
    return config;
  } catch (error) {
    throw new ConfigurationError('Failed to load configuration', { error: (error as Error).message });
  }
}

function validateConfiguration(config: MarkConfiguration): void {
  if (!config.chain.chainId) {
    throw new ConfigurationError('Chain ID is required');
  }

  if (!config.chain.providers || config.chain.providers.length === 0) {
    throw new ConfigurationError('At least one RPC provider is required');
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigurationError(`Environment variable ${name} is required`);
  }
  return value;
}

function parseProviders(providers: string): { url: string; weight?: number }[] {
  if (!providers) return [];
  return providers.split(',').map((provider) => {
    const [url, weight] = provider.split('|');
    return {
      url: url.trim(),
      weight: weight ? parseInt(weight.trim(), 10) : undefined,
    };
  });
}
