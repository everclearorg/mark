import { Logger } from '@mark/logger';
import {
  MarkConfiguration,
  TokenRebalanceConfig,
  TOKEN_REBALANCER_KEYS,
  TokenRebalancerKey,
  SolanaRebalanceConfig,
} from '@mark/core';

/**
 * Validates a single token rebalance configuration.
 * Helper function used by validateTokenRebalanceConfig.
 */
function validateSingleTokenRebalanceConfig(
  tokenConfig: TokenRebalanceConfig | undefined,
  configName: TokenRebalancerKey,
  config: MarkConfiguration,
  logger: Logger,
): void {
  // Skip validation if rebalancing is disabled
  if (!tokenConfig?.enabled) {
    logger.debug(`${configName} disabled, skipping config validation`);
    return;
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate Market Maker config
  const mm = tokenConfig.marketMaker;
  if (mm.thresholdEnabled || mm.onDemandEnabled) {
    if (!mm?.address) {
      errors.push(`${configName}.marketMaker.address is required when ${configName} is enabled`);
    }

    if (mm?.thresholdEnabled) {
      if (!mm.threshold) {
        errors.push(`${configName}.marketMaker.threshold is required when thresholdEnabled=true`);
      }
      if (!mm.targetBalance) {
        errors.push(`${configName}.marketMaker.targetBalance is required when thresholdEnabled=true`);
      }
    }
  }

  // Validate Fill Service config
  const fs = tokenConfig.fillService;
  if (fs?.thresholdEnabled) {
    if (!fs?.address) {
      errors.push(`${configName}.fillService.address is required when ${configName} is enabled`);
    }

    if (!fs.threshold) {
      errors.push(`${configName}.fillService.threshold is required when thresholdEnabled=true`);
    }
    if (!fs.targetBalance) {
      errors.push(`${configName}.fillService.targetBalance is required when thresholdEnabled=true`);
    }
  }

  // Validate Bridge config
  const bridge = tokenConfig.bridge;
  if (!bridge?.minRebalanceAmount) {
    errors.push(`${configName}.bridge.minRebalanceAmount is required`);
  }

  // Validate TON config (required for TAC/METH bridging)
  if (configName === 'tacRebalance') {
    if (!config.ownTonAddress) {
      errors.push('ownTonAddress (TON_SIGNER_ADDRESS) is required for TAC rebalancing');
    }

    if (!config.ton?.mnemonic) {
      errors.push('ton.mnemonic (TON_MNEMONIC) is required for TAC Leg 2 signing');
    }
  }

  // Warnings for common misconfigurations
  if (mm?.address && config.ownAddress && mm.address.toLowerCase() !== config.ownAddress.toLowerCase()) {
    warnings.push(
      `${configName} MM address (${mm.address}) differs from ownAddress (${config.ownAddress}). ` +
        'Funds sent to MM may not be usable for intent filling by this Mark instance.',
    );
  }

  // Log warnings
  for (const warning of warnings) {
    logger.warn(`${configName} config warning`, { warning });
  }

  // Throw if errors
  if (errors.length > 0) {
    const errorMessage = `${configName} config validation failed:\n  - ${errors.join('\n  - ')}`;
    logger.error(`${configName} config validation failed`, { errors });
    throw new Error(errorMessage);
  }

  logger.info(`${configName} config validated successfully`, {
    mmAddress: mm?.address,
    fsAddress: fs?.address,
    mmOnDemand: mm?.onDemandEnabled,
    mmThreshold: mm?.thresholdEnabled,
    fsThreshold: fs?.thresholdEnabled,
    minRebalanceAmount: bridge?.minRebalanceAmount,
  });
}

/**
 * Validates Solana ptUSDe rebalance configuration.
 * Solana uses a different config shape (SolanaRebalanceConfig) than the EVM token rebalancers.
 */
function validateSolanaRebalanceConfig(
  solanaConfig: SolanaRebalanceConfig | undefined,
  config: MarkConfiguration,
  logger: Logger,
): void {
  if (!solanaConfig?.enabled) {
    logger.debug('solanaPtusdeRebalance disabled, skipping config validation');
    return;
  }

  const errors: string[] = [];

  if (!solanaConfig.ptUsdeThreshold) {
    errors.push('solanaPtusdeRebalance.ptUsdeThreshold is required when enabled');
  }
  if (!solanaConfig.ptUsdeTarget) {
    errors.push('solanaPtusdeRebalance.ptUsdeTarget is required when enabled');
  }
  if (!solanaConfig.bridge?.minRebalanceAmount) {
    errors.push('solanaPtusdeRebalance.bridge.minRebalanceAmount is required');
  }
  if (!config.solana?.privateKey) {
    errors.push('solana.privateKey (SOLANA_PRIVATE_KEY) is required for Solana rebalancing');
  }

  if (errors.length > 0) {
    const errorMessage = `solanaPtusdeRebalance config validation failed:\n  - ${errors.join('\n  - ')}`;
    logger.error('solanaPtusdeRebalance config validation failed', { errors });
    throw new Error(errorMessage);
  }

  logger.info('solanaPtusdeRebalance config validated successfully', {
    ptUsdeThreshold: solanaConfig.ptUsdeThreshold,
    ptUsdeTarget: solanaConfig.ptUsdeTarget,
    minRebalanceAmount: solanaConfig.bridge.minRebalanceAmount,
    maxRebalanceAmount: solanaConfig.bridge.maxRebalanceAmount,
  });
}

/**
 * Validates token rebalance configuration for production readiness.
 * Throws if required fields are missing when token rebalancing is enabled.
 */
export function validateTokenRebalanceConfig(config: MarkConfiguration, logger: Logger): void {
  for (const key of TOKEN_REBALANCER_KEYS) {
    validateSingleTokenRebalanceConfig(config[key], key, config, logger);
  }
  validateSolanaRebalanceConfig(config.solanaPtusdeRebalance, config, logger);
}
