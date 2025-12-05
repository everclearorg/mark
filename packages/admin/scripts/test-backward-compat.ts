#!/usr/bin/env ts-node
/**
 * Backward compatibility testing to ensure existing code still works
 */

import * as database from '@mark/database';
import { RebalanceOperationStatus } from '@mark/core';

const DB_CONFIG = {
  connectionString: 'postgresql://postgres:postgres@localhost:5433/mark_dev',
};

async function runBackwardCompatTests() {
  console.log('🔄 Testing Backward Compatibility\n');

  database.initializeDatabase(DB_CONFIG);

  let passCount = 0;
  let failCount = 0;

  const testCase = (name: string, passed: boolean, details?: string) => {
    if (passed) {
      console.log(`  ✅ ${name}`);
      if (details) console.log(`     ${details}`);
      passCount++;
    } else {
      console.log(`  ❌ ${name}`);
      if (details) console.log(`     ${details}`);
      failCount++;
    }
  };

  try {
    // Test 1: Old-style call with just filter (no pagination)
    console.log('\n📦 Test 1: Calling with undefined pagination (backward compat)');
    const result1 = await database.getRebalanceOperations(undefined, undefined, {
      status: RebalanceOperationStatus.PENDING,
    });
    testCase(
      'undefined pagination params work',
      typeof result1 === 'object' && 'operations' in result1 && 'total' in result1,
      `Returns: { operations: [...], total: ${result1.total} }`
    );
    testCase(
      'Operations array is returned',
      Array.isArray(result1.operations),
      `${result1.operations.length} operations`
    );

    // Test 2: Calling with only limit (no offset)
    console.log('\n📦 Test 2: Calling with only limit (no offset)');
    const result2 = await database.getRebalanceOperations(10, undefined, {});
    testCase('Only limit parameter works', result2.operations.length <= 10, `Returned ${result2.operations.length} operations`);

    // Test 3: Calling with only offset (no limit)
    console.log('\n📦 Test 3: Calling with only offset (no limit)');
    const result3 = await database.getRebalanceOperations(undefined, 5, {});
    testCase('Only offset parameter works', typeof result3.total === 'number', `Total: ${result3.total}`);

    // Test 4: Empty filter object
    console.log('\n📦 Test 4: Empty filter object');
    const result4 = await database.getRebalanceOperations(10, 0, {});
    testCase('Empty filter works', result4.operations.length >= 0, `Found ${result4.total} total operations`);

    // Test 5: No filter at all
    console.log('\n📦 Test 5: No filter at all');
    const result5 = await database.getRebalanceOperations(10, 0);
    testCase('No filter parameter works', result5.operations.length >= 0, `Found ${result5.total} operations`);

    // Test 6: Filter with all undefined values
    console.log('\n📦 Test 6: Filter with all undefined values');
    const result6 = await database.getRebalanceOperations(undefined, undefined, {
      status: undefined,
      chainId: undefined,
      earmarkId: undefined,
      invoiceId: undefined,
    });
    testCase('Filter with undefined values works', result6.total >= 0);

    // Test 7: Check structure of returned operations
    console.log('\n📦 Test 7: Operation structure validation');
    if (result5.operations.length > 0) {
      const op = result5.operations[0];
      testCase('Operation has id', !!op.id);
      testCase('Operation has status', !!op.status);
      testCase('Operation has originChainId', typeof op.originChainId === 'number');
      testCase('Operation has destinationChainId', typeof op.destinationChainId === 'number');
      testCase('Operation has amount', !!op.amount);
      testCase('Operation has tickerHash', !!op.tickerHash);
      testCase('Operation has slippage', typeof op.slippage === 'number');
      testCase('Operation has isOrphaned', typeof op.isOrphaned === 'boolean');
      testCase('Operation has transactions field', 'transactions' in op, `Type: ${typeof op.transactions}`);
    }

    // Test 8: Existing function signatures still work
    console.log('\n📦 Test 8: Other database functions unchanged');
    const earmarks = await database.getEarmarks();
    testCase('getEarmarks() still works', Array.isArray(earmarks));

    const opsByEarmark = await database.getRebalanceOperationsByEarmark('00000000-0000-0000-0000-000000000000');
    testCase('getRebalanceOperationsByEarmark() still works', Array.isArray(opsByEarmark));

    const opById = await database.getRebalanceOperationById('00000000-0000-0000-0000-000000000000');
    testCase('getRebalanceOperationById() returns undefined for non-existent', opById === undefined);

    // Test 9: Return value structure
    console.log('\n📦 Test 9: Return value destructuring compatibility');
    const { operations, total } = await database.getRebalanceOperations(5, 0, {});
    testCase('Can destructure { operations, total }', Array.isArray(operations) && typeof total === 'number');
    testCase('operations is an array', Array.isArray(operations));
    testCase('total is a number', typeof total === 'number');

    // Test 10: Original filter options still work
    console.log('\n📦 Test 10: Original filter options');
    const result10a = await database.getRebalanceOperations(undefined, undefined, {
      status: RebalanceOperationStatus.PENDING,
    });
    testCase('Filter by status works', result10a.total >= 0);

    const result10b = await database.getRebalanceOperations(undefined, undefined, {
      chainId: 1,
    });
    testCase('Filter by chainId works', result10b.total >= 0);

    const result10c = await database.getRebalanceOperations(undefined, undefined, {
      earmarkId: null,
    });
    testCase('Filter by earmarkId=null works', result10c.total >= 0, `Found ${result10c.total} standalone operations`);

    console.log('\n' + '='.repeat(80));
    console.log(`\n📊 Backward Compatibility Results: ${passCount} passed, ${failCount} failed`);

    if (failCount === 0) {
      console.log('✅ All backward compatibility tests passed!\n');
    } else {
      console.log(`❌ ${failCount} compatibility test(s) failed!\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error during compatibility testing:', error);
    throw error;
  } finally {
    await database.closeDatabase();
  }
}

runBackwardCompatTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
