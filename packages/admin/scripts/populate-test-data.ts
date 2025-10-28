#!/usr/bin/env ts-node
/**
 * Script to populate test data for testing admin endpoints
 */

import * as database from '@mark/database';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';

const DB_CONFIG = {
  connectionString: 'postgresql://postgres:postgres@localhost:5433/mark_dev',
};

async function main() {
  console.log('Initializing database connection...');
  database.initializeDatabase(DB_CONFIG);

  console.log('Creating test earmarks and operations...');

  // Create earmarks with different invoice IDs
  const earmark1 = await database.createEarmark({
    invoiceId: 'test-invoice-001',
    designatedPurchaseChain: 1,
    tickerHash: 'USDC',
    minAmount: '1000000000', // 1000 USDC (6 decimals)
    status: EarmarkStatus.PENDING,
  });
  console.log(`Created earmark 1: ${earmark1.id}`);

  const earmark2 = await database.createEarmark({
    invoiceId: 'test-invoice-002',
    designatedPurchaseChain: 137,
    tickerHash: 'USDC',
    minAmount: '2000000000', // 2000 USDC
    status: EarmarkStatus.READY,
  });
  console.log(`Created earmark 2: ${earmark2.id}`);

  const earmark3 = await database.createEarmark({
    invoiceId: 'test-invoice-003',
    designatedPurchaseChain: 42161,
    tickerHash: 'USDT',
    minAmount: '500000000', // 500 USDT (6 decimals)
    status: EarmarkStatus.COMPLETED,
  });
  console.log(`Created earmark 3: ${earmark3.id}`);

  // Create multiple operations for earmark1 (to test pagination)
  console.log(`Creating 15 operations for earmark 1...`);
  const operations1 = [];
  for (let i = 0; i < 15; i++) {
    const op = await database.createRebalanceOperation({
      earmarkId: earmark1.id,
      originChainId: 1,
      destinationChainId: 137,
      tickerHash: 'USDC',
      amount: `${(i + 1) * 100000000}`, // Varying amounts
      slippage: 30,
      status: i < 5 ? RebalanceOperationStatus.PENDING : i < 10 ? RebalanceOperationStatus.AWAITING_CALLBACK : RebalanceOperationStatus.COMPLETED,
      bridge: 'across',
      recipient: '0x1234567890123456789012345678901234567890',
    });
    operations1.push(op);
    if ((i + 1) % 5 === 0) {
      console.log(`  Created ${i + 1} operations...`);
    }
  }

  // Create operations for earmark2
  console.log(`Creating 5 operations for earmark 2...`);
  const operations2 = [];
  for (let i = 0; i < 5; i++) {
    const op = await database.createRebalanceOperation({
      earmarkId: earmark2.id,
      originChainId: 137,
      destinationChainId: 42161,
      tickerHash: 'USDC',
      amount: `${(i + 1) * 200000000}`,
      slippage: 50,
      status: i < 2 ? RebalanceOperationStatus.PENDING : RebalanceOperationStatus.COMPLETED,
      bridge: 'across',
      recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    operations2.push(op);
  }

  // Create operations for earmark3
  console.log(`Creating 3 operations for earmark 3...`);
  const operations3 = [];
  for (let i = 0; i < 3; i++) {
    const op = await database.createRebalanceOperation({
      earmarkId: earmark3.id,
      originChainId: 42161,
      destinationChainId: 1,
      tickerHash: 'USDT',
      amount: `${(i + 1) * 150000000}`,
      slippage: 40,
      status: RebalanceOperationStatus.COMPLETED,
      bridge: 'binance',
      recipient: '0x9876543210987654321098765432109876543210',
    });
    operations3.push(op);
  }

  // Create some standalone operations (without earmarks) for additional testing
  console.log(`Creating 7 standalone operations...`);
  const standaloneOps = [];
  for (let i = 0; i < 7; i++) {
    const op = await database.createRebalanceOperation({
      earmarkId: null,
      originChainId: 1,
      destinationChainId: 10,
      tickerHash: 'ETH',
      amount: `${BigInt(i + 1) * 1000000000000000000n}`, // 1-7 ETH
      slippage: 25,
      status: i < 3 ? RebalanceOperationStatus.PENDING : RebalanceOperationStatus.COMPLETED,
      bridge: 'across',
    });
    standaloneOps.push(op);
  }

  console.log('\n=== Test Data Summary ===');
  console.log(`Total Earmarks: 3`);
  console.log(`  - Earmark 1 (invoice-001): ${operations1.length} operations`);
  console.log(`  - Earmark 2 (invoice-002): ${operations2.length} operations`);
  console.log(`  - Earmark 3 (invoice-003): ${operations3.length} operations`);
  console.log(`Total Standalone Operations: ${standaloneOps.length}`);
  console.log(`Total Operations: ${operations1.length + operations2.length + operations3.length + standaloneOps.length}`);

  console.log('\n=== Useful IDs for Testing ===');
  console.log(`Earmark 1 ID: ${earmark1.id}`);
  console.log(`Earmark 2 ID: ${earmark2.id}`);
  console.log(`Earmark 3 ID: ${earmark3.id}`);
  console.log(`Sample Operation ID (earmark1): ${operations1[0].id}`);
  console.log(`Sample Operation ID (earmark2): ${operations2[0].id}`);
  console.log(`Sample Operation ID (standalone): ${standaloneOps[0].id}`);

  await database.closeDatabase();
  console.log('\nDone!');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
