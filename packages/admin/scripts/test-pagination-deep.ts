#!/usr/bin/env ts-node
/**
 * Deep pagination testing script
 * Tests all pagination scenarios comprehensively
 */

import * as database from '@mark/database';
import { handleApiRequest } from '../src/api/routes';
import { AdminContext } from '../src/types';
import { APIGatewayEvent } from 'aws-lambda';

const DB_CONFIG = {
  connectionString: 'postgresql://postgres:postgres@localhost:5433/mark_dev?sslmode=disable',
};

function createMockEvent(path: string, queryParams: Record<string, string> | null): APIGatewayEvent {
  return {
    httpMethod: 'GET',
    path,
    headers: { 'x-admin-token': 'test-admin-token' },
    queryStringParameters: queryParams,
    pathParameters: null,
    body: null,
    requestContext: { requestId: `test-${Date.now()}` },
  } as any;
}

async function makeRequest(path: string, params: Record<string, string> | null = null) {
  const event = createMockEvent(path, params);
  const context: AdminContext = {
    event,
    requestId: event.requestContext.requestId,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any,
    config: { adminToken: 'test-admin-token' } as any,
    purchaseCache: {} as any,
    startTime: Date.now(),
    database: database as typeof database,
  };

  const result = await handleApiRequest(context);
  return {
    statusCode: result.statusCode,
    body: JSON.parse(result.body),
  };
}

async function main() {
  console.log('🔬 Deep Pagination Testing\n');
  console.log('Initializing database...');
  database.initializeDatabase(DB_CONFIG);

  // Get total count first
  const allOps = await makeRequest('/admin/rebalance/operations');
  const totalOperations = allOps.body.total;
  console.log(`📊 Total operations in database: ${totalOperations}\n`);

  let testsPassed = 0;
  let testsFailed = 0;

  function testCase(name: string, condition: boolean, details?: string) {
    if (condition) {
      console.log(`  ✅ ${name}${details ? `: ${details}` : ''}`);
      testsPassed++;
    } else {
      console.log(`  ❌ ${name}${details ? `: ${details}` : ''}`);
      testsFailed++;
    }
  }

  // Test 1: Basic pagination - first page
  console.log('🧪 Test 1: First Page (limit=10, offset=0)');
  const page1 = await makeRequest('/admin/rebalance/operations', { limit: '10', offset: '0' });
  testCase('Status 200', page1.statusCode === 200);
  testCase('Returns 10 operations', page1.body.operations.length === 10);
  testCase('Total matches overall total', page1.body.total === totalOperations);
  testCase('Has operations array', Array.isArray(page1.body.operations));

  // Test 2: Second page
  console.log('\n🧪 Test 2: Second Page (limit=10, offset=10)');
  const page2 = await makeRequest('/admin/rebalance/operations', { limit: '10', offset: '10' });
  testCase('Status 200', page2.statusCode === 200);
  testCase('Returns 10 operations', page2.body.operations.length === 10);
  testCase('Total consistent', page2.body.total === totalOperations);
  testCase('Different operations than page 1', page1.body.operations[0].id !== page2.body.operations[0].id);

  // Test 3: Third page
  console.log('\n🧪 Test 3: Third Page (limit=10, offset=20)');
  const page3 = await makeRequest('/admin/rebalance/operations', { limit: '10', offset: '20' });
  testCase('Status 200', page3.statusCode === 200);
  testCase('Returns expected count', page3.body.operations.length === Math.min(10, totalOperations - 20));
  testCase('Total consistent', page3.body.total === totalOperations);

  // Test 4: Different page sizes
  console.log('\n🧪 Test 4: Different Page Sizes');
  const small = await makeRequest('/admin/rebalance/operations', { limit: '5', offset: '0' });
  const medium = await makeRequest('/admin/rebalance/operations', { limit: '15', offset: '0' });
  const large = await makeRequest('/admin/rebalance/operations', { limit: '50', offset: '0' });
  testCase('limit=5 returns 5', small.body.operations.length === 5);
  testCase('limit=15 returns 15', medium.body.operations.length === 15);
  testCase('limit=50 returns min(50, total)', large.body.operations.length === Math.min(50, totalOperations));
  testCase('All have same total', small.body.total === medium.body.total && medium.body.total === large.body.total);

  // Test 5: Boundary conditions
  console.log('\n🧪 Test 5: Boundary Conditions');
  const atEnd = await makeRequest('/admin/rebalance/operations', { limit: '10', offset: String(totalOperations) });
  testCase('Offset at total returns empty', atEnd.body.operations.length === 0 && atEnd.body.total === totalOperations);

  const beyondEnd = await makeRequest('/admin/rebalance/operations', { limit: '10', offset: String(totalOperations + 100) });
  testCase('Offset beyond total returns empty', beyondEnd.body.operations.length === 0);

  const lastPartial = await makeRequest('/admin/rebalance/operations', { limit: '10', offset: String(totalOperations - 3) });
  testCase('Last partial page', lastPartial.body.operations.length === 3, `Expected 3, got ${lastPartial.body.operations.length}`);

  // Test 6: No overlap between pages
  console.log('\n🧪 Test 6: No Overlap Between Pages');
  const p1 = await makeRequest('/admin/rebalance/operations', { limit: '5', offset: '0' });
  const p2 = await makeRequest('/admin/rebalance/operations', { limit: '5', offset: '5' });
  const p3 = await makeRequest('/admin/rebalance/operations', { limit: '5', offset: '10' });

  const ids1 = new Set(p1.body.operations.map((op: any) => op.id));
  const ids2 = new Set(p2.body.operations.map((op: any) => op.id));
  const ids3 = new Set(p3.body.operations.map((op: any) => op.id));

  const hasOverlap12 = p1.body.operations.some((op: any) => ids2.has(op.id));
  const hasOverlap23 = p2.body.operations.some((op: any) => ids3.has(op.id));
  const hasOverlap13 = p1.body.operations.some((op: any) => ids3.has(op.id));

  testCase('No overlap between page 1 and 2', !hasOverlap12);
  testCase('No overlap between page 2 and 3', !hasOverlap23);
  testCase('No overlap between page 1 and 3', !hasOverlap13);

  // Test 7: Ordering consistency
  console.log('\n🧪 Test 7: Ordering Consistency (created_at ASC)');
  const ordered = await makeRequest('/admin/rebalance/operations', { limit: '20', offset: '0' });
  let orderCorrect = true;
  for (let i = 1; i < ordered.body.operations.length; i++) {
    const prev = new Date(ordered.body.operations[i - 1].createdAt).getTime();
    const curr = new Date(ordered.body.operations[i].createdAt).getTime();
    if (prev > curr) {
      orderCorrect = false;
      break;
    }
  }
  testCase('Operations ordered by created_at ASC', orderCorrect);

  // Test 8: Complete dataset reconstruction
  console.log('\n🧪 Test 8: Complete Dataset Reconstruction');
  const allIds = new Set();
  let offset = 0;
  const pageSize = 7; // Use prime number to test edge cases
  let pagesRetrieved = 0;

  while (offset < totalOperations) {
    const page = await makeRequest('/admin/rebalance/operations', { limit: String(pageSize), offset: String(offset) });
    page.body.operations.forEach((op: any) => allIds.add(op.id));
    offset += pageSize;
    pagesRetrieved++;

    if (pagesRetrieved > 100) break; // Safety limit
  }

  testCase('Reconstructed all unique operations', allIds.size === totalOperations, `Got ${allIds.size}, expected ${totalOperations}`);
  testCase('No duplicates across pages', allIds.size === totalOperations);

  // Test 9: Pagination with invoice filter
  console.log('\n🧪 Test 9: Pagination with Invoice ID Filter');
  const filtered1 = await makeRequest('/admin/rebalance/operations', { invoiceId: 'test-invoice-001', limit: '5', offset: '0' });
  const filtered2 = await makeRequest('/admin/rebalance/operations', { invoiceId: 'test-invoice-001', limit: '5', offset: '5' });
  const filteredTotal = filtered1.body.total;

  testCase('Filtered pagination page 1', filtered1.statusCode === 200);
  testCase('Filtered pagination page 2', filtered2.statusCode === 200);
  testCase('Total consistent across filtered pages', filtered1.body.total === filtered2.body.total);
  testCase('Filtered results count correct', filteredTotal >= filtered1.body.operations.length + filtered2.body.operations.length);

  // Test 10: Maximum limit enforcement
  console.log('\n🧪 Test 10: Maximum Limit Enforcement');
  const max1000 = await makeRequest('/admin/rebalance/operations', { limit: '1000', offset: '0' });
  const max2000 = await makeRequest('/admin/rebalance/operations', { limit: '2000', offset: '0' });

  testCase('limit=1000 accepted', max1000.body.operations.length === Math.min(1000, totalOperations));
  testCase('limit=2000 capped at 1000', max2000.body.operations.length === Math.min(1000, totalOperations));
  testCase('Both return same count', max1000.body.operations.length === max2000.body.operations.length);

  // Test 11: Offset + Limit combinations
  console.log('\n🧪 Test 11: Offset + Limit Combinations');
  const combo1 = await makeRequest('/admin/rebalance/operations', { limit: '10', offset: '25' });
  const combo2 = await makeRequest('/admin/rebalance/operations', { limit: '3', offset: String(totalOperations - 5) });

  testCase('Mid-range offset works', combo1.statusCode === 200);
  testCase('Near-end offset works', combo2.statusCode === 200 && combo2.body.operations.length === Math.min(3, 5));

  // Test 12: Default values
  console.log('\n🧪 Test 12: Default Values');
  const noParams = await makeRequest('/admin/rebalance/operations', null);
  const onlyLimit = await makeRequest('/admin/rebalance/operations', { limit: '20' });
  const onlyOffset = await makeRequest('/admin/rebalance/operations', { offset: '10' });

  testCase('No params uses defaults', noParams.body.operations.length === Math.min(50, totalOperations), `Got ${noParams.body.operations.length}`);
  testCase('Only limit provided', onlyLimit.body.operations.length === 20);
  testCase('Only offset provided (uses default limit)', onlyOffset.body.operations.length === Math.min(50, totalOperations - 10));

  console.log('\n' + '='.repeat(80));
  console.log(`\n📊 Pagination Test Results: ${testsPassed} passed, ${testsFailed} failed`);
  console.log(testsFailed === 0 ? '✅ All pagination tests passed!\n' : '❌ Some pagination tests failed!\n');

  await database.closeDatabase();
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
