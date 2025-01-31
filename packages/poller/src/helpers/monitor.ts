import { MarkConfiguration } from '@mark/core';
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

export const logGasThresholds = (gas: Map<string, bigint>, config: MarkConfiguration, logger: Logger) => {
  // Log if the gas balance is below threshold. Still try to send intents if this threshold
  // is configured generously.
  [...gas.keys()].map((chain) => {
    const threshold = config.chains[chain].gasThreshold ?? '0';
    if (!threshold) {
      logger.error('No configured gas threshold', {
        chain,
        config: config.chains[chain],
      });
      return;
    }
    if (gas.get(chain)! > BigInt(threshold ?? '0')) {
      return;
    }
    logger.error('Gas balance is below threshold', {
      chain,
      threshold,
      balance: gas.get(chain)!.toString(),
    });
  });
};
