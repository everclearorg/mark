#!/usr/bin/env ts-node
/**
 * Local test server for admin API
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

// Simple logger mock for testing
const logger = {
  debug: (msg: string, ctx?: any) => console.log(`[DEBUG] ${msg}`, ctx || ''),
  info: (msg: string, ctx?: any) => console.log(`[INFO] ${msg}`, ctx || ''),
  warn: (msg: string, ctx?: any) => console.log(`[WARN] ${msg}`, ctx || ''),
  error: (msg: string, ctx?: any) => console.log(`[ERROR] ${msg}`, ctx || ''),
} as any;

async function runTests() {
  console.log('🚀 Starting Admin API Tests\n');

  // Initialize services
  database.initializeDatabase(CONFIG.database);
  const purchaseCache = new PurchaseCache(CONFIG.redis.host, CONFIG.redis.port);

  console.log('✅ Services initialized\n');
  console.log('='.repeat(80));

  // Helper function to create a mock event
  const createEvent = (
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    body?: unknown,
    pathParams?: Record<string, string>
  ): APIGatewayEvent => ({
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

  // Helper function to make a request
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

  try {
    // Test 1: Get all operations without pagination
    console.log('\n📋 Test 1: Get all rebalance operations (no pagination)');
    const test1 = await makeRequest('GET', '/admin/rebalance/operations');
    console.log(`Status: ${test1.statusCode}`);
    console.log(`Total operations: ${test1.body?.total}`);
    console.log(`Operations returned: ${test1.body?.operations?.length}`);

    // Test 2: Get operations with pagination (page 1)
    console.log('\n📋 Test 2: Get operations with pagination (limit=10, offset=0)');
    const test2 = await makeRequest('GET', '/admin/rebalance/operations', { limit: '10', offset: '0' });
    console.log(`Status: ${test2.statusCode}`);
    console.log(`Total: ${test2.body?.total}`);
    console.log(`Returned: ${test2.body?.operations?.length}`);
    console.log(`First operation ID: ${test2.body?.operations?.[0]?.id}`);

    // Test 3: Get operations with pagination (page 2)
    console.log('\n📋 Test 3: Get operations with pagination (limit=10, offset=10)');
    const test3 = await makeRequest('GET', '/admin/rebalance/operations', { limit: '10', offset: '10' });
    console.log(`Status: ${test3.statusCode}`);
    console.log(`Total: ${test3.body?.total}`);
    console.log(`Returned: ${test3.body?.operations?.length}`);

    // Test 4: Filter by invoice ID
    console.log('\n📋 Test 4: Filter operations by invoice ID (test-invoice-001)');
    const test4 = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
    });
    console.log(`Status: ${test4.statusCode}`);
    console.log(`Total: ${test4.body?.total}`);
    console.log(`Operations: ${test4.body?.operations?.length}`);
    if (test4.body?.operations?.[0]) {
      console.log(`Sample operation ID: ${test4.body.operations[0].id}`);
      console.log(`Earmark ID: ${test4.body.operations[0].earmarkId || 'null'}`);
    }

    // Test 5: Filter by invoice ID with pagination
    console.log('\n📋 Test 5: Filter by invoice ID with pagination (limit=5)');
    const test5 = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
      limit: '5',
      offset: '0',
    });
    console.log(`Status: ${test5.statusCode}`);
    console.log(`Total matching invoice: ${test5.body?.total}`);
    console.log(`Returned in page: ${test5.body?.operations?.length}`);

    // Test 6: Filter by multiple criteria
    console.log('\n📋 Test 6: Filter by invoice ID + status + chainId');
    const test6 = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
      status: 'pending',
      chainId: '1',
    });
    console.log(`Status: ${test6.statusCode}`);
    console.log(`Total matching all filters: ${test6.body?.total}`);
    console.log(`Operations: ${test6.body?.operations?.length}`);

    // Test 7: Get operation by ID
    if (test2.body?.operations?.[0]?.id) {
      const operationId = test2.body.operations[0].id;
      console.log(`\n📋 Test 7: Get specific operation by ID (${operationId.substring(0, 8)}...)`);
      const test7 = await makeRequest('GET', `/admin/rebalance/operation/${operationId}`, undefined, undefined, {
        id: operationId,
      });
      console.log(`Status: ${test7.statusCode}`);
      console.log(`Operation ID: ${test7.body?.operation?.id}`);
      console.log(`Status: ${test7.body?.operation?.status}`);
      console.log(`Origin Chain: ${test7.body?.operation?.originChainId}`);
      console.log(`Destination Chain: ${test7.body?.operation?.destinationChainId}`);
      console.log(`Has transactions: ${test7.body?.operation?.transactions ? 'Yes' : 'No'}`);
    }

    // Test 8: Get operation by non-existent ID
    console.log('\n📋 Test 8: Get operation with non-existent ID');
    const test8 = await makeRequest(
      'GET',
      '/admin/rebalance/operation/00000000-0000-0000-0000-000000000000',
      undefined,
      undefined,
      { id: '00000000-0000-0000-0000-000000000000' }
    );
    console.log(`Status: ${test8.statusCode}`);
    console.log(`Message: ${test8.body?.message}`);

    // Test 9: Test pagination edge cases
    console.log('\n📋 Test 9: Pagination edge cases (limit=1000, offset=0)');
    const test9 = await makeRequest('GET', '/admin/rebalance/operations', { limit: '1000', offset: '0' });
    console.log(`Status: ${test9.statusCode}`);
    console.log(`Total: ${test9.body?.total}`);
    console.log(`Returned: ${test9.body?.operations?.length} (max 1000)`);

    // Test 10: Filter by invoice ID that doesn't exist
    console.log('\n📋 Test 10: Filter by non-existent invoice ID');
    const test10 = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'non-existent-invoice',
    });
    console.log(`Status: ${test10.statusCode}`);
    console.log(`Total: ${test10.body?.total}`);
    console.log(`Operations: ${test10.body?.operations?.length}`);

    console.log('\n' + '='.repeat(80));
    console.log('✅ All tests completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    throw error;
  } finally {
    await database.closeDatabase();
    console.log('🔌 Database connection closed');
  }
}

runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
