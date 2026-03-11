import { stub, createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import * as sinon from 'sinon';
import {
  MarkConfiguration,
  SupportedBridge,
  TransactionSubmissionType,
  RebalanceOperationStatus,
  RebalanceRoute,
  PostBridgeActionType,
} from '@mark/core';
import { Logger } from '@mark/logger';
import { executeDestinationCallbacks } from '../../src/rebalance/callbacks';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceAction } from '@mark/core';
import * as submitTransactionModule from '../../src/helpers/transactions';
import { RebalanceAdapter } from '@mark/rebalance';
import * as rebalanceModule from '@mark/rebalance';

import { TransactionReceipt } from 'viem';
import * as DatabaseModule from '@mark/database';
import { ITransactionReceipt } from '@chimera-monorepo/chainservice/dist/shared/types';
import { TransactionReceipt as ChainServiceReceipt } from '@mark/chainservice';

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

// Helper to create ITransactionReceipt for ChainService.getTransactionReceipt mocks
const toITransactionReceipt = (viemReceipt: TransactionReceipt): ITransactionReceipt => ({
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

// Helper to create ChainServiceReceipt for ChainService.submitAndMonitor mocks
const toChainServiceReceipt = (viemReceipt: TransactionReceipt): ChainServiceReceipt => ({
  ...toITransactionReceipt(viemReceipt),
  from: viemReceipt.from,
  to: viemReceipt.to || '',
  cumulativeGasUsed: viemReceipt.cumulativeGasUsed.toString(),
  effectiveGasPrice: viemReceipt.effectiveGasPrice.toString(),
});

describe('executeDestinationCallbacks', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
  let mockSpecificBridgeAdapter: MockBridgeAdapter;
  let submitTransactionStub: SinonStub;
  let buildTransactionsForActionSpy: jest.SpyInstance;
  let mockDatabase: typeof DatabaseModule;

  let mockConfig: MarkConfiguration;

  // Helper to create database operation from action
  const createDbOperation = (action: RebalanceAction, id: string, includeReceipt = false) => ({
    id,
    earmarkId: null,
    originChainId: action.origin,
    destinationChainId: action.destination,
    tickerHash: action.asset,
    amount: action.amount,
    bridge: action.bridge,
    transactions: includeReceipt
      ? {
          [action.origin]: {
            hash: action.transaction,
            metadata: {
              receipt: mockReceipt1,
            },
          },
        }
      : {
          [action.origin]: {
            hash: action.transaction,
          },
        },
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

  // Create ChainServiceReceipt for submitTransactionWithLogging
  const mockChainServiceReceipt: ChainServiceReceipt = {
    transactionHash: mockSubmitSuccessReceipt.transactionHash,
    from: mockSubmitSuccessReceipt.from,
    to: mockSubmitSuccessReceipt.to || '',
    blockNumber: Number(mockSubmitSuccessReceipt.blockNumber),
    confirmations: 1,
    status: 1,
    logs: [],
    cumulativeGasUsed: mockSubmitSuccessReceipt.cumulativeGasUsed.toString(),
    effectiveGasPrice: mockSubmitSuccessReceipt.effectiveGasPrice.toString(),
  };

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
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
      getRebalanceOperations: stub().resolves({ operations: [], total: 0 }),
      updateRebalanceOperation: stub().resolves(),
      queryWithClient: stub().resolves(),
      initializeDatabase: stub(),
      closeDatabase: stub(),
      checkDatabaseHealth: stub().resolves({ healthy: true, timestamp: new Date() }),
      connectWithRetry: stub().resolves({}),
      gracefulShutdown: stub().resolves(),
      createEarmark: stub().resolves(),
      getEarmarks: stub().resolves([]),
      getActiveEarmarkForInvoice: stub().resolves(null),
      removeEarmark: stub().resolves(),
      updateEarmarkStatus: stub().resolves(),
      getActiveEarmarksForChain: stub().resolves([]),
      createRebalanceOperation: stub().resolves(),
      getRebalanceOperationsByEarmark: stub().resolves([]),
      withTransaction: stub().resolves(),
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
        '1': {
          providers: ['http://mainnetprovider'],
          assets: [
            { tickerHash: 'ETH', address: '0xEthAddress1' },
            { tickerHash: 'USDC', address: '0xUsdcAddress1' },
          ],
        },
        '10': {
          providers: ['http://optimismprovider'],
          assets: [{ tickerHash: 'ETH', address: '0xEthAddress10' }],
        },
        '137': {
          providers: ['http://polygonprovider'],
          assets: [{ tickerHash: 'USDC', address: '0xUsdcAddress137' }],
        },
      },
      supportedSettlementDomains: [1, 10],
    } as unknown as MarkConfiguration;

    mockContext = {
      config: mockConfig,
      requestId: MOCK_REQUEST_ID,
      startTime: MOCK_START_TIME,
      logger: mockLogger,
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
      database: mockDatabase,
      everclear: undefined,
      purchaseCache: undefined,
      web3Signer: undefined,
      prometheus: undefined,
    } as unknown as SinonStubbedInstance<ProcessingContext>;

    mockRebalanceAdapter.getAdapter.callsFake(() => {
      // Return the same mock adapter for all bridges
      return mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>;
    });
    mockChainService.getTransactionReceipt.resolves(undefined);
    mockSpecificBridgeAdapter.readyOnDestination.resolves(false);
    mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);
    mockChainService.submitAndMonitor.resolves(toChainServiceReceipt(mockSubmitSuccessReceipt));
    submitTransactionStub = stub(submitTransactionModule, 'submitTransactionWithLogging').resolves({
      hash: mockSubmitSuccessReceipt.transactionHash,
      receipt: mockChainServiceReceipt,
      submissionType: TransactionSubmissionType.Onchain,
    });
    buildTransactionsForActionSpy = jest.spyOn(rebalanceModule, 'buildTransactionsForAction').mockResolvedValue([]);
  });

  afterEach(() => {
    if (submitTransactionStub) {
      submitTransactionStub.restore();
    }
    if (buildTransactionsForActionSpy) {
      buildTransactionsForActionSpy.mockRestore();
    }
  });

  it('should do nothing if no operations are found in database', async () => {
    await executeDestinationCallbacks(mockContext);
    expect(mockLogger.info.calledWith('Executing destination callbacks', { requestId: MOCK_REQUEST_ID })).toBe(true);
    expect(
      (mockDatabase.getRebalanceOperations as SinonStub).calledWith(undefined, undefined, {
        status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK, RebalanceOperationStatus.AWAITING_POST_BRIDGE],
      }),
    ).toBe(true);
    expect(mockChainService.getTransactionReceipt.called).toBe(false);
  });

  it('should log and continue if transaction receipt is not found for an action', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, false); // No receipt in metadata
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    await executeDestinationCallbacks(mockContext);

    const infoCallWithMessage = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'Origin transaction receipt not found for operation');
    expect(infoCallWithMessage).toBeDefined();
    if (infoCallWithMessage && infoCallWithMessage.args[1]) {
      expect(infoCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
    }
    expect(mockSpecificBridgeAdapter.readyOnDestination.called).toBe(false);
  });

  it('should log warning and continue if transaction entry is missing', async () => {
    const dbOperation = {
      id: mockAction1Id,
      earmarkId: null,
      originChainId: mockAction1.origin,
      destinationChainId: mockAction1.destination,
      tickerHash: mockAction1.asset,
      amount: mockAction1.amount,
      bridge: mockAction1.bridge,
      transactions: {}, // Empty transactions
      status: RebalanceOperationStatus.PENDING,
      slippage: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    await executeDestinationCallbacks(mockContext);

    const warnCallWithMessage = mockLogger.warn
      .getCalls()
      .find((call) => call.args[0] === 'Operation missing origin transaction');
    expect(warnCallWithMessage).toBeDefined();
    if (warnCallWithMessage && warnCallWithMessage.args[1]) {
      expect(warnCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
    }
    expect(mockSpecificBridgeAdapter.readyOnDestination.called).toBe(false);
  });

  it('should log info if readyOnDestination returns false', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockSpecificBridgeAdapter.readyOnDestination.resolves(false);

    await executeDestinationCallbacks(mockContext);

    const infoCallWithMessage = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'Action not ready for destination callback');
    expect(infoCallWithMessage).toBeDefined();
    if (infoCallWithMessage && infoCallWithMessage.args[1]) {
      expect(infoCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
    }
    expect((mockDatabase.updateRebalanceOperation as SinonStub).called).toBe(false);
  });

  it('should log error and continue if readyOnDestination fails', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    const error = new Error('Bridge error');
    mockSpecificBridgeAdapter.readyOnDestination.rejects(error);

    await executeDestinationCallbacks(mockContext);

    const errorCallWithMessage = mockLogger.error
      .getCalls()
      .find((call) => call.args[0] === 'Failed to check if ready on destination');
    expect(errorCallWithMessage).toBeDefined();
    if (errorCallWithMessage && errorCallWithMessage.args[1]) {
      expect(errorCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
      expect(errorCallWithMessage.args[1].error).toBeDefined();
    }
    expect(mockSpecificBridgeAdapter.destinationCallback.called).toBe(false);
  });

  it('should mark as completed if destinationCallback returns no transaction', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);

    await executeDestinationCallbacks(mockContext);

    const infoCallWithMessage = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'No destination callback required');
    expect(infoCallWithMessage).toBeDefined();
    if (infoCallWithMessage && infoCallWithMessage.args[1]) {
      expect(infoCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
    }
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(true);
  });

  it('should log error and continue if destinationCallback fails', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    const error = new Error('Callback error');
    mockSpecificBridgeAdapter.destinationCallback.rejects(error);

    await executeDestinationCallbacks(mockContext);

    const errorCallWithMessage = mockLogger.error
      .getCalls()
      .find((call) => call.args[0] === 'Failed to retrieve destination callback');
    expect(errorCallWithMessage).toBeDefined();
    if (errorCallWithMessage && errorCallWithMessage.args[1]) {
      expect(errorCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
      expect(errorCallWithMessage.args[1].error).toBeDefined();
    }
    expect(submitTransactionStub.called).toBe(false);
  });

  it('should successfully execute destination callback and mark as completed', async () => {
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockSpecificBridgeAdapter.destinationCallback.resolves(mockCallbackTx);

    await executeDestinationCallbacks(mockContext);

    expect(submitTransactionStub.calledOnce).toBe(true);
    const infoCallWithMessage = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'Successfully submitted destination callback');
    expect(infoCallWithMessage).toBeDefined();
    if (infoCallWithMessage && infoCallWithMessage.args[1]) {
      expect(infoCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
      expect(infoCallWithMessage.args[1].destinationTx).toBe(mockSubmitSuccessReceipt.transactionHash);
    }
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
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockSpecificBridgeAdapter.destinationCallback.resolves(mockCallbackTx);

    const error = new Error('Submit failed');
    submitTransactionStub.rejects(error);

    await executeDestinationCallbacks(mockContext);

    const errorCallWithMessage = mockLogger.error
      .getCalls()
      .find((call) => call.args[0] === 'Failed to execute destination callback');
    expect(errorCallWithMessage).toBeDefined();
    if (errorCallWithMessage && errorCallWithMessage.args[1]) {
      expect(errorCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
      expect(errorCallWithMessage.args[1].error).toBeDefined();
    }
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

    const dbOperation1 = createDbOperation(mockAction1, mockAction1Id, false); // No receipt for first
    const dbOperation2 = createDbOperation(mockAction2, mockAction2Id, true); // Has receipt for second
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation1, dbOperation2], total: 2 });

    // First action fails to get receipt
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .rejects(new Error('RPC error'));

    // Second action succeeds
    mockChainService.getTransactionReceipt
      .withArgs(mockAction2.origin, mockAction2.transaction)
      .resolves(toITransactionReceipt(mockReceipt2));

    // Reset the stubs to ensure clean state
    mockSpecificBridgeAdapter.readyOnDestination.reset();
    mockSpecificBridgeAdapter.destinationCallback.reset();

    // Set up the adapter behavior for any calls
    mockSpecificBridgeAdapter.readyOnDestination.resolves(true);
    mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);

    await executeDestinationCallbacks(mockContext);

    // Should have logged info for first action (no receipt in database)
    expect(
      mockLogger.info.calledWith(
        'Origin transaction receipt not found for operation',
        sinon.match({ operationId: mockAction1Id }),
      ),
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
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true); // Include receipt
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockChainService.getTransactionReceipt
      .withArgs(mockAction1.origin, mockAction1.transaction)
      .resolves(toITransactionReceipt(mockReceipt1));
    mockSpecificBridgeAdapter.readyOnDestination.resolves(true);

    await executeDestinationCallbacks(mockContext);

    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.AWAITING_CALLBACK,
      }),
    ).toBe(true);
    const infoCallWithMessage = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'Operation ready for callback, updated status');
    expect(infoCallWithMessage).toBeDefined();
    if (infoCallWithMessage && infoCallWithMessage.args[1]) {
      expect(infoCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
      expect(infoCallWithMessage.args[1].status).toBe(RebalanceOperationStatus.AWAITING_CALLBACK);
    }
  });

  it('should skip operation with missing bridge type', async () => {
    const dbOperationNoBridge = createDbOperation(mockAction1, mockAction1Id);
    dbOperationNoBridge.bridge = null as unknown as SupportedBridge;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperationNoBridge], total: 1 });

    await executeDestinationCallbacks(mockContext);

    const warnCallWithMessage = mockLogger.warn
      .getCalls()
      .find((call) => call.args[0] === 'Operation missing bridge type');
    expect(warnCallWithMessage).toBeDefined();
    if (warnCallWithMessage && warnCallWithMessage.args[1]) {
      expect(warnCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
    }
    expect(mockChainService.getTransactionReceipt.called).toBe(false);
  });

  it('should skip operation with missing origin transaction hash', async () => {
    const dbOperationNoTxHash = createDbOperation(mockAction1, mockAction1Id);
    dbOperationNoTxHash.transactions = {}; // Empty transactions object
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperationNoTxHash], total: 1 });

    await executeDestinationCallbacks(mockContext);

    const warnCallWithMessage = mockLogger.warn
      .getCalls()
      .find((call) => call.args[0] === 'Operation missing origin transaction');
    expect(warnCallWithMessage).toBeDefined();
    if (warnCallWithMessage && warnCallWithMessage.args[1]) {
      expect(warnCallWithMessage.args[1].requestId).toBe(MOCK_REQUEST_ID);
    }
    expect(mockChainService.getTransactionReceipt.called).toBe(false);
  });

  it('should execute post-bridge actions for AWAITING_POST_BRIDGE operations', async () => {
    // Configure route with postBridgeActions — asset must be the address so getTickerForAsset can match
    mockConfig.routes = [
      {
        asset: '0xEthAddress1',
        origin: 1,
        destination: 10,
        postBridgeActions: [
          {
            type: PostBridgeActionType.AaveSupply,
            poolAddress: '0xPoolAddress',
            supplyAsset: '0xEthAddress10',
          },
        ],
      },
    ] as unknown as typeof mockConfig.routes;

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    const mockPostBridgeTx = {
      memo: 'AaveSupply',
      transaction: {
        to: '0xPoolAddress' as `0x${string}`,
        data: '0xpostbridgedata' as `0x${string}`,
        value: BigInt(0),
      },
    };
    buildTransactionsForActionSpy.mockResolvedValue([mockPostBridgeTx]);

    await executeDestinationCallbacks(mockContext);

    // Verify buildTransactionsForAction was called with the right sender (ownAddress for EOA)
    expect(buildTransactionsForActionSpy).toHaveBeenCalledTimes(1);
    expect(buildTransactionsForActionSpy.mock.calls[0][0]).toBe(mockConfig.ownAddress);
    expect(buildTransactionsForActionSpy.mock.calls[0][1]).toBe(mockAction1.amount);
    expect(buildTransactionsForActionSpy.mock.calls[0][2]).toBe(mockAction1.destination);

    // Verify the post-bridge transaction was submitted
    expect(submitTransactionStub.calledOnce).toBe(true);
    const callArgs = submitTransactionStub.firstCall.args[0];
    expect(callArgs.txRequest.to).toBe('0xPoolAddress');
    expect(callArgs.txRequest.from).toBe(mockConfig.ownAddress);

    // Verify operation was marked COMPLETED
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(true);

    // Verify log messages
    const infoCall = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'Post-bridge actions completed successfully');
    expect(infoCall).toBeDefined();
  });

  it('should mark AWAITING_POST_BRIDGE as completed if no post-bridge actions configured', async () => {
    // Route has no postBridgeActions
    mockConfig.routes = [
      { asset: 'ETH', origin: 1, destination: 10 },
    ] as unknown as typeof mockConfig.routes;

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    await executeDestinationCallbacks(mockContext);

    // Should NOT call buildTransactionsForAction
    expect(buildTransactionsForActionSpy).not.toHaveBeenCalled();

    // Should mark as COMPLETED
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(true);

    // Verify warning was logged
    const warnCall = mockLogger.warn
      .getCalls()
      .find((call) => call.args[0] === 'Operation awaiting post-bridge actions but no actions configured, marking completed');
    expect(warnCall).toBeDefined();
  });

  it('should execute DexSwap + AaveSupply sequentially with amount chaining', async () => {
    // Configure route with DexSwap then AaveSupply
    mockConfig.routes = [
      {
        asset: '0xEthAddress1',
        origin: 1,
        destination: 10,
        postBridgeActions: [
          {
            type: PostBridgeActionType.DexSwap,
            sellToken: '0xUSDT',
            buyToken: '0xSyrupUSDT',
            slippageBps: 100,
          },
          {
            type: PostBridgeActionType.AaveSupply,
            poolAddress: '0xPoolAddress',
            supplyAsset: '0xSyrupUSDT',
          },
        ],
      },
    ] as unknown as typeof mockConfig.routes;

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    // First call (DexSwap action) returns swap tx with effectiveAmount
    const mockSwapTx = {
      memo: 'DexSwap',
      transaction: {
        to: '0xSwapRouter' as `0x${string}`,
        data: '0xswapdata' as `0x${string}`,
        value: BigInt(0),
      },
      effectiveAmount: '2000000000000000000', // 2 USDe in 18 decimals
    };
    // Second call (AaveSupply action) returns supply txs
    const mockSupplyTx = {
      memo: 'AaveSupply',
      transaction: {
        to: '0xPoolAddress' as `0x${string}`,
        data: '0xsupplydata' as `0x${string}`,
        value: BigInt(0),
      },
    };

    buildTransactionsForActionSpy
      .mockResolvedValueOnce([mockSwapTx])
      .mockResolvedValueOnce([mockSupplyTx]);

    await executeDestinationCallbacks(mockContext);

    // Verify buildTransactionsForAction was called twice (once per action)
    expect(buildTransactionsForActionSpy).toHaveBeenCalledTimes(2);

    // First call should use original amount
    expect(buildTransactionsForActionSpy.mock.calls[0][1]).toBe(mockAction1.amount);

    // Second call should use effectiveAmount from DexSwap
    expect(buildTransactionsForActionSpy.mock.calls[1][1]).toBe('2000000000000000000');

    // Both transactions should have been submitted
    expect(submitTransactionStub.calledTwice).toBe(true);

    // Verify operation was marked COMPLETED
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(true);
  });

  it('should pass effectiveAmount from DexSwap to AaveSupply amount parameter', async () => {
    // Configure route with DexSwap then AaveSupply
    mockConfig.routes = [
      {
        asset: '0xEthAddress1',
        origin: 1,
        destination: 10,
        postBridgeActions: [
          {
            type: PostBridgeActionType.DexSwap,
            sellToken: '0xUSDT',
            buyToken: '0xUSDe',
            slippageBps: 50,
          },
          {
            type: PostBridgeActionType.AaveSupply,
            poolAddress: '0xPool',
            supplyAsset: '0xUSDe',
          },
        ],
      },
    ] as unknown as typeof mockConfig.routes;

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    const swapOutputAmount = '5000000000000000000'; // 5 USDe
    buildTransactionsForActionSpy
      .mockResolvedValueOnce([{
        memo: 'DexSwap',
        transaction: { to: '0xRouter', data: '0x', value: BigInt(0) },
        effectiveAmount: swapOutputAmount,
      }])
      .mockResolvedValueOnce([{
        memo: 'AaveSupply',
        transaction: { to: '0xPool', data: '0x', value: BigInt(0) },
      }]);

    await executeDestinationCallbacks(mockContext);

    // AaveSupply (second call) should receive effectiveAmount from DexSwap as its amount
    expect(buildTransactionsForActionSpy.mock.calls[1][1]).toBe(swapOutputAmount);
  });

  it('should handle retry when DexSwap already completed (uses max amount for AaveSupply)', async () => {
    // Configure route with DexSwap then AaveSupply
    mockConfig.routes = [
      {
        asset: '0xEthAddress1',
        origin: 1,
        destination: 10,
        postBridgeActions: [
          {
            type: PostBridgeActionType.DexSwap,
            sellToken: '0xUSDT',
            buyToken: '0xSyrupUSDT',
            slippageBps: 100,
          },
          {
            type: PostBridgeActionType.AaveSupply,
            poolAddress: '0xPoolAddress',
            supplyAsset: '0xSyrupUSDT',
          },
        ],
      },
    ] as unknown as typeof mockConfig.routes;

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    // DexSwap returns empty — swap already completed on a previous attempt
    const mockSupplyTx = {
      memo: 'AaveSupply',
      transaction: {
        to: '0xPoolAddress' as `0x${string}`,
        data: '0xsupplydata' as `0x${string}`,
        value: BigInt(0),
      },
    };

    buildTransactionsForActionSpy
      .mockResolvedValueOnce([])  // DexSwap returns empty (already completed)
      .mockResolvedValueOnce([mockSupplyTx]);

    await executeDestinationCallbacks(mockContext);

    // Verify buildTransactionsForAction was called twice (once per action)
    expect(buildTransactionsForActionSpy).toHaveBeenCalledTimes(2);

    // First call should use original amount
    expect(buildTransactionsForActionSpy.mock.calls[0][1]).toBe(mockAction1.amount);

    // Second call (AaveSupply) should receive maxUint256 so it uses on-chain balance
    const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    expect(buildTransactionsForActionSpy.mock.calls[1][1]).toBe(MAX_UINT256);

    // Only the supply transaction should have been submitted (swap was skipped)
    expect(submitTransactionStub.calledOnce).toBe(true);

    // Verify operation was marked COMPLETED
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(true);
  });

  it('should leave operation as AWAITING_POST_BRIDGE on failure for retry', async () => {
    mockConfig.routes = [
      {
        asset: '0xEthAddress1',
        origin: 1,
        destination: 10,
        postBridgeActions: [
          {
            type: PostBridgeActionType.AaveSupply,
            poolAddress: '0xPoolAddress',
            supplyAsset: '0xEthAddress10',
          },
        ],
      },
    ] as unknown as typeof mockConfig.routes;

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

    buildTransactionsForActionSpy.mockRejectedValueOnce(new Error('Quote service down'));

    await executeDestinationCallbacks(mockContext);

    // Should NOT be marked as COMPLETED
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
        status: RebalanceOperationStatus.COMPLETED,
      }),
    ).toBe(false);

    // Should log error for retry
    const errorCall = mockLogger.error
      .getCalls()
      .find((call) => call.args[0] === 'Failed to execute post-bridge actions, will retry');
    expect(errorCall).toBeDefined();
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

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true); // Include receipt
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockChainService.getTransactionReceipt.resolves(toITransactionReceipt(mockReceipt1));
    mockRebalanceAdapter.getAdapter.callsFake(() => {
      // Return the same mock adapter for all bridges
      return mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>;
    });
    // Note: readyOnDestination is not called for AWAITING_CALLBACK status
    mockSpecificBridgeAdapter.destinationCallback.resolves(callbackWithUndefinedValue);
    submitTransactionStub.resolves({
      hash: mockSubmitSuccessReceipt.transactionHash,
      submissionType: TransactionSubmissionType.Onchain,
      receipt: mockChainServiceReceipt,
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

  it('should retain operation when isCallbackComplete returns false (multi-step bridge)', async () => {
    const isCallbackCompleteStub = stub().resolves(false);
    const multiStepAdapter = {
      ...mockSpecificBridgeAdapter,
      isCallbackComplete: isCallbackCompleteStub,
    };

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockRebalanceAdapter.getAdapter.callsFake(() => multiStepAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    multiStepAdapter.destinationCallback.resolves(mockCallbackTx);

    await executeDestinationCallbacks(mockContext);

    expect(submitTransactionStub.calledOnce).toBe(true);
    expect(isCallbackCompleteStub.calledOnce).toBe(true);
    // Should NOT mark as completed
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(
        mockAction1Id,
        sinon.match({ status: RebalanceOperationStatus.COMPLETED }),
      ),
    ).toBe(false);
    const infoCall = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'Callback submitted but process not yet complete, retaining for next iteration');
    expect(infoCall).toBeDefined();
  });

  it('should complete operation when isCallbackComplete returns true', async () => {
    const isCallbackCompleteStub = stub().resolves(true);
    const multiStepAdapter = {
      ...mockSpecificBridgeAdapter,
      isCallbackComplete: isCallbackCompleteStub,
    };

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockRebalanceAdapter.getAdapter.callsFake(() => multiStepAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    multiStepAdapter.destinationCallback.resolves(mockCallbackTx);

    await executeDestinationCallbacks(mockContext);

    expect(submitTransactionStub.calledOnce).toBe(true);
    expect(isCallbackCompleteStub.calledOnce).toBe(true);
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(
        mockAction1Id,
        sinon.match({ status: RebalanceOperationStatus.COMPLETED }),
      ),
    ).toBe(true);
  });

  it('should complete operation as fail-safe when isCallbackComplete throws', async () => {
    const isCallbackCompleteStub = stub().rejects(new Error('RPC error'));
    const multiStepAdapter = {
      ...mockSpecificBridgeAdapter,
      isCallbackComplete: isCallbackCompleteStub,
    };

    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockRebalanceAdapter.getAdapter.callsFake(() => multiStepAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    multiStepAdapter.destinationCallback.resolves(mockCallbackTx);

    await executeDestinationCallbacks(mockContext);

    expect(submitTransactionStub.calledOnce).toBe(true);
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(
        mockAction1Id,
        sinon.match({ status: RebalanceOperationStatus.COMPLETED }),
      ),
    ).toBe(true);
    const warnCall = mockLogger.warn
      .getCalls()
      .find((call) => call.args[0] === 'isCallbackComplete check failed, completing as fail-safe');
    expect(warnCall).toBeDefined();
  });

  it('should complete operation when adapter has no isCallbackComplete (backward compat)', async () => {
    // The default mockSpecificBridgeAdapter has no isCallbackComplete
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, true);
    dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
    (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
    mockSpecificBridgeAdapter.destinationCallback.resolves(mockCallbackTx);

    await executeDestinationCallbacks(mockContext);

    expect(submitTransactionStub.calledOnce).toBe(true);
    expect(
      (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(
        mockAction1Id,
        sinon.match({ status: RebalanceOperationStatus.COMPLETED }),
      ),
    ).toBe(true);
  });

  describe('findMatchingRoute on-demand fallback', () => {
    // Use USDC 1→137 for on-demand tests (chain assets already in mockConfig)
    const onDemandAction: RebalanceAction = {
      asset: 'USDC',
      origin: 1,
      destination: 137,
      bridge: 'Across' as SupportedBridge,
      transaction: '0xtxhash_od',
      amount: '5000000',
      recipient: '0x1234567890123456789012345678901234567890',
    };
    const onDemandOpId = 'od-action-1';

    it('should match on-demand route with postBridgeActions when no regular route matches', async () => {
      // No regular route for USDC 1→137
      mockConfig.routes = [] as unknown as typeof mockConfig.routes;
      // On-demand route WITH postBridgeActions
      mockConfig.onDemandRoutes = [
        {
          asset: '0xUsdcAddress1',
          origin: 1,
          destination: 137,
          postBridgeActions: [
            {
              type: PostBridgeActionType.DexSwap,
              sellToken: '0xUsdcAddress137',
              buyToken: '0xUSDe',
              slippageBps: 50,
            },
          ],
        },
      ] as unknown as typeof mockConfig.onDemandRoutes;

      const dbOperation = createDbOperation(onDemandAction, onDemandOpId, true);
      dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

      const mockSwapTx = {
        memo: 'DexSwap',
        transaction: { to: '0xRouter' as `0x${string}`, data: '0x' as `0x${string}`, value: BigInt(0) },
        effectiveAmount: '5000000000000000000',
      };
      buildTransactionsForActionSpy.mockResolvedValueOnce([mockSwapTx]);

      await executeDestinationCallbacks(mockContext);

      // Should have found the on-demand route and executed post-bridge action
      expect(buildTransactionsForActionSpy).toHaveBeenCalledTimes(1);
      expect(submitTransactionStub.calledOnce).toBe(true);
      expect(
        (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(onDemandOpId, {
          status: RebalanceOperationStatus.COMPLETED,
        }),
      ).toBe(true);
    });

    it('should NOT match on-demand route without postBridgeActions', async () => {
      // No regular route for USDC 1→137
      mockConfig.routes = [] as unknown as typeof mockConfig.routes;
      // On-demand route WITHOUT postBridgeActions
      mockConfig.onDemandRoutes = [
        {
          asset: '0xUsdcAddress1',
          origin: 1,
          destination: 137,
          // No postBridgeActions
        },
      ] as unknown as typeof mockConfig.onDemandRoutes;

      const dbOperation = createDbOperation(onDemandAction, onDemandOpId, true);
      dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

      await executeDestinationCallbacks(mockContext);

      // Should NOT execute any post-bridge actions
      expect(buildTransactionsForActionSpy).not.toHaveBeenCalled();
      // Should mark as COMPLETED (no actions found)
      expect(
        (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(onDemandOpId, {
          status: RebalanceOperationStatus.COMPLETED,
        }),
      ).toBe(true);
      // Should log warning about no actions configured
      const warnCall = mockLogger.warn
        .getCalls()
        .find((call) => call.args[0] === 'Operation awaiting post-bridge actions but no actions configured, marking completed');
      expect(warnCall).toBeDefined();
    });

    it('should NOT match on-demand route with empty postBridgeActions array', async () => {
      mockConfig.routes = [] as unknown as typeof mockConfig.routes;
      mockConfig.onDemandRoutes = [
        {
          asset: '0xUsdcAddress1',
          origin: 1,
          destination: 137,
          postBridgeActions: [], // Empty array
        },
      ] as unknown as typeof mockConfig.onDemandRoutes;

      const dbOperation = createDbOperation(onDemandAction, onDemandOpId, true);
      dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

      await executeDestinationCallbacks(mockContext);

      expect(buildTransactionsForActionSpy).not.toHaveBeenCalled();
      expect(
        (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(onDemandOpId, {
          status: RebalanceOperationStatus.COMPLETED,
        }),
      ).toBe(true);
    });

    it('should prefer regular route over on-demand route for same pathway', async () => {
      // Regular route for USDC 1→137 with AaveSupply
      mockConfig.routes = [
        {
          asset: '0xUsdcAddress1',
          origin: 1,
          destination: 137,
          postBridgeActions: [
            {
              type: PostBridgeActionType.AaveSupply,
              poolAddress: '0xRegularPool',
              supplyAsset: '0xUsdcAddress137',
            },
          ],
        },
      ] as unknown as typeof mockConfig.routes;
      // On-demand route for same pathway with DexSwap
      mockConfig.onDemandRoutes = [
        {
          asset: '0xUsdcAddress1',
          origin: 1,
          destination: 137,
          postBridgeActions: [
            {
              type: PostBridgeActionType.DexSwap,
              sellToken: '0xUsdcAddress137',
              buyToken: '0xUSDe',
              slippageBps: 50,
            },
          ],
        },
      ] as unknown as typeof mockConfig.onDemandRoutes;

      const dbOperation = createDbOperation(onDemandAction, onDemandOpId, true);
      dbOperation.status = RebalanceOperationStatus.AWAITING_POST_BRIDGE;
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });

      const mockSupplyTx = {
        memo: 'AaveSupply',
        transaction: { to: '0xRegularPool' as `0x${string}`, data: '0x' as `0x${string}`, value: BigInt(0) },
      };
      buildTransactionsForActionSpy.mockResolvedValueOnce([mockSupplyTx]);

      await executeDestinationCallbacks(mockContext);

      // Should use the regular route's AaveSupply action, not the on-demand DexSwap
      expect(buildTransactionsForActionSpy).toHaveBeenCalledTimes(1);
      const actionArg = buildTransactionsForActionSpy.mock.calls[0][3];
      expect(actionArg.type).toBe(PostBridgeActionType.AaveSupply);
      expect(actionArg.poolAddress).toBe('0xRegularPool');
    });

    it('should transition on-demand operation to AWAITING_POST_BRIDGE when callback completes', async () => {
      // No regular route — only on-demand with postBridgeActions
      mockConfig.routes = [] as unknown as typeof mockConfig.routes;
      mockConfig.onDemandRoutes = [
        {
          asset: '0xUsdcAddress1',
          origin: 1,
          destination: 137,
          postBridgeActions: [
            {
              type: PostBridgeActionType.DexSwap,
              sellToken: '0xUsdcAddress137',
              buyToken: '0xUSDe',
              slippageBps: 50,
            },
          ],
        },
      ] as unknown as typeof mockConfig.onDemandRoutes;

      const dbOperation = createDbOperation(onDemandAction, onDemandOpId, true);
      dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({ operations: [dbOperation], total: 1 });
      // No callback needed — triggers resolvePostBridgeStatus
      mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);

      await executeDestinationCallbacks(mockContext);

      // Should transition to AWAITING_POST_BRIDGE (not COMPLETED) because on-demand route has actions
      expect(
        (mockDatabase.updateRebalanceOperation as SinonStub).calledWith(onDemandOpId, {
          status: RebalanceOperationStatus.AWAITING_POST_BRIDGE,
        }),
      ).toBe(true);
    });
  });
});
