import { MarkConfiguration } from './types';
import { MarkError } from './errors';

export class ConfigurationError extends MarkError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('ConfigurationError', message, context);
  }
}

export const loadConfig = (): MarkConfiguration => {
  try {
    // Try loading from environment variables first
    if (process.env.MARK_CONFIG) {
      return JSON.parse(process.env.MARK_CONFIG);
    }

    // Fall back to local config file
    const configPath = process.env.MARK_CONFIG_PATH || './config.json';
    return require(configPath);
  } catch (error) {
    throw new ConfigurationError('Failed to load configuration', { error: error.message });
  }
};

export const validateConfig = (config: MarkConfiguration): void => {
  // Basic validation
  if (!config.signer) {
    throw new ConfigurationError('Missing signer configuration');
  }

  if (!config.everclear?.url) {
    throw new ConfigurationError('Missing Everclear URL');
  }

  if (!config.chains || Object.keys(config.chains).length === 0) {
    throw new ConfigurationError('No chains configured');
  }

  // Validate each chain has required fields
  Object.entries(config.chains).forEach(([chainId, chain]) => {
    if (!chain.providers || chain.providers.length === 0) {
      throw new ConfigurationError('Chain missing providers', { chainId });
    }
  });
};
