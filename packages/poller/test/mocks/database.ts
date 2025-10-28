import { stub } from 'sinon';
import * as DatabaseModule from '@mark/database';

// Mock types for database entities
interface MockEarmark {
  id: string;
  invoiceId: string;
  designatedPurchaseChain: number;
  tickerHash: string;
  minAmount: string;
  status: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

interface MockRebalanceOperation {
  id: string;
  earmarkId: string | null;
  originChainId: number;
  destinationChainId: number;
  tickerHash: string;
  amount: string;
  slippage: number;
  status: string;
  bridge: string;
  txHashes: Record<string, unknown>;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Creates a mock database module for testing
 * All functions return stubs that can be configured per test
 */
export function createDatabaseMock(): typeof DatabaseModule {
  return {
    // Core database functions
    initializeDatabase: stub().returns({}),
    getPool: stub().returns({}),
    closeDatabase: stub().resolves(),
    queryWithClient: stub().resolves([]),
    withTransaction: stub().resolves(),

    // Earmark operations
    createEarmark: stub().resolves({
      id: 'mock-earmark-id',
      invoiceId: 'mock-invoice',
      designatedPurchaseChain: 1,
      tickerHash: '0x0000000000000000000000000000000000000000',
      minAmount: '1000000',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getEarmarks: stub().resolves([]),
    getActiveEarmarkForInvoice: stub().resolves(null),
    removeEarmark: stub().resolves(),
    updateEarmarkStatus: stub().resolves({
      id: 'mock-earmark-id',
      invoiceId: 'mock-invoice',
      designatedPurchaseChain: 1,
      tickerHash: '0x0000000000000000000000000000000000000000',
      minAmount: '1000000',
      status: 'ready',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as MockEarmark),
    getActiveEarmarksForChain: stub().resolves([]),

    // Rebalance operations
    createRebalanceOperation: stub().resolves({
      id: 'mock-operation-id',
      earmarkId: null,
      originChainId: 1,
      destinationChainId: 2,
      tickerHash: '0x0000000000000000000000000000000000000000',
      amount: '1000000',
      slippage: 30,
      status: 'pending',
      bridge: 'mock-bridge',
      txHashes: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updateRebalanceOperation: stub().resolves({
      id: 'mock-operation-id',
      earmarkId: null,
      originChainId: 1,
      destinationChainId: 2,
      tickerHash: '0x0000000000000000000000000000000000000000',
      amount: '1000000',
      slippage: 30,
      status: 'completed',
      bridge: 'mock-bridge',
      txHashes: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as MockRebalanceOperation),
    getRebalanceOperations: stub().resolves({ operations: [], total: 0 }),
    getRebalanceOperationById: stub().resolves(null),
    getRebalanceOperationsByStatus: stub().resolves([]),
    getRebalanceOperationsByEarmark: stub().resolves([]),
    getTransactionsForRebalanceOperations: stub().resolves({}),
    getRebalanceOperationByTransactionHash: stub().resolves(undefined),

    // Admin operations
    setPause: stub().resolves(),
    isPaused: stub().resolves(false),

    // Connection functions
    getDatabaseUrl: stub().returns('postgresql://mock@localhost/test'),
    waitForConnection: stub().resolves(),
    gracefulShutdown: stub().resolves(),

    // Database operations object
    database: {
      earmarks: {
        select: stub().resolves([]),
        insert: stub().resolves({} as MockEarmark),
        update: stub().resolves([]),
        delete: stub().resolves([]),
      },
      rebalance_operations: {
        select: stub().resolves([]),
        insert: stub().resolves({} as MockRebalanceOperation),
      },
    },

    // Export database namespace (for 'db' alias)
    db: {
      earmarks: {
        select: stub().resolves([]),
        insert: stub().resolves({} as MockEarmark),
        update: stub().resolves([]),
        delete: stub().resolves([]),
      },
      rebalance_operations: {
        select: stub().resolves([]),
        insert: stub().resolves({} as MockRebalanceOperation),
      },
    },

    // Error classes
    DatabaseError: class DatabaseError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'DatabaseError';
      }
    },
    ConnectionError: class ConnectionError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ConnectionError';
      }
    },
  } as unknown as typeof DatabaseModule;
}

/**
 * Create a minimal database mock for tests that don't use database functionality
 */
export function createMinimalDatabaseMock(): typeof DatabaseModule {
  const mock = createDatabaseMock();
  // Return only the most essential stubs to reduce noise in tests
  return {
    ...mock,
    // Most tests won't use these, so we can stub them to throw if called unexpectedly
    createEarmark: stub().rejects(new Error('Database mock not configured for this test')),
    getEarmarks: stub().rejects(new Error('Database mock not configured for this test')),
    createRebalanceOperation: stub().rejects(new Error('Database mock not configured for this test')),
    getRebalanceOperations: stub().resolves({ operations: [], total: 0 }),
  } as unknown as typeof DatabaseModule;
}
