import { MarkConfiguration, GasType } from '@mark/core';
import { Logger } from '@mark/logger';

/**
 * NOTE: monitors are set up through datadog. If datadog detects a specific
 * log within defined time periods, it will trigger a betterstack alert automatically.
 * These thresholds are configured within datadog.
 */

export const logBalanceThresholds = (
  balances: Map<string, Map<string, bigint>>,
  config: MarkConfiguration,
  logger: Logger,
) => {
  // Log if the balance is below threshold on settlement domain.
  // Still try to send intents if this threshold is configured generously.
  [...balances.keys()].map((ticker) => {
    [...balances.get(ticker)!.keys()].map((domain) => {
      const held = balances.get(ticker)!.get(domain)!;
      const assets = config.chains[domain]?.assets ?? [];
      const asset = assets.find((a) => a.tickerHash.toLowerCase() === ticker.toLowerCase());
      if (!asset) {
        logger.warn('Asset not configured', {
          ticker,
          domain,
          chainConfig: config.chains[domain],
        });
        return;
      }
      if (held < BigInt(asset.balanceThreshold ?? '0')) {
        logger.error('Asset balance below threshold', {
          asset,
          chain: domain,
          balance: held,
        });
      }
    });
  });
};

export const logGasThresholds = (
  gas: Map<{ chainId: string; gasType: GasType }, bigint>,
  config: MarkConfiguration,
  logger: Logger,
) => {
  // Log if the gas balance is below threshold. Still try to send intents if this threshold
  // is configured generously.
  // TODO: Update getMarkGasBalances calls to support TronWeb and new gas type keys if used in this file.
  [...gas.keys()].map((gasKey) => {
    const { chainId, gasType } = gasKey;
    let threshold: string | undefined;

    switch (gasType) {
      case GasType.Gas:
        threshold = config.chains[chainId].gasThreshold ?? '0';
        break;
      case GasType.Bandwidth:
        threshold = config.chains[chainId].bandwidthThreshold ?? '0';
        break;
      case GasType.Energy:
        threshold = config.chains[chainId].energyThreshold ?? '0';
        break;
      default:
        logger.error('Unknown gas type', { chainId, gasType });
        return;
    }

    if (!threshold) {
      logger.error('No configured gas threshold', {
        chain: chainId,
        gasType,
        config: config.chains[chainId],
      });
      return;
    }
    if (gas.get(gasKey)! > BigInt(threshold ?? '0')) {
      return;
    }
    logger.error('Gas balance is below threshold', {
      chain: chainId,
      gasType,
      threshold,
      balance: gas.get(gasKey)!.toString(),
    });
  });
};
