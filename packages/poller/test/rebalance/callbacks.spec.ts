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
import { executeDestinationCallbacks } from '../../src/rebalance/callbacks';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceAction } from '@mark/core';
import * as submitTransactionModule from '../../src/helpers/transactions';
import { RebalanceAdapter } from '@mark/rebalance';

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
    const dbOperation = createDbOperation(mockAction1, mockAction1Id, false); // No receipt in metadata
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);

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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);

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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);

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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
    mockSpecificBridgeAdapter.destinationCallback.resolves(undefined);

    await executeDestinationCallbacks(mockContext);

    const infoCallWithMessage = mockLogger.info
      .getCalls()
      .find((call) => call.args[0] === 'No destination callback required, marking as completed');
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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);

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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation1, dbOperation2]);

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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperationNoBridge]);

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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperationNoTxHash]);

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
    (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
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
});
