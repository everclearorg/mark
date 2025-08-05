import { stub, createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import * as sinon from 'sinon';
import {
  MarkConfiguration,
  SupportedBridge,
  TransactionSubmissionType,
  RebalanceOperationStatus,
  RebalanceRoute,
} from '@mark/core';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceCache, RebalanceAction } from '@mark/cache';
import * as submitTransactionModule from '../../src/helpers/transactions';
import { RebalanceAdapter } from '@mark/rebalance';
import { executeDestinationCallbacks } from '../../src/rebalance/callbacks';
import { TransactionReceipt } from 'viem';
import * as DatabaseModule from '@mark/database';
import { ITransactionReceipt } from '@chimera-monorepo/chainservice/dist/shared/types';
import { providers, BigNumber } from 'ethers';

// Define the interface for the specific adapter methods needed
interface MockBridgeAdapter {
  readyOnDestination: SinonStub<[string, RebalanceRoute, TransactionReceipt], Promise<boolean>>;
  destinationCallback: SinonStub<
    [RebalanceRoute, TransactionReceipt],
    Promise<{ transaction: { to: string; data: string; value?: string }; memo: string } | void>
  >;
  type: SinonStub<[], SupportedBridge>;
  getReceivedAmount: SinonStub<[string, RebalanceRoute], Promise<string>>;
  send: SinonStub<
    [string, string, string, RebalanceRoute],
    Promise<Array<{ transaction: { to: string; data: string; value?: string }; memo: string }>>
  >;
}

// Helper to create ITransactionReceipt for ChainService mocks
const toChainServiceReceipt = (viemReceipt: TransactionReceipt): ITransactionReceipt => ({
  blockNumber: Number(viemReceipt.blockNumber),
  status: viemReceipt.status === 'success' ? 1 : 0,
  transactionHash: viemReceipt.transactionHash,
  confirmations: 1,
  logs: viemReceipt.logs.map((log, index) => ({
    address: log.address,
    topics: [],
    data: log.data,
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    blockHash: log.blockHash,
    logIndex: index,
    removed: false,
  })),
});

describe('executeDestinationCallbacks', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockRebalanceCache: SinonStubbedInstance<RebalanceCache>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
  let mockSpecificBridgeAdapter: MockBridgeAdapter;
  let submitTransactionStub: SinonStub;
  let mockDatabase: typeof DatabaseModule;

  let mockConfig: MarkConfiguration;

  // Helper to create database operation from action
  const createDbOperation = (action: RebalanceAction, id: string) => ({
    id,
    earmarkId: null,
    originChainId: action.origin,
    destinationChainId: action.destination,
    tickerHash: action.asset,
    amount: action.amount,
    bridge: action.bridge,
    txHashes: { originTxHash: action.transaction },
    status: RebalanceOperationStatus.PENDING,
    slippage: 100,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const MOCK_REQUEST_ID = 'test-request-id';
  const MOCK_START_TIME = Date.now();

  const mockAction1Id = 'action-1';
  const mockAction1: RebalanceAction = {
    asset: 'ETH',
    origin: 1,
    destination: 10,
    bridge: 'Across' as SupportedBridge,
    transaction: '0xtxhash1',
    amount: '1000',
    recipient: '0x1234567890123456789012345678901234567890',
  };

  // Mock transaction receipt
  const mockReceipt1 = {
    blockHash: '0xblockhash1' as `0x${string}`,
    blockNumber: BigInt(123),
    contractAddress: null,
    cumulativeGasUsed: BigInt(100000),
    effectiveGasPrice: BigInt(20),
    from: '0xsender' as `0x${string}`,
    gasUsed: BigInt(21000),
    logs: [],
    logsBloom: '0x' as `0x${string}`,
    status: 'success',
    to: '0xcontract' as `0x${string}`,
    transactionHash: mockAction1.transaction as `0x${string}`,
    transactionIndex: 1,
    type: 'legacy',
  } as TransactionReceipt;

  const mockCallbackTx = {
    transaction: {
      to: '0xDestinationContract',
      data: '0xcallbackdata',
      value: '0',
    },
    memo: 'Callback',
  };

  // submitAndMonitor should resolve with a receipt-like object
  const mockSubmitSuccessReceipt = {
    blockHash: '0xblockhash2' as `0x${string}`,
    blockNumber: BigInt(234),
    contractAddress: null,
    cumulativeGasUsed: BigInt(100000),
    effectiveGasPrice: BigInt(20),
    from: '0xsender' as `0x${string}`,
    gasUsed: BigInt(21000),
    logs: [],
    logsBloom: '0x' as `0x${string}`,
    status: 'success',
    to: '0xcontract' as `0x${string}`,
    transactionHash: '0xDestTxHashSuccess' as `0x${string}`,
    transactionIndex: 1,
    type: 'legacy',
  } as TransactionReceipt;

  // Create ethers receipt for submitTransactionWithLogging
  const mockEthersReceipt: providers.TransactionReceipt = {
    transactionHash: mockSubmitSuccessReceipt.transactionHash,
    blockHash: mockSubmitSuccessReceipt.blockHash,
    blockNumber: Number(mockSubmitSuccessReceipt.blockNumber),
    confirmations: 1,
    from: mockSubmitSuccessReceipt.from,
    to: mockSubmitSuccessReceipt.to || '',
    contractAddress: mockSubmitSuccessReceipt.contractAddress || '',
    transactionIndex: mockSubmitSuccessReceipt.transactionIndex,
    gasUsed: BigNumber.from(mockSubmitSuccessReceipt.gasUsed),
    cumulativeGasUsed: BigNumber.from(mockSubmitSuccessReceipt.cumulativeGasUsed),
    effectiveGasPrice: BigNumber.from(mockSubmitSuccessReceipt.effectiveGasPrice),
    logs: [],
    logsBloom: mockSubmitSuccessReceipt.logsBloom,
    byzantium: true,
    type: 0,
    status: 1,
  };

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockRebalanceCache = createStubInstance(RebalanceCache);
    mockChainService = createStubInstance(ChainService);
    mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
    mockSpecificBridgeAdapter = {
      readyOnDestination: stub<[string, RebalanceRoute, TransactionReceipt], Promise<boolean>>(),
      destinationCallback: stub<
        [RebalanceRoute, TransactionReceipt],
        Promise<{ transaction: { to: string; data: string; value?: string }; memo: string } | void>
      >(),
      type: stub<[], SupportedBridge>(),
      getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
      send: stub<
        [string, string, string, RebalanceRoute],
        Promise<Array<{ transaction: { to: string; data: string; value?: string }; memo: string }>>
      >(),
    };

    // Create mock database module with all required exports
    mockDatabase = {
      getRebalanceOperations: stub().resolves([]),
      updateRebalanceOperation: stub().resolves(),
      queryWithClient: stub().resolves(),
      initializeDatabase: stub(),
      closeDatabase: stub(),
      checkDatabaseHealth: stub().resolves({ healthy: true, timestamp: new Date() }),
      connectWithRetry: stub().resolves({}),
      gracefulShutdown: stub().resolves(),
      createEarmark: stub().resolves(),
      getEarmarks: stub().resolves([]),
      getEarmarkForInvoice: stub().resolves(null),
      removeEarmark: stub().resolves(),
      updateEarmarkStatus: stub().resolves(),
      getActiveEarmarksForChain: stub().resolves([]),
      createRebalanceOperation: stub().resolves(),
      getRebalanceOperationsByEarmark: stub().resolves([]),
      withTransaction: stub().resolves(),
      recordRebalanceOperation: stub().resolves(),
      updateOperationStatus: stub().resolves(),
      getPendingOperations: stub().resolves([]),
      DatabaseError: class DatabaseError extends Error {},
      ConnectionError: class ConnectionError extends Error {},
    } as unknown as typeof DatabaseModule;

    mockConfig = {
      routes: [{ asset: 'ETH', origin: 1, destination: 10 }],
      pushGatewayUrl: 'http://localhost:9091',
      web3SignerUrl: 'http://localhost:8545',
      everclearApiUrl: 'http://localhost:3000',
      relayer: '0xRelayerAddress',
      ownAddress: '0xOwnAddress',
      invoiceAge: 3600,
      logLevel: 'info',
      pollingInterval: 60000,
      maxRetries: 3,
      retryDelay: 1000,
      chains: {
        '1': { providers: ['http://mainnetprovider'] },
        '10': { providers: ['http://optimismprovider'] },
      },
      supportedSettlementDomains: [1, 10],
    } as unknown as MarkConfiguration;

    mockContext = {
      config: mockConfig,
      requestId: MOCK_REQUEST_ID,
      startTime: MOCK_START_TIME,
      logger: mockLogger,
      rebalanceCache: mockRebalanceCache,
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
      database: mockDatabase,
      everclear: undefined,
      purchaseCache: undefined,
      web3Signer: undefined,
      prometheus: undefined,
    } as unknown as SinonStubbedInstance<ProcessingContext>;

    mockRebalanceCache.getRebalances.resolves([]);
    mockRebalanceAdapter.getAdapter.callsFake(() => {
      // Return the same mock adapter for all bridges
      return mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>;
    });
    mockChainService.getTransactionReceipt.resolves(undefined);
    mockSpecificBridgeAdapter.readyOnDestination.resolves(false);
    mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);
    mockChainService.submitAndMonitor.resolves(
      toChainServiceReceipt(mockSubmitSuccessReceipt) as unknown as providers.TransactionReceipt,
    );
    submitTransactionStub = stub(submitTransactionModule, 'submitTransactionWithLogging').resolves({
      hash: mockSubmitSuccessReceipt.transactionHash,
      receipt: mockEthersReceipt,
      submissionType: TransactionSubmissionType.Onchain,
    });
  });

  afterEach(() => {
    if (submitTransactionStub) {
      submitTransactionStub.restore();
    }
  });

  it('should do nothing if no operations are found in database', async () => {
    await executeDestinationCallbacks(mockContext);
    expect(mockLogger.info.calledWith('Executing destination callbacks', { requestId: MOCK_REQUEST_ID })).toBe(true);
    expect(
      (mockDatabase.getRebalanceOperations as SinonStub).calledWith({
        status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
      }),
    ).toBe(true);
    expect(mockChainService.getTransactionReceipt.called).toBe(false);
  });

  it('should log and continue if transaction receipt is not found for an action', async () => {
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([
      {
        id: mockAction1Id,
        earmarkId: null,
        originChainId: mockAction1.origin,
        destinationChainId: mockAction1.destination,
        tickerHash: mockAction1.asset,
        amount: mockAction1.amount,
        bridge: mockAction1.bridge,
        txHashes: { originTxHash: mockAction1.transaction },
        status: RebalanceOperationStatus.PENDING,
        slippage: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(undefined);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.info.calledWith(
        'Origin transaction receipt not found for operation',
        sinon.match({ requestId: MOCK_REQUEST_ID }),
      ),
    ).toBe(true);
    expect(mockSpecificBridgeAdapter.readyOnDestination.called).toBe(false);
  });

  it('should log error and continue if getTransactionReceipt fails', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);

    const error = new Error('RPC error');
    mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).rejects(error);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.error.calledWith(
        'Failed to get transaction receipt',
        sinon.match({
          requestId: MOCK_REQUEST_ID,
          error: sinon.match.any,
        }),
      ),
    ).toBe(true);
    expect(mockSpecificBridgeAdapter.readyOnDestination.called).toBe(false);
  });

  it('should log info if readyOnDestination returns false', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toChainServiceReceipt(mockReceipt1));
    mockSpecificBridgeAdapter.readyOnDestination.resolves(false);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.info.calledWith(
        'Action not ready for destination callback',
        sinon.match({ requestId: MOCK_REQUEST_ID }),
      ),
    ).toBe(true);
    expect((mockDatabase.updateRebalanceOperation as SinonStub).called).toBe(false);
  });

  it('should log error and continue if readyOnDestination fails', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toChainServiceReceipt(mockReceipt1));

    const error = new Error('Bridge error');
    mockSpecificBridgeAdapter.readyOnDestination.rejects(error);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.error.calledWith(
        'Failed to check if ready on destination',
        sinon.match({
          requestId: MOCK_REQUEST_ID,
          error: sinon.match.any,
        }),
      ),
    ).toBe(true);
    expect(mockSpecificBridgeAdapter.destinationCallback.called).toBe(false);
  });

  it('should mark as completed if destinationCallback returns no transaction', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toChainServiceReceipt(mockReceipt1));
    mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.info.calledWith(
        'No destination callback required, marking as completed',
        sinon.match({ requestId: MOCK_REQUEST_ID }),
      ),
    ).toBe(true);
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(true);
  });

  it('should log error and continue if destinationCallback fails', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toChainServiceReceipt(mockReceipt1));

    const error = new Error('Callback error');
    mockSpecificBridgeAdapter.destinationCallback.rejects(error);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.error.calledWith(
        'Failed to retrieve destination callback',
        sinon.match({
          requestId: MOCK_REQUEST_ID,
          error: sinon.match.any,
        }),
      ),
    ).toBe(true);
    expect(submitTransactionStub.called).toBe(false);
  });

  it('should successfully execute destination callback and mark as completed', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toChainServiceReceipt(mockReceipt1));
    mockSpecificBridgeAdapter.destinationCallback.resolves(mockCallbackTx);

    await executeDestinationCallbacks(mockContext);

    expect(submitTransactionStub.calledOnce).toBe(true);
    expect(
      mockLogger.info.calledWith(
        'Successfully submitted destination callback',
        sinon.match({
          requestId: MOCK_REQUEST_ID,
          destinationTx: mockSubmitSuccessReceipt.transactionHash,
        }),
      ),
    ).toBe(true);
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(
        mockAction1Id,
        sinon.match({
          status: RebalanceOperationStatus.COMPLETED,
          txHashes: sinon.match.object,
        }),
      ),
    ).toBe(true);
  });

  it('should log error and continue if submitAndMonitor fails', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toChainServiceReceipt(mockReceipt1));
    mockSpecificBridgeAdapter.destinationCallback.resolves(mockCallbackTx);

    const error = new Error('Submit failed');
    submitTransactionStub.rejects(error);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.error.calledWith(
        'Failed to execute destination callback',
        sinon.match({
          requestId: MOCK_REQUEST_ID,
          error: sinon.match.any,
        }),
      ),
    ).toBe(true);
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(
        mockAction1Id,
        sinon.match({
          status: RebalanceOperationStatus.COMPLETED,
        }),
      ),
    ).toBe(false);
  });

  it('should process multiple actions, continuing on individual errors', async () => {
    const mockAction2Id = 'action-2';
    const mockAction2: RebalanceAction = {
      asset: 'USDC',
      origin: 1,
      destination: 137,
      bridge: 'Connext' as SupportedBridge,
      transaction: '0xtxhash2',
      amount: '2000',
      recipient: '0x2345678901234567890123456789012345678901',
    };
    const mockReceipt2: TransactionReceipt = {
      ...mockReceipt1,
      transactionHash: mockAction2.transaction as `0x${string}`,
    };

    const dbOperation1 = createDbOperation(mockAction1, mockAction1Id);
    const dbOperation2 = createDbOperation(mockAction2, mockAction2Id);
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation1, dbOperation2]);

    // First action fails to get receipt
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .rejects(new Error('RPC error'));

    // Second action succeeds
    mockChainService.getTransactionReceipt
      .withArgs(mockAction2.origin, mockAction2.transaction)
      .resolves(toChainServiceReceipt(mockReceipt2));

    // Reset the stubs to ensure clean state
    mockSpecificBridgeAdapter.readyOnDestination.reset();
    mockSpecificBridgeAdapter.destinationCallback.reset();

    // Set up the adapter behavior for any calls
    mockSpecificBridgeAdapter.readyOnDestination.resolves(true);
    mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);

    await executeDestinationCallbacks(mockContext);

    // Should have logged error for first action
    expect(
      mockLogger.error.calledWith('Failed to get transaction receipt', sinon.match({ operationId: mockAction1Id })),
    ).toBe(true);

    // Check that readyOnDestination was called for the second action
    expect(mockSpecificBridgeAdapter.readyOnDestination.called).toBe(true);

    // Second action should be processed and marked as completed
    // First it gets updated to AWAITING_CALLBACK, then to COMPLETED
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction2Id, {
        status: RebalanceOperationStatus.AWAITING_CALLBACK,
      }),
    ).toBe(true);
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction2Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(true);
  });

  it('should update operation to awaiting callback when ready', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toChainServiceReceipt(mockReceipt1));
    mockSpecificBridgeAdapter.readyOnDestination.resolves(true);

    await executeDestinationCallbacks(mockContext);

    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.AWAITING_CALLBACK,
      }),
    ).toBe(true);
    expect(
      mockLogger.info.calledWith(
        'Operation ready for callback, updated status',
        sinon.match({
          requestId: MOCK_REQUEST_ID,
          status: RebalanceOperationStatus.AWAITING_CALLBACK,
        }),
      ),
    ).toBe(true);
  });

  it('should query to expire old operations', async () => {
    await executeDestinationCallbacks(mockContext);

    expect((mockDatabase.queryWithClient as SinonStub).calledOnce).toBe(true);
    const [query, params] = (mockDatabase.queryWithClient as SinonStub).firstCall.args;
    expect(query).toContain('UPDATE rebalance_operations');
    expect(query).toContain("INTERVAL '24 hours'");
    expect(params![0]).toBe(RebalanceOperationStatus.EXPIRED);
    expect(params![1]).toEqual([RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK]);
  });

  it('should skip operation with missing bridge type', async () => {
    const dbOperationNoBridge = createDbOperation(mockAction1, mockAction1Id);
    dbOperationNoBridge.bridge = null as unknown as SupportedBridge;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperationNoBridge]);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.warn.calledWith('Operation missing bridge type', sinon.match({ requestId: MOCK_REQUEST_ID })),
    ).toBe(true);
    expect(mockChainService.getTransactionReceipt.called).toBe(false);
  });

  it('should skip operation with missing origin transaction hash', async () => {
    const dbOperationNoTxHash = createDbOperation(mockAction1, mockAction1Id);
    dbOperationNoTxHash.txHashes = { originTxHash: null as unknown as string };
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperationNoTxHash]);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.warn.calledWith(
        'Operation missing origin transaction hash',
        sinon.match({ requestId: MOCK_REQUEST_ID }),
      ),
    ).toBe(true);
    expect(mockChainService.getTransactionReceipt.called).toBe(false);
  });

  it('should handle error when expiring old operations', async () => {
    const error = new Error('Database error');
    (mockDatabase.queryWithClient as SinonStub).rejects(error);

    await executeDestinationCallbacks(mockContext);

    expect(
      mockLogger.error.calledWith(
        'Failed to expire old operations',
        sinon.match({
          requestId: MOCK_REQUEST_ID,
          error: sinon.match.any,
        }),
      ),
    ).toBe(true);
  });

  it('should handle callback transaction with undefined value', async () => {
    const callbackWithUndefinedValue = {
      transaction: {
        to: '0xDestinationContract',
        data: '0xcallbackdata',
        // value is undefined
      },
      memo: 'Callback',
    };

    const dbOperation = createDbOperation(mockAction1, mockAction1Id);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockChainService.getTransactionReceipt.resolves(toChainServiceReceipt(mockReceipt1));
    mockRebalanceAdapter.getAdapter.callsFake(() => {
      // Return the same mock adapter for all bridges
      return mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>;
    });
    mockSpecificBridgeAdapter.readyOnDestination.resolves(true);
    mockSpecificBridgeAdapter.destinationCallback.resolves(callbackWithUndefinedValue);
    submitTransactionStub.resolves({
      hash: mockSubmitSuccessReceipt.transactionHash,
      submissionType: TransactionSubmissionType.Onchain,
      receipt: mockEthersReceipt,
    });

    await executeDestinationCallbacks(mockContext);

    // Verify the transaction was called with value defaulting to '0'
    expect(submitTransactionStub.calledOnce).toBe(true);
    const callArgs = submitTransactionStub.firstCall.args[0];
    expect(callArgs.txRequest.value).toBe('0');
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(
        mockAction1Id,
        sinon.match({
          status: RebalanceOperationStatus.COMPLETED,
        }),
      ),
    ).toBe(true);
  });
});
