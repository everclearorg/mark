import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub, match } from 'sinon';
import { MarkConfiguration, SupportedBridge, TransactionSubmissionType, RebalanceOperationStatus } from '@mark/core';
import { Logger, jsonifyError } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceCache, RebalanceAction } from '@mark/cache';
import * as submitTransactionModule from '../../src/helpers/transactions';
import { RebalanceAdapter } from '@mark/rebalance';
import { executeDestinationCallbacks } from '../../src/rebalance/callbacks';

// Define the interface for the specific adapter methods needed
interface MockBridgeAdapter {
    readyOnDestination: SinonStub<[string, Route, any /* ITransactionReceipt */], Promise<boolean>>;
    destinationCallback: SinonStub<[Route, any /* ITransactionReceipt */], Promise<any>>;
}

interface Route {
    asset: string;
    origin: number;
    destination: number;
}

describe('executeDestinationCallbacks', () => {
    let mockContext: SinonStubbedInstance<ProcessingContext>;
    let mockLogger: SinonStubbedInstance<Logger>;
    let mockRebalanceCache: SinonStubbedInstance<RebalanceCache>;
    let mockChainService: SinonStubbedInstance<ChainService>;
    let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
    let mockSpecificBridgeAdapter: MockBridgeAdapter;
    let submitTransactionStub: SinonStub;
    let mockDatabase: any;

    let mockConfig: MarkConfiguration;
    
    // Helper to create database operation from action
    const createDbOperation = (action: any, id: string) => ({
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

    const mockRoute1: Route = {
        asset: mockAction1.asset,
        origin: mockAction1.origin,
        destination: mockAction1.destination,
    };

    // Using any for mockReceipt1 to simplify type issues for now
    const mockReceipt1: any = {
        to: '0xcontract',
        from: '0xsender',
        contractAddress: null,
        transactionIndex: 1,
        gasUsed: '21000',
        blockHash: '0xblockhash1',
        transactionHash: mockAction1.transaction,
        logs: [],
        blockNumber: 123,
        status: 1,
    };

    const mockCallbackTx = {
        transaction: {
            to: '0xDestinationContract',
            data: '0xcallbackdata',
            value: '0',
        },
        memo: 'Callback'
    };

    // submitAndMonitor should resolve with a receipt-like object
    const mockSubmitSuccessReceipt: any = {
        transactionHash: '0xDestTxHashSuccess',
        status: 1,
        blockNumber: 234
    };

    beforeEach(() => {
        mockLogger = createStubInstance(Logger);
        mockRebalanceCache = createStubInstance(RebalanceCache);
        mockChainService = createStubInstance(ChainService);
        mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
        mockSpecificBridgeAdapter = {
            readyOnDestination: stub<[string, Route, any /* ITransactionReceipt */], Promise<boolean>>(),
            destinationCallback: stub<[Route, any /* ITransactionReceipt */], Promise<any>>(),
        };

        // Create mock database module
        mockDatabase = {
            getRebalanceOperations: stub().resolves([]),
            updateRebalanceOperation: stub().resolves(),
            queryWithClient: stub().resolves(),
            // Add other database exports as stubs if needed
            initializeDatabase: stub(),
            closeDatabase: stub(),
        };

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
                '10': { providers: ['http://optimismprovider'] }
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
        mockRebalanceAdapter.getAdapter.returns(mockSpecificBridgeAdapter as any);
        mockChainService.getTransactionReceipt.resolves(undefined);
        mockSpecificBridgeAdapter.readyOnDestination.resolves(false);
        mockSpecificBridgeAdapter.destinationCallback.resolves(null);
        mockChainService.submitAndMonitor.resolves(mockSubmitSuccessReceipt);
        submitTransactionStub = stub(submitTransactionModule, 'submitTransactionWithLogging').resolves({
            hash: mockSubmitSuccessReceipt.transactionHash,
            receipt: mockSubmitSuccessReceipt,
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
        expect(mockLogger.info.calledWith('Executing destination callbacks', { requestId: MOCK_REQUEST_ID })).to.be.true;
        expect((mockDatabase.getRebalanceOperations as SinonStub).calledWith({
            status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK]
        })).to.be.true;
        expect(mockChainService.getTransactionReceipt.called).to.be.false;
    });

    it('should log and continue if transaction receipt is not found for an action', async () => {
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([{
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
        }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(undefined);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(mockLogger.info.calledWith('Origin transaction receipt not found for operation', match({ requestId: MOCK_REQUEST_ID }))).to.be.true;
        expect(mockSpecificBridgeAdapter.readyOnDestination.called).to.be.false;
    });

    it('should log error and continue if getTransactionReceipt fails', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        
        const error = new Error('RPC error');
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).rejects(error);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(mockLogger.error.calledWith('Failed to get transaction receipt', match({ 
            requestId: MOCK_REQUEST_ID, 
            error: match.any 
        }))).to.be.true;
        expect(mockSpecificBridgeAdapter.readyOnDestination.called).to.be.false;
    });

    it('should log info if readyOnDestination returns false', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.resolves(false);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(mockLogger.info.calledWith('Action not ready for destination callback', match({ requestId: MOCK_REQUEST_ID }))).to.be.true;
        expect((mockDatabase.updateRebalanceOperation as SinonStub).called).to.be.false;
    });

    it('should log error and continue if readyOnDestination fails', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        
        const error = new Error('Bridge error');
        mockSpecificBridgeAdapter.readyOnDestination.rejects(error);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(mockLogger.error.calledWith('Failed to check if ready on destination', match({ 
            requestId: MOCK_REQUEST_ID,
            error: match.any
        }))).to.be.true;
        expect(mockSpecificBridgeAdapter.destinationCallback.called).to.be.false;
    });

    it('should mark as completed if destinationCallback returns no transaction', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.destinationCallback.resolves(null);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(mockLogger.info.calledWith('No destination callback required, marking as completed', match({ requestId: MOCK_REQUEST_ID }))).to.be.true;
        expect((mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
            status: RebalanceOperationStatus.COMPLETED,
        })).to.be.true;
    });

    it('should log error and continue if destinationCallback fails', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        
        const error = new Error('Callback error');
        mockSpecificBridgeAdapter.destinationCallback.rejects(error);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(mockLogger.error.calledWith('Failed to retrieve destination callback', match({ 
            requestId: MOCK_REQUEST_ID,
            error: match.any
        }))).to.be.true;
        expect(submitTransactionStub.called).to.be.false;
    });

    it('should successfully execute destination callback and mark as completed', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.destinationCallback.resolves(mockCallbackTx);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(submitTransactionStub.calledOnce).to.be.true;
        expect(mockLogger.info.calledWith('Successfully submitted destination callback', match({
            requestId: MOCK_REQUEST_ID,
            destinationTx: mockSubmitSuccessReceipt.transactionHash,
        }))).to.be.true;
        expect((mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, match({
            status: RebalanceOperationStatus.COMPLETED,
            txHashes: match.object,
        }))).to.be.true;
    });

    it('should log error and continue if submitAndMonitor fails', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.destinationCallback.resolves(mockCallbackTx);
        
        const error = new Error('Submit failed');
        submitTransactionStub.rejects(error);
        
        await executeDestinationCallbacks(mockContext);
        
        expect(mockLogger.error.calledWith('Failed to execute destination callback', match({
            requestId: MOCK_REQUEST_ID,
            error: match.any,
        }))).to.be.true;
        expect((mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, match({
            status: RebalanceOperationStatus.COMPLETED,
        }))).to.be.false;
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
        const mockReceipt2: any = {
            ...mockReceipt1,
            transactionHash: mockAction2.transaction,
        };

        const dbOperation1 = createDbOperation(mockAction1, mockAction1Id);
        const dbOperation2 = createDbOperation(mockAction2, mockAction2Id);
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation1, dbOperation2]);
        
        // First action fails to get receipt
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).rejects(new Error('RPC error'));
        
        // Second action succeeds
        mockChainService.getTransactionReceipt.withArgs(mockAction2.origin, mockAction2.transaction).resolves(mockReceipt2);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction2.amount, match.any, mockReceipt2).resolves(true);
        
        await executeDestinationCallbacks(mockContext);
        
        // Should have logged error for first action
        expect(mockLogger.error.calledWith('Failed to get transaction receipt', match({ operationId: mockAction1Id }))).to.be.true;
        
        // Should have processed second action
        expect((mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction2Id, {
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
        })).to.be.true;
    });

    it('should update operation to awaiting callback when ready', async () => {
        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.resolves(true);
        
        await executeDestinationCallbacks(mockContext);
        
        expect((mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, {
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
        })).to.be.true;
        expect(mockLogger.info.calledWith('Operation ready for callback, updated status', match({
            requestId: MOCK_REQUEST_ID,
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
        }))).to.be.true;
    });

    it('should query to expire old operations', async () => {
        await executeDestinationCallbacks(mockContext);
        
        expect((mockDatabase.queryWithClient as SinonStub).calledOnce).to.be.true;
        const [query, params] = (mockDatabase.queryWithClient as SinonStub).firstCall.args;
        expect(query).to.include('UPDATE rebalance_operations');
        expect(query).to.include('INTERVAL \'24 hours\'');
        expect(params![0]).to.equal(RebalanceOperationStatus.EXPIRED);
        expect(params![1]).to.deep.equal([RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK]);
    });

    it('should handle callback transaction with undefined value', async () => {
        const callbackWithUndefinedValue = {
            transaction: {
                to: '0xDestinationContract',
                data: '0xcallbackdata',
                // value is undefined
            },
            memo: 'Callback'
        };

        const dbOperation = createDbOperation(mockAction1, mockAction1Id);
        dbOperation.status = RebalanceOperationStatus.AWAITING_CALLBACK;
        (mockDatabase.getRebalanceOperations as SinonStub).resolves([dbOperation]);
        mockChainService.getTransactionReceipt.resolves(mockReceipt1);
        mockRebalanceAdapter.getAdapter.returns(mockSpecificBridgeAdapter as any);
        mockSpecificBridgeAdapter.readyOnDestination.resolves(true);
        mockSpecificBridgeAdapter.destinationCallback.resolves(callbackWithUndefinedValue);
        submitTransactionStub.resolves({
            hash: mockSubmitSuccessReceipt.transactionHash,
            submissionType: TransactionSubmissionType.Onchain,
            receipt: mockSubmitSuccessReceipt,
        });

        await executeDestinationCallbacks(mockContext);

        // Verify the transaction was called with value defaulting to '0'
        expect(submitTransactionStub.calledOnce).to.be.true;
        const callArgs = submitTransactionStub.firstCall.args[0];
        expect(callArgs.txRequest.value).to.equal('0');
        expect((mockDatabase.updateRebalanceOperation as SinonStub).calledWith(mockAction1Id, match({
            status: RebalanceOperationStatus.COMPLETED,
        }))).to.be.true;
    });
});
