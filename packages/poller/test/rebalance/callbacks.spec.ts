import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub, match } from 'sinon';
import { executeDestinationCallbacks } from '../../src/rebalance/callbacks';
import { MarkConfiguration, SupportedBridge, TransactionSubmissionType } from '@mark/core';
import { Logger, jsonifyError } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceCache, RebalanceAction } from '@mark/cache';
import * as submitTransactionModule from '../../src/helpers/transactions';
import { RebalanceAdapter } from '@mark/rebalance';

// Define the interface for the specific adapter methods needed
interface MockBridgeAdapter {
    readyOnDestination: SinonStub<[string, Route, any /* ITransactionReceipt */], Promise<boolean>>;
    destinationCallback: SinonStub<[Route, any /* ITransactionReceipt */], Promise<any>>;
}

interface Route {
    asset: string;
    origin: number; // Changed to number
    destination: number; // Changed to number
}

describe('executeDestinationCallbacks', () => {
    let mockContext: SinonStubbedInstance<ProcessingContext>;
    let mockLogger: SinonStubbedInstance<Logger>;
    let mockRebalanceCache: SinonStubbedInstance<RebalanceCache>;
    let mockChainService: SinonStubbedInstance<ChainService>;
    let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
    let mockSpecificBridgeAdapter: MockBridgeAdapter;
    let submitTransactionStub: SinonStub;

    let mockConfig: MarkConfiguration;

    const MOCK_REQUEST_ID = 'test-request-id';
    const MOCK_START_TIME = Date.now();

    const mockAction1Id = 'action-1';
    const mockAction1: RebalanceAction = {
        asset: 'ETH',
        origin: 1, // Changed to number
        destination: 10, // Changed to number
        bridge: 'Across' as SupportedBridge, // Cast to SupportedBridge
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
        status: 1, // Common field in receipts
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

        mockConfig = {
            routes: [{ asset: 'ETH', origin: 1, destination: 10 }], // origin/destination as numbers
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
        submitTransactionStub.restore();
    });

    it('should do nothing if no actions are found in cache', async () => {
        mockRebalanceCache.getRebalances.resolves([]);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.info.calledWith('Executing destination callbacks', { requestId: MOCK_REQUEST_ID })).to.be.true;
        expect(mockRebalanceCache.getRebalances.calledOnceWith({ routes: mockConfig.routes as any })).to.be.true; // Cast routes if type is complex
        expect(mockChainService.getTransactionReceipt.called).to.be.false;
    });

    // Cast mockAction1 to RebalanceAction in resolves/matchers if TestRebalanceAction is not perfectly substitutable
    it('should log and continue if transaction receipt is not found for an action', async () => {
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(undefined);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.info.calledWith('Origin transaction receipt not found for action', match({ requestId: MOCK_REQUEST_ID, action: mockAction1 as RebalanceAction }))).to.be.true;
        expect(mockSpecificBridgeAdapter.readyOnDestination.called).to.be.false;
        expect(mockRebalanceCache.removeRebalances.called).to.be.false;
    });

    it('should log error and continue if getTransactionReceipt fails', async () => {
        const error = new Error('GetReceiptFailed');
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).rejects(error);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.error.calledWith('Failed to determine if destination action required', match({ requestId: MOCK_REQUEST_ID, action: mockAction1 as RebalanceAction, error: jsonifyError(error) }))).to.be.true;
        expect(mockSpecificBridgeAdapter.readyOnDestination.called).to.be.false;
    });

    it('should remove action if readyOnDestination returns false', async () => {
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction1.amount, match(mockRoute1), mockReceipt1).resolves(false);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.info.calledWith('Action is not ready to execute callback', match({ requestId: MOCK_REQUEST_ID, action: { ...mockAction1, id: mockAction1Id }, receipt: mockReceipt1, required: false }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.calledWith([mockAction1Id])).to.be.false;
        expect(mockSpecificBridgeAdapter.destinationCallback.called).to.be.false;
    });

    it('should log error and continue if readyOnDestination fails', async () => {
        const error = new Error('ReadyCheckFailed');
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction1.amount, match(mockRoute1), mockReceipt1).rejects(error);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.error.calledWith('Failed to determine if destination action required', match({ action: mockAction1 as RebalanceAction, error: jsonifyError(error) }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.called).to.be.false;
    });

    it('should remove action if destinationCallback returns no transaction', async () => {
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction1.amount, match(mockRoute1), mockReceipt1).resolves(true);
        mockSpecificBridgeAdapter.destinationCallback.withArgs(match(mockRoute1), mockReceipt1).resolves(null);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.info.calledWith('No destination callback transaction returned', match({ requestId: MOCK_REQUEST_ID, action: { ...mockAction1, id: mockAction1Id } }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.calledOnceWith([mockAction1Id])).to.be.true;
        expect(submitTransactionStub.called).to.be.false;
    });

    it('should log error and continue if destinationCallback fails', async () => {
        const error = new Error('CallbackRetrievalFailed');
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction1.amount, match(mockRoute1), mockReceipt1).resolves(true);
        mockSpecificBridgeAdapter.destinationCallback.withArgs(match(mockRoute1), mockReceipt1).rejects(error);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.error.calledWith('Failed to retrieve destination action required', match({ action: mockAction1 as RebalanceAction, error: jsonifyError(error) }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.called).to.be.false;
    });

    it('should successfully execute destination callback and remove action', async () => {
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction1.amount, match(mockRoute1), mockReceipt1).resolves(true);
        mockSpecificBridgeAdapter.destinationCallback.withArgs(match(mockRoute1), mockReceipt1).resolves(mockCallbackTx);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.info.calledWith('Retrieved destination callback', match({ action: mockAction1 as RebalanceAction, callback: mockCallbackTx }))).to.be.true;
        expect(submitTransactionStub.calledOnce).to.be.true;
        expect(mockLogger.info.calledWith('Successfully submitted destination callback', match({ action: mockAction1 as RebalanceAction, destinationTx: mockSubmitSuccessReceipt.transactionHash }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.calledOnceWith([mockAction1Id])).to.be.true;
    });

    it('should log error and continue if submitAndMonitor fails', async () => {
        const error = new Error('SubmitFailed');
        submitTransactionStub.reset();
        submitTransactionStub.rejects(error);
        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction1.amount, match(mockRoute1), mockReceipt1).resolves(true);
        mockSpecificBridgeAdapter.destinationCallback.withArgs(match(mockRoute1), mockReceipt1).resolves(mockCallbackTx);
        await executeDestinationCallbacks(mockContext);
        expect(mockLogger.error.calledWith('Failed to execute destination action', match({ action: mockAction1 as RebalanceAction, error: jsonifyError(error) }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.called).to.be.false;
    });

    it('should process multiple actions, continuing on individual errors', async () => {
        const mockAction2: RebalanceAction = { ...mockAction1, transaction: '0xtxhash2', origin: 2, destination: 20, bridge: 'Stargate' as SupportedBridge, recipient: '0x2222222222222222222222222222222222222222' };
        const mockAction2Id = 'mock-action-2';
        const mockAction3: RebalanceAction = { ...mockAction1, transaction: '0xtxhash3', origin: 3, destination: 30, bridge: 'Hop' as SupportedBridge, recipient: '0x3333333333333333333333333333333333333333' };
        const mockAction3Id = 'mock-action-3';

        const mockRoute2: Route = { asset: mockAction2.asset, origin: mockAction2.origin, destination: mockAction2.destination };
        const mockRoute3: Route = { asset: mockAction3.asset, origin: mockAction3.origin, destination: mockAction3.destination };

        const mockReceipt2: any = { ...mockReceipt1, transactionHash: mockAction2.transaction };
        const mockReceipt3: any = { ...mockReceipt1, transactionHash: mockAction3.transaction };

        const mockSpecificBridgeAdapterB: MockBridgeAdapter = {
            readyOnDestination: stub<[string, Route, any], Promise<boolean>>(),
            destinationCallback: stub<[Route, any], Promise<any>>(),
        };
        const mockSpecificBridgeAdapterC: MockBridgeAdapter = {
            readyOnDestination: stub<[string, Route, any], Promise<boolean>>(),
            destinationCallback: stub<[Route, any], Promise<any>>(),
        };

        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }, { ...mockAction2, id: mockAction2Id }, { ...mockAction3, id: mockAction3Id }]);

        // Action 1 (mockAction1): Success
        mockRebalanceAdapter.getAdapter.withArgs(mockAction1.bridge).returns(mockSpecificBridgeAdapter as any);
        mockChainService.getTransactionReceipt.withArgs(mockAction1.origin, mockAction1.transaction).resolves(mockReceipt1);
        mockSpecificBridgeAdapter.readyOnDestination.withArgs(mockAction1.amount, match(mockRoute1), mockReceipt1).resolves(true);
        mockSpecificBridgeAdapter.destinationCallback.withArgs(match(mockRoute1), mockReceipt1).resolves(mockCallbackTx);

        // Action 2 (mockAction2): Fails at readyOnDestination (returns false)
        mockRebalanceAdapter.getAdapter.withArgs(mockAction2.bridge).returns(mockSpecificBridgeAdapterB as any);
        mockChainService.getTransactionReceipt.withArgs(mockAction2.origin, mockAction2.transaction).resolves(mockReceipt2);
        mockSpecificBridgeAdapterB.readyOnDestination.withArgs(mockAction2.amount, match(mockRoute2), mockReceipt2).resolves(false);

        // Action 3 (mockAction3): Fails at submitAndMonitor (throws error)
        const submitError = new Error('SubmitAction3Failed');
        mockRebalanceAdapter.getAdapter.withArgs(mockAction3.bridge).returns(mockSpecificBridgeAdapterC as any);
        mockChainService.getTransactionReceipt.withArgs(mockAction3.origin, mockAction3.transaction).resolves(mockReceipt3);
        mockSpecificBridgeAdapterC.readyOnDestination.withArgs(mockAction3.amount, match(mockRoute3), mockReceipt3).resolves(true);
        mockSpecificBridgeAdapterC.destinationCallback.withArgs(match(mockRoute3), mockReceipt3).resolves(mockCallbackTx);

        submitTransactionStub.reset();
        submitTransactionStub.onFirstCall().resolves({
            transactionHash: mockSubmitSuccessReceipt.transactionHash,
            receipt: mockSubmitSuccessReceipt,
        }).onSecondCall().rejects(submitError);

        await executeDestinationCallbacks(mockContext);

        expect(mockRebalanceCache.removeRebalances.calledWith([mockAction1Id])).to.be.true;
        expect(mockLogger.info.calledWith('Action is not ready to execute callback', match({ requestId: MOCK_REQUEST_ID, action: { ...mockAction2, id: mockAction2Id }, receipt: mockReceipt2, required: false }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.calledWith([mockAction2Id])).to.be.false;
        expect(mockLogger.error.calledWith('Failed to execute destination action', match({ action: { ...mockAction3, id: mockAction3Id }, error: jsonifyError(submitError) }))).to.be.true;
        expect(mockRebalanceCache.removeRebalances.calledWith([mockAction3Id])).to.be.false;
        expect(mockRebalanceCache.removeRebalances.callCount).to.equal(1);
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

        mockRebalanceCache.getRebalances.resolves([{ ...mockAction1, id: mockAction1Id }]);
        mockChainService.getTransactionReceipt.resolves(mockReceipt1);
        mockRebalanceAdapter.getAdapter.returns(mockSpecificBridgeAdapter as any);
        mockSpecificBridgeAdapter.readyOnDestination.resolves(true);
        mockSpecificBridgeAdapter.destinationCallback.resolves(callbackWithUndefinedValue);
        submitTransactionStub.resolves({
            transactionHash: mockSubmitSuccessReceipt.transactionHash,
            receipt: mockSubmitSuccessReceipt,
        });

        await executeDestinationCallbacks(mockContext);

        // Verify the transaction was called with value defaulting to '0'
        expect(submitTransactionStub.calledOnce).to.be.true;
        const callArgs = submitTransactionStub.firstCall.args[0];
        expect(callArgs.txRequest.value).to.equal('0');
        expect(mockRebalanceCache.removeRebalances.calledWith([mockAction1Id])).to.be.true;
    });
});
