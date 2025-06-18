#!/usr/bin/env node
import { config } from 'dotenv';
import { Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';
import { SupportedBridge } from '@mark/core';
import { Command } from 'commander';

// Load environment variables
config();

// Initialize logger
const logger = new Logger({
  level: 'debug',
  service: 'cache-loader'
});

// Create CLI program
const program = new Command();

program
  .name('load-tx-cache')
  .description('Load a transaction into the rebalance cache')
  .version('1.0.0');

program
  .command('load')
  .description('Load a specific transaction into cache')
  .requiredOption('-h, --hash <txHash>', 'Transaction hash')
  .requiredOption('-r, --recipient <address>', 'Recipient address')
  .option('-o, --origin <chainId>', 'Origin chain ID', '42161')
  .option('-d, --destination <chainId>', 'Destination chain ID', '1')
  .option('-a, --amount <amount>', 'Amount in ETH', '0.01')
  .option('-t, --token <address>', 'Token address', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1')
  .option('-b, --bridge <bridge>', 'Bridge type', 'binance')
  .action(async (options) => {
    const cache = new RebalanceCache('127.0.0.1', 6379);

    try {
      // Convert amount to wei
      const amountInWei = (parseFloat(options.amount) * 1e18).toString();
      
      // Map bridge name to enum
      const bridgeMap: Record<string, SupportedBridge> = {
        'binance': SupportedBridge.Binance,
        'across': SupportedBridge.Across,
      };
      
      const bridge = bridgeMap[options.bridge.toLowerCase()];
      if (!bridge) {
        throw new Error(`Unknown bridge: ${options.bridge}`);
      }

      // Create rebalance entry
      const rebalanceEntry = {
        id: `${bridge}-${options.hash.slice(0, 10)}-${Date.now()}`,
        bridge,
        amount: amountInWei,
        origin: parseInt(options.origin),
        destination: parseInt(options.destination),
        asset: options.token,
        transaction: options.hash,
        recipient: options.recipient,
      };

      // Check if transaction already exists
      const existing = await cache.getRebalanceByTransaction(options.hash);
      if (existing) {
        logger.warn('⚠️  Transaction already exists in cache. Skipping to avoid duplicates.');
        logger.info('Existing entry:', existing as unknown as Record<string, unknown>);
        
        logger.info('\n📋 You can run the resume command:');
        logger.info(`yarn rebalance:dev resume ${options.bridge} -o ${options.origin} -h ${options.hash} -d ${options.destination} -a ${options.amount} -t ${options.token}`);
        return;
      }
      
      logger.info('Adding rebalance entry to cache:', rebalanceEntry as Record<string, unknown>);
      
      // Add to cache
      await cache.addRebalances([rebalanceEntry]);
      
      // Verify it was added
      const cached = await cache.getRebalanceByTransaction(options.hash);
      if (cached) {
        logger.info('✅ Successfully added transaction to cache');
        logger.info('Cached entry:', cached as unknown as Record<string, unknown>);
        
        logger.info('\n📋 You can now run the resume command:');
        logger.info(`yarn rebalance:dev resume ${options.bridge} -o ${options.origin} -h ${options.hash} -d ${options.destination} -a ${options.amount} -t ${options.token}`);
      } else {
        logger.error('❌ Failed to verify transaction in cache');
      }
      
    } catch (error) {
      logger.error('Failed to load transaction to cache', { error: error as Error });
      process.exit(1);
    } finally {
      // RebalanceCache doesn't have a close method, just let it clean up on exit
      // Give Redis time to clean up
      setTimeout(() => process.exit(0), 100);
    }
  });

program
  .command('check')
  .description('Check if a transaction exists in cache')
  .requiredOption('-h, --hash <txHash>', 'Transaction hash to check')
  .action(async (options) => {
    const cache = new RebalanceCache('127.0.0.1', 6379);

    try {
      const cached = await cache.getRebalanceByTransaction(options.hash);
      
      if (cached) {
        logger.info('✅ Transaction found in cache:');
        logger.info(JSON.stringify(cached, null, 2));
      } else {
        logger.info('❌ Transaction not found in cache');
      }
      
    } catch (error) {
      logger.error('Failed to check cache', { error: error as Error });
      process.exit(1);
    } finally {
      // RebalanceCache doesn't have a close method, just let it clean up on exit
      // Give Redis time to clean up
      setTimeout(() => process.exit(0), 100);
    }
  });

// Parse command line arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}