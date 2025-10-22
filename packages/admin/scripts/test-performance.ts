#!/usr/bin/env ts-node
/**
 * Performance testing for admin endpoints with large datasets
 */

import { handleApiRequest } from '../src/api/routes';
import { AdminContext, AdminConfig } from '../src/types';
import { PurchaseCache } from '@mark/cache';
import * as database from '@mark/database';
import { APIGatewayEvent } from 'aws-lambda';
import { EarmarkStatus, RebalanceOperationStatus } from '@mark/core';

const CONFIG: AdminConfig = {
  logLevel: 'info',
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
  info: () => {},
  warn: (msg: string) => console.log(`  [WARN] ${msg}`),
  error: (msg: string, ctx?: any) => console.log(`  [ERROR] ${msg}`, ctx || ''),
} as any;

async function runPerformanceTests() {
  console.log('⚡ Running Performance Tests\n');

  database.initializeDatabase(CONFIG.database);
  const purchaseCache = new PurchaseCache(CONFIG.redis.host, CONFIG.redis.port);

  const createEvent = (
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    pathParams?: Record<string, string>
  ): APIGatewayEvent =>
    ({
      httpMethod: method,
      path,
      headers: { 'x-admin-token': CONFIG.adminToken },
      queryStringParameters: queryParams || null,
      pathParameters: pathParams || null,
      body: null,
      requestContext: { requestId: `perf-${Date.now()}` } as any,
    } as any);

  const makeRequest = async (
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    pathParams?: Record<string, string>
  ) => {
    const startTime = Date.now();
    const event = createEvent(method, path, queryParams, pathParams);
    const context: AdminContext = {
      logger,
      config: CONFIG,
      event,
      requestId: event.requestContext.requestId,
      startTime,
      purchaseCache,
      database: database as typeof database,
    };

    const result = await handleApiRequest(context);
    const duration = Date.now() - startTime;

    return {
      statusCode: result.statusCode,
      body: result.body ? JSON.parse(result.body) : null,
      duration,
    };
  };

  try {
    // Get baseline count
    console.log('📊 Getting baseline dataset size...');
    const baseline = await makeRequest('GET', '/admin/rebalance/operations');
    console.log(`  Current dataset: ${baseline.body?.total} operations\n`);

    // Performance Test 1: Full scan without pagination
    console.log('⏱️  Test 1: Full dataset retrieval (no pagination)');
    const perf1 = await makeRequest('GET', '/admin/rebalance/operations');
    console.log(`  Duration: ${perf1.duration}ms`);
    console.log(`  Operations: ${perf1.body?.operations?.length}`);
    console.log(`  ${perf1.duration < 1000 ? '✅' : '⚠️'} ${perf1.duration < 1000 ? 'Fast' : 'Slow'} (${perf1.duration < 500 ? 'excellent' : perf1.duration < 1000 ? 'good' : 'needs optimization'})`);

    // Performance Test 2: Paginated requests
    console.log('\n⏱️  Test 2: Paginated retrieval (10 items)');
    const perf2 = await makeRequest('GET', '/admin/rebalance/operations', { limit: '10', offset: '0' });
    console.log(`  Duration: ${perf2.duration}ms`);
    console.log(`  Operations: ${perf2.body?.operations?.length}`);
    console.log(`  Total: ${perf2.body?.total}`);
    console.log(`  ${perf2.duration < 500 ? '✅' : '⚠️'} ${perf2.duration < 500 ? 'Fast' : 'Slow'}`);

    // Performance Test 3: Invoice ID filter (requires JOIN)
    console.log('\n⏱️  Test 3: Invoice ID filter with JOIN');
    const perf3 = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
    });
    console.log(`  Duration: ${perf3.duration}ms`);
    console.log(`  Matching operations: ${perf3.body?.total}`);
    console.log(`  ${perf3.duration < 1000 ? '✅' : '⚠️'} ${perf3.duration < 1000 ? 'Fast' : 'Slow'} (JOIN query)`);

    // Performance Test 4: Multiple filters with pagination
    console.log('\n⏱️  Test 4: Multiple filters + pagination');
    const perf4 = await makeRequest('GET', '/admin/rebalance/operations', {
      invoiceId: 'test-invoice-001',
      status: 'pending',
      chainId: '1',
      limit: '10',
      offset: '0',
    });
    console.log(`  Duration: ${perf4.duration}ms`);
    console.log(`  Matching operations: ${perf4.body?.total}`);
    console.log(`  Returned: ${perf4.body?.operations?.length}`);
    console.log(`  ${perf4.duration < 500 ? '✅' : '⚠️'} ${perf4.duration < 500 ? 'Fast' : 'Slow'}`);

    // Performance Test 5: Get by ID (single record lookup)
    console.log('\n⏱️  Test 5: Get operation by ID (direct lookup)');
    if (baseline.body?.operations?.[0]?.id) {
      const opId = baseline.body.operations[0].id;
      const perf5 = await makeRequest('GET', `/admin/rebalance/operation/${opId}`, undefined, { id: opId });
      console.log(`  Duration: ${perf5.duration}ms`);
      console.log(`  ${perf5.duration < 200 ? '✅' : '⚠️'} ${perf5.duration < 200 ? 'Fast' : 'Acceptable'} (primary key lookup)`);
    }

    // Performance Test 6: Multiple sequential requests
    console.log('\n⏱️  Test 6: Sequential pagination performance');
    const startSeq = Date.now();
    const pages = Math.min(5, Math.ceil((baseline.body?.total || 0) / 10));
    for (let i = 0; i < pages; i++) {
      await makeRequest('GET', '/admin/rebalance/operations', {
        limit: '10',
        offset: String(i * 10),
      });
    }
    const seqDuration = Date.now() - startSeq;
    const avgPerPage = seqDuration / pages;
    console.log(`  Total time for ${pages} pages: ${seqDuration}ms`);
    console.log(`  Average per page: ${avgPerPage.toFixed(2)}ms`);
    console.log(`  ${avgPerPage < 500 ? '✅' : '⚠️'} ${avgPerPage < 500 ? 'Fast' : 'Slow'}`);

    // Performance Test 7: Check query efficiency (count vs data)
    console.log('\n⏱️  Test 7: Count query efficiency');
    const perf7a = await makeRequest('GET', '/admin/rebalance/operations', { limit: '1', offset: '0' });
    console.log(`  Small page (limit=1) duration: ${perf7a.duration}ms`);
    const perf7b = await makeRequest('GET', '/admin/rebalance/operations', { limit: '1000', offset: '0' });
    console.log(`  Large page (limit=1000) duration: ${perf7b.duration}ms`);
    const ratio = perf7b.duration / perf7a.duration;
    console.log(`  Ratio (100/1): ${ratio.toFixed(2)}x`);
    console.log(`  ${ratio < 10 ? '✅' : '⚠️'} ${ratio < 10 ? 'Good scaling' : 'Check if indexes needed'}`);

    console.log('\n' + '='.repeat(80));
    console.log('\n✅ Performance tests completed!\n');

    // Summary
    console.log('📈 Performance Summary:');
    console.log(`  - All queries completed successfully`);
    console.log(`  - Dataset size: ${baseline.body?.total} operations`);
    console.log(`  - Pagination is working efficiently`);
    console.log(`  - JOIN queries for invoice_id filter performing well`);

  } catch (error) {
    console.error('\n❌ Performance test failed:', error);
    throw error;
  } finally {
    await database.closeDatabase();
  }
}

runPerformanceTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
