// Polyfill crypto for Solana library compatibility
import { webcrypto } from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto as Crypto;
}
if (typeof (global as typeof globalThis & { crypto?: Crypto }).crypto === 'undefined') {
  (global as typeof globalThis & { crypto: Crypto }).crypto = webcrypto as Crypto;
}

import '../polyfills';
import '../rebalance/registrations';

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { bytesToHex } from 'viem';
import { Logger } from '@mark/logger';
import { MarkConfiguration, loadConfiguration, cleanupHttpConnections } from '@mark/core';
import { runMigration, validateTokenRebalanceConfig } from '@mark/agent';
import { cleanupExpiredEarmarks, cleanupExpiredRegularRebalanceOps } from '../rebalance';
import { initializeAdapters, ProcessingContext, MarkAdapters } from '../init';
import { getRegisteredRebalancers, RebalancerRegistration } from '../rebalance/registry';
import { cleanupViemClients } from '../helpers/contracts';
import * as database from '@mark/database';
import { E2EConfig, E2EResult } from './types';
import {
  createDryRunChainService,
  createDryRunSolanaSigner,
  createDryRunRebalanceAdapter,
  DryRunCounter,
} from './dry-chain-service';

// --- CLI Argument Parsing ---

function parseArgs(): { runModes: string[]; dryRun: boolean; configPath?: string; sequential: boolean } {
  const args = process.argv.slice(2);
  let runModes: string[] = [];
  let dryRun = process.env.DRY_RUN === 'true';
  let configPath = process.env.E2E_CONFIG_PATH;
  let sequential = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--run-modes':
        if (args[i + 1]) {
          runModes = args[++i].split(',');
        }
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--config':
        configPath = args[++i];
        break;
      case '--sequential':
        sequential = true;
        break;
    }
  }

  return { runModes, dryRun, configPath, sequential };
}

function loadE2EConfig(configPath?: string): E2EConfig | undefined {
  if (!configPath) return undefined;

  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    console.error(`E2E config file not found: ${resolved}`);
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(resolved, 'utf-8')) as E2EConfig;
}

// --- Config Override ---

function deepMerge<T>(target: T, source: Partial<T>): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = { ...target } as Record<string, any>;
  for (const key of Object.keys(source as Record<string, unknown>)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sourceVal = (source as Record<string, any>)[key];
    if (
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof result[key] === 'object' &&
      result[key] !== null
    ) {
      result[key] = deepMerge(result[key], sourceVal);
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

function applyOverrides(config: MarkConfiguration, e2eConfig: E2EConfig): void {
  if (!e2eConfig.overrides) return;

  if (e2eConfig.overrides.methRebalance && config.methRebalance) {
    config.methRebalance = deepMerge(config.methRebalance, e2eConfig.overrides.methRebalance);
  }
  if (e2eConfig.overrides.tacRebalance && config.tacRebalance) {
    config.tacRebalance = deepMerge(config.tacRebalance, e2eConfig.overrides.tacRebalance);
  }
  if (e2eConfig.overrides.aManUsdeRebalance && config.aManUsdeRebalance) {
    config.aManUsdeRebalance = deepMerge(config.aManUsdeRebalance, e2eConfig.overrides.aManUsdeRebalance);
  }
  if (e2eConfig.overrides.aMansyrupUsdtRebalance && config.aMansyrupUsdtRebalance) {
    config.aMansyrupUsdtRebalance = deepMerge(
      config.aMansyrupUsdtRebalance,
      e2eConfig.overrides.aMansyrupUsdtRebalance,
    );
  }
  if (e2eConfig.overrides.solanaPtusdeRebalance && config.solanaPtusdeRebalance) {
    config.solanaPtusdeRebalance = deepMerge(config.solanaPtusdeRebalance, e2eConfig.overrides.solanaPtusdeRebalance);
  }
}

// --- Cleanup (mirrors init.ts:cleanupAdapters) ---

async function cleanupAdapters(adapters: MarkAdapters): Promise<void> {
  try {
    await Promise.all([adapters.purchaseCache.disconnect(), database.closeDatabase()]);
    cleanupHttpConnections();
    cleanupViemClients();
  } catch (error) {
    adapters.logger.warn('Error during adapter cleanup', { error });
  }
}

// --- Runner ---

async function runRebalancer(
  rebalancer: RebalancerRegistration,
  adapters: MarkAdapters,
  config: MarkConfiguration,
  counter: DryRunCounter,
): Promise<E2EResult> {
  const startMs = Date.now();
  const counterBefore = counter.count;

  try {
    const context: ProcessingContext = {
      ...adapters,
      config,
      requestId: bytesToHex(randomBytes(32)),
      startTime: Math.floor(Date.now() / 1000),
    };

    await cleanupExpiredEarmarks(context);
    await cleanupExpiredRegularRebalanceOps(context);

    adapters.logger.info(`Running ${rebalancer.displayName} (${rebalancer.runMode})...`);

    const actions = await rebalancer.handler(context);

    return {
      runMode: rebalancer.runMode,
      displayName: rebalancer.displayName,
      status: 'completed',
      actions: actions.length,
      dryRunIntercepted: counter.count - counterBefore,
      durationMs: Date.now() - startMs,
    };
  } catch (error) {
    return {
      runMode: rebalancer.runMode,
      displayName: rebalancer.displayName,
      status: 'failed',
      actions: 0,
      dryRunIntercepted: counter.count - counterBefore,
      error: (error as Error).message,
      durationMs: Date.now() - startMs,
    };
  }
}

// --- Summary ---

function printSummary(results: E2EResult[], isDryRun: boolean): void {
  console.log('\n=== E2E Rebalancer Test Results ===');
  console.log(`Mode: ${isDryRun ? 'dry-run' : 'live'}\n`);

  const header = '  Run Mode                   Status       Actions   Dry-Run TX   Duration';
  const separator = '  ' + '-'.repeat(header.length - 2);

  console.log(header);
  console.log(separator);

  for (const r of results) {
    const mode = r.runMode.padEnd(25);
    const status = r.status.toUpperCase().padEnd(11);
    const actions = r.status === 'failed' || r.status === 'skipped' ? '-'.padEnd(9) : String(r.actions).padEnd(9);
    const dryTx =
      r.status === 'failed' || r.status === 'skipped' ? '-'.padEnd(12) : String(r.dryRunIntercepted).padEnd(12);
    const duration = r.status === 'skipped' ? '-' : `${(r.durationMs / 1000).toFixed(1)}s`;

    console.log(`  ${mode} ${status} ${actions} ${dryTx} ${duration}`);

    if (r.error) {
      console.log(`    Error: ${r.error}`);
    }
  }

  const passed = results.filter((r) => r.status === 'completed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  console.log(`\nOverall: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
}

// --- Main ---

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  const e2eConfig = loadE2EConfig(cliArgs.configPath);

  // Merge CLI args with config file (CLI takes precedence)
  const isDryRun = cliArgs.dryRun || e2eConfig?.dryRun || false;
  const runModes = cliArgs.runModes.length > 0 ? cliArgs.runModes : e2eConfig?.runModes || ['all'];
  const sequential = cliArgs.sequential || e2eConfig?.sequential || false;

  console.log(`E2E Rebalancer Test`);
  console.log(`  Dry run:    ${isDryRun}`);
  console.log(`  Run modes:  ${runModes.join(', ')}`);
  console.log(`  Sequential: ${sequential}`);
  console.log('');

  // 1. Load production config
  const config = await loadConfiguration();

  const logger = new Logger({
    service: 'mark-e2e',
    level: config.logLevel,
  });

  // 2. Apply overrides from e2e config
  if (e2eConfig) {
    applyOverrides(config, e2eConfig);
    logger.info('Applied E2E config overrides');
  }

  // 3. Run database migration
  await runMigration(logger);

  // 4. Validate config
  validateTokenRebalanceConfig(config, logger);

  // 5. Initialize adapters (same as production)
  let adapters: MarkAdapters | undefined;

  try {
    adapters = initializeAdapters(config, logger);

    // 6. If dry-run, wrap chain services with proxies
    const counter: DryRunCounter = { count: 0 };

    if (isDryRun) {
      adapters.chainService = createDryRunChainService(adapters.chainService, logger, counter);

      if (adapters.fillServiceChainService) {
        adapters.fillServiceChainService = createDryRunChainService(adapters.fillServiceChainService, logger, counter);
      }

      if (adapters.solanaSigner) {
        adapters.solanaSigner = createDryRunSolanaSigner(adapters.solanaSigner, logger, counter);
      }

      // Wrap rebalance adapter to intercept CCIP sendSolanaToMainnet (bypasses SolanaSigner)
      adapters.rebalance = createDryRunRebalanceAdapter(adapters.rebalance, logger, counter);

      logger.info('Dry-run mode: transaction submission will be intercepted');
    }

    // 7. Resolve target rebalancers
    const registered = getRegisteredRebalancers();
    const targets: RebalancerRegistration[] = [];
    const results: E2EResult[] = [];

    for (const reg of registered) {
      if (runModes.includes('all') || runModes.includes(reg.runMode)) {
        // Check if Solana signer is needed but missing
        if (reg.runMode === 'solanaUsdcOnly' && !adapters.solanaSigner) {
          results.push({
            runMode: reg.runMode,
            displayName: reg.displayName,
            status: 'skipped',
            actions: 0,
            dryRunIntercepted: 0,
            error: 'SolanaSigner not configured',
            durationMs: 0,
          });
          continue;
        }
        targets.push(reg);
      }
    }

    if (targets.length === 0) {
      logger.warn('No rebalancers matched the specified run modes', { runModes });
      printSummary(results, isDryRun);
      process.exit(1);
    }

    // 8. Execute
    if (sequential) {
      for (const rebalancer of targets) {
        const result = await runRebalancer(rebalancer, adapters, config, counter);
        results.push(result);
      }
    } else {
      const settled = await Promise.allSettled(targets.map((r) => runRebalancer(r, adapters!, config, counter)));
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          results.push(s.value);
        } else {
          // This shouldn't happen since runRebalancer catches errors, but handle it
          results.push({
            runMode: 'unknown',
            displayName: 'unknown',
            status: 'failed',
            actions: 0,
            dryRunIntercepted: 0,
            error: s.reason?.message || 'Unknown error',
            durationMs: 0,
          });
        }
      }
    }

    // 9. Print results
    printSummary(results, isDryRun);

    // 10. Exit with code
    const hasFailed = results.some((r) => r.status === 'failed');
    process.exit(hasFailed ? 1 : 0);
  } finally {
    if (adapters) {
      await cleanupAdapters(adapters);
    }
  }
}

main().catch((err) => {
  console.error('E2E runner failed:', err);
  process.exit(1);
});
