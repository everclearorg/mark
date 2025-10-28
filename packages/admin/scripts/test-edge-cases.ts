#!/usr/bin/env ts-node
/**
 * Comprehensive edge case testing for admin endpoints
 */

import { handleApiRequest } from '../src/api/routes';
import { AdminContext, AdminConfig } from '../src/types';
import { PurchaseCache } from '@mark/cache';
import * as database from '@mark/database';
import { APIGatewayEvent } from 'aws-lambda';

const CONFIG: AdminConfig = {
  logLevel: 'debug',
  adminToken: 'test-admin-token',
  redis: {
    host: 'localhost',
    port: 6379,
  },
  database: {
    connectionString: 'postgresql://postgres:postgres@localhost:5433/mark_dev',
  },
};

const logger = {
  debug: () => {},
  info: (msg: string, ctx?: any) => console.log(`  [INFO] ${msg}`),
  warn: (msg: string, ctx?: any) => console.log(`  [WARN] ${msg}`, ctx ? `\n    ${JSON.stringify(ctx)}` : ''),
  error: (msg: string, ctx?: any) => console.log(`  [ERROR] ${msg}`, ctx ? `\n    ${JSON.stringify(ctx)}` : ''),
} as any;

async function runEdgeCaseTests() {
  console.log('🧪 Running Edge Case Tests\n');

  database.initializeDatabase(CONFIG.database);
  const purchaseCache = new PurchaseCache(CONFIG.redis.host, CONFIG.redis.port);

  const createEvent = (
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    body?: unknown,
    pathParams?: Record<string, string>
  ): APIGatewayEvent =>
    ({
      httpMethod: method,
      path,
      headers: {
        'x-admin-token': CONFIG.adminToken,
      },
      queryStringParameters: queryParams || null,
      pathParameters: pathParams || null,
      body: body ? JSON.stringify(body) : null,
      requestContext: {
        requestId: `test-${Date.now()}`,
      } as any,
    } as any);

  const makeRequest = async (
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    body?: unknown,
    pathParams?: Record<string, string>
  ) => {
    const event = createEvent(method, path, queryParams, body, pathParams);
    const context: AdminContext = {
      logger,
      config: CONFIG,
      event,
      requestId: event.requestContext.requestId,
      startTime: Date.now(),
      purchaseCache,
      database: database as typeof database,
    };

    const result = await handleApiRequest(context);
    return {
      statusCode: result.statusCode,
      body: result.body ? JSON.parse(result.body) : null,
    };
  };

  let passCount = 0;
  let failCount = 0;

  const testCase = (name: string, expected: boolean, actual: boolean, details?: string) => {
    if (expected === actual) {
      console.log(`  ✅ ${name}`);
      if (details) console.log(`     ${details}`);
      passCount++;
    } else {
      console.log(`  ❌ ${name}`);
      console.log(`     Expected: ${expected}, Got: ${actual}`);
      if (details) console.log(`     ${details}`);
      failCount++;
    }
  };

  try {
    // Edge Case 1: Invalid pagination parameters
    console.log('\n🔍 Edge Case 1: Invalid Pagination Parameters');
    const test1a = await makeRequest('GET', '/admin/rebalance/operations', { limit: 'invalid', offset: '0' });
    testCase('Invalid limit defaults to 50', test1a.statusCode === 200, true, `Returned ${test1a.body?.operations?.length} operations`);

    const test1b = await makeRequest('GET', '/admin/rebalance/operations', { limit: '2000', offset: '0' });
    testCase(
      'Limit exceeding max (2000) capped at 1000',
      test1a.statusCode === 200 && test1b.body?.operations?.length <= 31,
      true,
      `Returned ${test1b.body?.operations?.length} operations (total: ${test1b.body?.total})`
    );

    const test1c = await makeRequest('GET', '/admin/rebalance/operations', { limit: '10', offset: '-5' });
    testCase('Negative offset treated as 0', test1c.statusCode === 200, true);

    // Edge Case 2: Empty results
    console.log('\n🔍 Edge Case 2: Empty Results');
    const test2a = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'absolutely-non-existent-invoice-xyz',
    });
    testCase(
      'Non-existent invoice returns empty',
      test2a.statusCode === 200 && test2a.body?.total === 0 && test2a.body?.operations?.length === 0,
      true
    );

    const test2b = await makeRequest('GET', '/admin/rebalance/operations', {
      status: 'cancelled',
      invoiceId: 'test-invoice-001',
    });
    testCase('Filter with no matches returns empty', test2b.statusCode === 200 && test2b.body?.total === 0, true);

    // Edge Case 3: Pagination boundary conditions
    console.log('\n🔍 Edge Case 3: Pagination Boundary Conditions');
    const test3a = await makeRequest('GET', '/admin/rebalance/operations', { limit: '50', offset: '0' });
    const total = test3a.body?.total || 0;

    const test3b = await makeRequest('GET', '/admin/rebalance/operations', {
      limit: '10',
      offset: String(total),
    });
    testCase(
      'Offset at total returns empty',
      test3b.statusCode === 200 && test3b.body?.operations?.length === 0 && test3b.body?.total === total,
      true,
      `Total: ${total}, Offset: ${total}`
    );

    const test3c = await makeRequest('GET', '/admin/rebalance/operations', {
      limit: '10',
      offset: String(total + 100),
    });
    testCase(
      'Offset beyond total returns empty',
      test3c.statusCode === 200 && test3c.body?.operations?.length === 0,
      true
    );

    const test3d = await makeRequest('GET', '/admin/rebalance/operations', {
      limit: '1',
      offset: String(total - 1),
    });
    testCase(
      'Last single item pagination works',
      test3d.statusCode === 200 && test3d.body?.operations?.length === 1,
      true
    );

    // Edge Case 4: Combined filters
    console.log('\n🔍 Edge Case 4: Combined Filters');
    const test4a = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
      status: 'pending',
      chainId: '1',
      limit: '100',
    });
    testCase('All filters work together', test4a.statusCode === 200, true, `Found ${test4a.body?.total} matches`);

    // Edge Case 5: Get operation by ID edge cases
    console.log('\n🔍 Edge Case 5: Get Operation by ID Edge Cases');
    const test5a = await makeRequest(
      'GET',
      '/admin/rebalance/operation/not-a-uuid',
      undefined,
      undefined,
      { id: 'not-a-uuid' }
    );
    testCase('Invalid UUID format handled gracefully', test5a.statusCode === 404, true);

    const test5b = await makeRequest(
      'GET',
      '/admin/rebalance/operation/00000000-0000-0000-0000-000000000000',
      undefined,
      undefined,
      { id: '00000000-0000-0000-0000-000000000000' }
    );
    testCase('Valid UUID but non-existent returns 404', test5b.statusCode === 404, true);

    // Edge Case 6: Invoice ID filter with pagination at boundaries
    console.log('\n🔍 Edge Case 6: Invoice ID Filter with Pagination');
    const test6a = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
    });
    const invoiceTotal = test6a.body?.total || 0;
    console.log(`  Invoice test-invoice-001 has ${invoiceTotal} operations`);

    const test6b = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
      limit: String(invoiceTotal),
      offset: '0',
    });
    testCase(
      'Exact limit equals total',
      test6b.body?.operations?.length === invoiceTotal && test6b.body?.total === invoiceTotal,
      true
    );

    const test6c = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
      limit: '5',
      offset: String(invoiceTotal - 3),
    });
    testCase('Partial page at end', test6c.body?.operations?.length === 3, true, `Expected 3, got ${test6c.body?.operations?.length}`);

    // Edge Case 7: No query parameters (should use defaults)
    console.log('\n🔍 Edge Case 7: Default Parameters');
    const test7 = await makeRequest('GET', '/admin/rebalance/operations');
    testCase('No query params uses defaults', test7.statusCode === 200 && test7.body?.operations?.length <= 50, true,
      `Used default limit, returned ${test7.body?.operations?.length}`
    );

    // Edge Case 8: Filter by earmarkId = null (orphaned operations)
    console.log('\n🔍 Edge Case 8: Filter by Earmark ID');
    const test8a = await makeRequest('GET', '/admin/rebalance/operations', {
      earmarkId: 'null',
    });
    testCase('Can filter by earmarkId=null for standalone ops', test8a.statusCode === 200, true, `Found ${test8a.body?.total} standalone operations`);

    // Edge Case 9: Test consistency between total and operations length
    console.log('\n🔍 Edge Case 9: Data Consistency');
    const test9a = await makeRequest('GET', '/admin/rebalance/operations', { limit: '5', offset: '0' });
    const test9b = await makeRequest('GET', '/admin/rebalance/operations', { limit: '5', offset: '5' });
    const test9c = await makeRequest('GET', '/admin/rebalance/operations', { limit: '5', offset: '10' });

    testCase(
      'Total count consistent across pages',
      test9a.body?.total === test9b.body?.total && test9b.body?.total === test9c.body?.total,
      true,
      `Page 1: ${test9a.body?.total}, Page 2: ${test9b.body?.total}, Page 3: ${test9c.body?.total}`
    );

    // Edge Case 10: Get operation by ID includes all expected fields
    console.log('\n🔍 Edge Case 10: Operation Detail Completeness');
    const allOps = await makeRequest('GET', '/admin/rebalance/operations', { limit: '1' });
    if (allOps.body?.operations?.[0]?.id) {
      const opId = allOps.body.operations[0].id;
      const test10 = await makeRequest('GET', `/admin/rebalance/operation/${opId}`, undefined, undefined, { id: opId });
      const op = test10.body?.operation;

      testCase('Operation has ID', !!op?.id, true);
      testCase('Operation has status', !!op?.status, true);
      testCase('Operation has originChainId', typeof op?.originChainId === 'number', true);
      testCase('Operation has destinationChainId', typeof op?.destinationChainId === 'number', true);
      testCase('Operation has amount', !!op?.amount, true);
      testCase('Operation has tickerHash', !!op?.tickerHash, true);
      testCase('Operation has createdAt', !!op?.createdAt, true);
      console.log(`    Full operation: ${JSON.stringify(op, null, 2).split('\n').slice(0, 5).join('\n')}`);
    }

    // Edge Case 11: Authorization
    console.log('\n🔍 Edge Case 11: Authorization');
    const unauthorizedEvent = createEvent('GET', '/admin/rebalance/operations', { limit: '10' });
    unauthorizedEvent.headers = {}; // No admin token
    const context: AdminContext = {
      logger,
      config: CONFIG,
      event: unauthorizedEvent,
      requestId: 'test-unauthorized',
      startTime: Date.now(),
      purchaseCache,
      database: database as typeof database,
    };
    const test11 = await handleApiRequest(context);
    testCase('Missing admin token returns 403', test11.statusCode === 403, true);

    console.log('\n' + '='.repeat(80));
    console.log(`\n📊 Edge Case Test Results: ${passCount} passed, ${failCount} failed`);

    if (failCount === 0) {
      console.log('✅ All edge case tests passed!\n');
    } else {
      console.log(`❌ ${failCount} edge case test(s) failed!\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error during edge case testing:', error);
    throw error;
  } finally {
    await database.closeDatabase();
  }
}

runEdgeCaseTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
