import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub, match, restore } from 'sinon';
import { rebalanceInventory } from '../../src/rebalance/rebalance';
import * as balanceHelpers from '../../src/helpers/balance';
import * as contractHelpers from '../../src/helpers/contracts';
import * as callbacks from '../../src/rebalance/callbacks'; // To mock executeDestinationCallbacks
import * as erc20Helper from '../../src/helpers/erc20';
import * as transactionHelper from '../../src/helpers/transactions';
import { MarkConfiguration, SupportedBridge, RebalanceRoute, RouteRebalancingConfig, TransactionSubmissionType } from '@mark/core';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceCache, RebalanceAction } from '@mark/cache';
import { RebalanceAdapter } from '@mark/rebalance';
import { PrometheusAdapter } from '@mark/prometheus';
import { TransactionRequest as ViemTransactionRequest, zeroAddress, Hex, erc20Abi } from 'viem'; // For adapter.send return type
import { providers } from 'ethers';


interface MockBridgeAdapterInterface {
    getReceivedAmount: SinonStub<[string, RebalanceRoute], Promise<string>>;
    send: SinonStub<[string, string, string, RebalanceRoute], Promise<ViemTransactionRequest>>;
    type: SinonStub<[], SupportedBridge>;
    // Add other methods if they are called by the SUT
}

describe('rebalanceInventory', () => {
    let mockContext: SinonStubbedInstance<ProcessingContext>;
    let mockLogger: SinonStubbedInstance<Logger>;
    let mockRebalanceCache: SinonStubbedInstance<RebalanceCache>;
    let mockChainService: SinonStubbedInstance<ChainService>;
    let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
    let mockPrometheus: SinonStubbedInstance<PrometheusAdapter>;
    let mockSpecificBridgeAdapter: MockBridgeAdapterInterface;

    // Stubs for module functions. These will be Sinon stubs.
    let executeDestinationCallbacksStub: SinonStub;
    let getMarkBalancesStub: SinonStub;
    let getERC20ContractStub: SinonStub;
    let checkAndApproveERC20Stub: SinonStub;
    let submitTransactionWithLoggingStub: SinonStub;

    const MOCK_REQUEST_ID = 'rebalance-request-id';
    const MOCK_OWN_ADDRESS = '0xOwnerAddress' as `0x${string}`;
    const MOCK_ASSET_ERC20 = '0xErc20AssetAddress' as `0x${string}`;
    const MOCK_ASSET_NATIVE = zeroAddress;
    const MOCK_BRIDGE_TYPE_A = SupportedBridge.Across;
    const MOCK_BRIDGE_TYPE_B: SupportedBridge = 'stargate' as SupportedBridge;
    const MOCK_BRIDGE_A_SPENDER = '0x25d07db6a8b00bb1d8745de4b34e8bdee59e871c' as `0x${string}`;
    const MOCK_APPROVE_DATA = '0x095ea7b3' as Hex; // Example data for approve

    const MOCK_ERC20_TICKER_HASH = '0xerc20tickerhashtest' as `0x${string}`; // Added
    const MOCK_NATIVE_TICKER_HASH = '0xnativetickerhashtest' as `0x${string}`; // Added

    beforeEach(() => {
        mockLogger = createStubInstance(Logger);
        mockRebalanceCache = createStubInstance(RebalanceCache);
        mockChainService = createStubInstance(ChainService);
        mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
        mockPrometheus = createStubInstance(PrometheusAdapter);

        // Create a fully stubbed object for the interface
        mockSpecificBridgeAdapter = {
            getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
            send: stub<[string, string, string, RebalanceRoute], Promise<ViemTransactionRequest>>(),
            type: stub<[], SupportedBridge>(),
        };

        // Stub helper functions using sinon.replace for ESM compatibility
        executeDestinationCallbacksStub = stub(callbacks, 'executeDestinationCallbacks').resolves();
        getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances').resolves(new Map());
        getERC20ContractStub = stub(contractHelpers, 'getERC20Contract');
        checkAndApproveERC20Stub = stub(erc20Helper, 'checkAndApproveERC20').resolves({
            wasRequired: false,
            transactionHash: undefined,
            hadZeroApproval: false,
        });
        submitTransactionWithLoggingStub = stub(transactionHelper, 'submitTransactionWithLogging').resolves({
            submissionType: TransactionSubmissionType.Onchain,
            hash: '0xBridgeTxHash',
            receipt: { transactionHash: '0xBridgeTxHash', blockNumber: 121, status: 1 } as providers.TransactionReceipt,
        });

        const mockERC20RouteValues: RouteRebalancingConfig = {
            origin: 1,
            destination: 10,
            asset: MOCK_ASSET_ERC20,
            maximum: '10000000000000000000', // 10 tokens
            slippage: 0.01,
            preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
        };

        const mockNativeRouteValues: RouteRebalancingConfig = {
            origin: 1,
            destination: 42,
            asset: MOCK_ASSET_NATIVE,
            maximum: '5000000000000000000', // 5 ETH
            slippage: 0.005,
            preferences: [MOCK_BRIDGE_TYPE_A],
        };

        const mockConfig: MarkConfiguration = {
            routes: [mockERC20RouteValues, mockNativeRouteValues],
            ownAddress: MOCK_OWN_ADDRESS,
            pushGatewayUrl: 'http://localhost:9091',
            web3SignerUrl: 'http://localhost:8545',
            everclearApiUrl: 'http://localhost:3000',
            relayer: '0xRelayerAddress' as `0x${string}`,
            invoiceAge: 3600,
            logLevel: 'info',
            pollingInterval: 60000,
            maxRetries: 3,
            retryDelay: 1000,
            chains: {
                '1': {
                    providers: ['http://mainnetprovider'],
                    assets: [
                        { address: MOCK_ASSET_ERC20, tickerHash: MOCK_ERC20_TICKER_HASH, symbol: 'MOCKERC20', decimals: 18, isNative: false, balanceThreshold: '0' },
                        { address: MOCK_ASSET_NATIVE, tickerHash: MOCK_NATIVE_TICKER_HASH, symbol: 'MOCKNATIVE', decimals: 18, isNative: true, balanceThreshold: '0' },
                    ],
                },
                '10': {
                    providers: ['http://optimismprovider'],
                    assets: [
                        { address: MOCK_ASSET_ERC20, tickerHash: MOCK_ERC20_TICKER_HASH, symbol: 'MOCKERC20', decimals: 18, isNative: false, balanceThreshold: '0' },
                    ],
                },
                '42': {
                    providers: ['http://kovanprovider'],
                    assets: [
                        { address: MOCK_ASSET_NATIVE, tickerHash: MOCK_NATIVE_TICKER_HASH, symbol: 'MOCKNATIVE', decimals: 18, isNative: true, balanceThreshold: '0' },
                    ],
                },
            },
            supportedSettlementDomains: [1, 10, 42],
        } as unknown as MarkConfiguration;

        mockContext = {
            config: mockConfig,
            requestId: MOCK_REQUEST_ID,
            startTime: Date.now(),
            logger: mockLogger,
            rebalanceCache: mockRebalanceCache,
            chainService: mockChainService,
            rebalance: mockRebalanceAdapter,
            prometheus: mockPrometheus,
            everclear: undefined,
            purchaseCache: undefined,
            web3Signer: undefined,
        } as unknown as SinonStubbedInstance<ProcessingContext>;

        // Default Stubs
        mockRebalanceAdapter.getAdapter.returns(mockSpecificBridgeAdapter as any);
        mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_A);

        // Mock chainService return
        mockChainService.submitAndMonitor.resolves({ transactionHash: '0xMockTxHash', blockNumber: 123, status: 1 } as any);
    });

    afterEach(() => {
        // Restore all sinon replaced/stubbed methods globally
        restore();
        checkAndApproveERC20Stub?.reset();
        submitTransactionWithLoggingStub?.reset();
    });

    it('should execute callbacks first', async () => {
        await rebalanceInventory(mockContext);
        expect(executeDestinationCallbacksStub.calledOnceWith(mockContext)).to.be.true;
    });

    it('should skip route if balance is at or below maximum', async () => {
        const routeToCheck = mockContext.config.routes[0];
        const atMaximumBalance = BigInt(routeToCheck.maximum);
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToCheck.origin.toString(), atMaximumBalance - 1n]]));
        getMarkBalancesStub.resolves(balances);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToCheck] } });

        expect(mockLogger.info.calledWith(match(/Balance is at or below maximum, skipping route/))).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.called).to.be.false;
    });

    it('should skip route if no balance found for origin chain', async () => {
        const balances = new Map<string, Map<string, bigint>>();
        getMarkBalancesStub.resolves(balances);
        const routeToCheck = mockContext.config.routes[0];

        await rebalanceInventory(mockContext);

        expect(mockLogger.warn.calledWith(match(/No balances found for ticker/), match({ route: routeToCheck }))).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.called).to.be.false;
    });

    it('should successfully rebalance an ERC20 asset with approval needed', async () => {
        const routeToTest = mockContext.config.routes[0] as RouteRebalancingConfig;
        // Ensure currentBalance is greater than maximum to trigger rebalancing
        const currentBalance = BigInt(routeToTest.maximum) + 1_000_000_000_000_000_000n; // maximum + 1e18 (1 token)
        // Adjust quoteAmount to be realistic for the new currentBalance and pass slippage
        // Simulating a 0.05% slippage: currentBalance - (currentBalance / 2000n)
        const quoteAmount = (currentBalance - (currentBalance / 2000n)).toString();
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), currentBalance]]));
        getMarkBalancesStub.resolves(balances);

        const mockTxRequest: ViemTransactionRequest = {
            to: MOCK_BRIDGE_A_SPENDER,
            data: '0xbridgeData' as Hex,
            value: 0n,
        };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockSpecificBridgeAdapter as any);

        // Simplify the stub for debugging
        mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
        mockSpecificBridgeAdapter.send.withArgs(MOCK_OWN_ADDRESS, MOCK_OWN_ADDRESS, currentBalance.toString(), match({ ...routeToTest, preferences: [SupportedBridge.Across] })).resolves(mockTxRequest);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [SupportedBridge.Across] }] } });

        expect(getMarkBalancesStub.calledOnce).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).to.be.true;
        expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;

        // Check that ERC20 approval helper was called
        expect(checkAndApproveERC20Stub.calledOnce).to.be.true;
        const approvalCall = checkAndApproveERC20Stub.firstCall.args[0];
        expect(approvalCall.tokenAddress).to.equal(routeToTest.asset);
        expect(approvalCall.spenderAddress).to.equal(MOCK_BRIDGE_A_SPENDER);
        expect(approvalCall.amount).to.equal(currentBalance);

        // Check that transaction submission helper was called
        expect(submitTransactionWithLoggingStub.calledOnce).to.be.true;
        const txCall = submitTransactionWithLoggingStub.firstCall.args[0];
        expect(txCall.txRequest.to).to.equal(MOCK_BRIDGE_A_SPENDER);
        expect(txCall.txRequest.data).to.equal('0xbridgeData');

        const expectedAction: Partial<RebalanceAction> = {
            bridge: MOCK_BRIDGE_TYPE_A,
            amount: currentBalance.toString(),
            origin: routeToTest.origin,
            destination: routeToTest.destination,
            asset: routeToTest.asset,
            transaction: '0xBridgeTxHash',
        };
        expect(mockRebalanceCache.addRebalances.firstCall.args[0]).to.be.deep.eq([expectedAction]);
        expect(mockLogger.info.calledWith(match(/Successfully added rebalance action to cache/))).to.be.true;
        expect(mockLogger.info.calledWith(match(/Rebalance successful for route/))).to.be.true;
    });

    it('should try the next bridge preference if adapter is not found', async () => {
        const routeToTest = mockContext.config.routes[0];
        const balances = new Map<string, Map<string, bigint>>();
        const currentBalance = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), currentBalance]]));
        getMarkBalancesStub.resolves(balances);

        // First preference (Across) returns no adapter
        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(undefined as any);
        // Second preference (Stargate) returns the mock adapter
        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockSpecificBridgeAdapter as any);
        mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_B); // Ensure type reflects the successful adapter
        mockSpecificBridgeAdapter.getReceivedAmount.resolves('99'); // Assume success for the second bridge
        mockSpecificBridgeAdapter.send.resolves({ to: '0xOtherSpender', data: '0xbridgeData', value: 0n }); // Assume success for the second bridge

        // Mock allowance and contract for the second bridge attempt (assuming ERC20)
        const mockContractInstance = { read: { allowance: stub().resolves(1000n) }, abi: erc20Abi, address: MOCK_ASSET_ERC20 };
        getERC20ContractStub.withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`).resolves(mockContractInstance);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToTest] } });

        expect(mockLogger.warn.calledWith(match(/Adapter not found for bridge type/), match({ bridgeType: MOCK_BRIDGE_TYPE_A }))).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_B)).to.be.true;
        // Check if the second bridge attempt proceeded (e.g., getReceivedAmount called on the second adapter)
        expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
        // Add more assertions if needed to confirm the second bridge logic executed
    });

    it('should try the next bridge preference if getReceivedAmount fails', async () => {
        const routeToTest = mockContext.config.routes[0];
        const balances = new Map<string, Map<string, bigint>>();
        const balanceForRoute = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
        // Corrected key for the inner map to use routeToTest.origin.toString()
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
        getMarkBalancesStub.resolves(balances);

        const mockAdapterA = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().rejects(new Error('Quote failed')) };
        const mockAdapterB = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().resolves('99'), send: stub().resolves({ to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n }), type: stub().returns(MOCK_BRIDGE_TYPE_B) };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockAdapterA as any);
        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockAdapterB as any);

        // Mock allowance and contract for the second bridge attempt (assuming ERC20)
        const mockContractInstance = { read: { allowance: stub().resolves(1000n) }, abi: erc20Abi, address: MOCK_ASSET_ERC20 };
        getERC20ContractStub.withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`).resolves(mockContractInstance);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToTest] } });

        expect(mockLogger.error.calledWith(match(/Failed to get quote from adapter/), match({ bridgeType: MOCK_BRIDGE_TYPE_A }))).to.be.true;
        expect(mockAdapterA.getReceivedAmount.calledOnce).to.be.true;
        expect(mockAdapterB.getReceivedAmount.calledOnce).to.be.true; // Ensure B was tried
        // Add assertions to confirm bridge B logic executed
    });

    it('should try the next bridge preference if slippage check fails', async () => {
        const routeToTest = mockContext.config.routes[0]; // slippage 0.01 (1%)
        const lowQuote = '9'; // Less than 9900 (1% slippage)
        const balanceForRoute = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
        const balances = new Map<string, Map<string, bigint>>();
        // Corrected key for the inner map to use routeToTest.origin.toString()
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
        getMarkBalancesStub.resolves(balances);

        const mockAdapterA = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().resolves(lowQuote), type: stub().returns(MOCK_BRIDGE_TYPE_A) };
        const mockAdapterB = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().resolves('9950'), send: stub().resolves({ to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n }), type: stub().returns(MOCK_BRIDGE_TYPE_B) };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockAdapterA as any);
        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockAdapterB as any);

        // Mock allowance and contract for the second bridge attempt (assuming ERC20)
        const mockContractInstance = { read: { allowance: stub().resolves(10000n) }, abi: erc20Abi, address: MOCK_ASSET_ERC20 };
        getERC20ContractStub.withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`).resolves(mockContractInstance);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToTest] } });

        expect(mockLogger.warn.calledWith(match(/Quote does not meet slippage requirements/), match({ bridgeType: MOCK_BRIDGE_TYPE_A }))).to.be.true;
        expect(mockAdapterA.getReceivedAmount.calledOnce).to.be.true;
        expect(mockAdapterB.getReceivedAmount.calledOnce).to.be.true; // Ensure B was tried
        // Add assertions to confirm bridge B logic executed
    });

    it('should try the next bridge preference if adapter send fails', async () => {
        const routeToTest = mockContext.config.routes[0];
        const balances = new Map<string, Map<string, bigint>>();
        const balanceForRoute = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
        getMarkBalancesStub.resolves(balances);

        // Adjust getReceivedAmount to pass slippage check
        const receivedAmountForSlippagePass = balanceForRoute.toString();

        const mockAdapterA_sendFails = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().resolves(receivedAmountForSlippagePass), send: stub().rejects(new Error('Send failed')), type: stub().returns(MOCK_BRIDGE_TYPE_A) };
        const mockAdapterB_sendFails = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().resolves(receivedAmountForSlippagePass), send: stub().resolves({ to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n }), type: stub().returns(MOCK_BRIDGE_TYPE_B) };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockAdapterA_sendFails as any);
        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockAdapterB_sendFails as any);

        // Mock allowance and contract for the second bridge attempt (assuming ERC20)
        const mockContractInstance = { read: { allowance: stub().resolves(1000n) }, abi: erc20Abi, address: MOCK_ASSET_ERC20 };
        getERC20ContractStub.withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`).resolves(mockContractInstance);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToTest] } });

        expect(mockLogger.error.calledWith(match(/Failed to get bridge transaction request from adapter/), match({ bridgeType: MOCK_BRIDGE_TYPE_A }))).to.be.true;
        expect(mockAdapterA_sendFails.send.calledOnce).to.be.true;
        expect(mockAdapterB_sendFails.send.calledOnce).to.be.true; // Ensure B send was tried
        // Add assertions to confirm bridge B logic executed
    });

    it('should successfully rebalance an ERC20 asset with sufficient allowance', async () => {
        const currentBalance = 1000n;
        const routeToTest = { ...(mockContext.config.routes[0] as RouteRebalancingConfig), maximum: (currentBalance - 1n).toString() };
        const quoteAmount = '999';
        const balances = new Map<string, Map<string, bigint>>();
        // Corrected key for the inner map to use routeToTest.origin.toString()
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), currentBalance]]));
        getMarkBalancesStub.resolves(balances);

        const mockTxRequest: ViemTransactionRequest = {
            to: MOCK_BRIDGE_A_SPENDER, // Spender for the bridge
            data: '0xbridgeData' as Hex,
            value: 0n,
        };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockSpecificBridgeAdapter as any);
        mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_A);
        mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
        mockSpecificBridgeAdapter.send.withArgs(MOCK_OWN_ADDRESS, MOCK_OWN_ADDRESS, currentBalance.toString(), match.object).resolves(mockTxRequest);

        // Configure approval helper to return that no approval was needed
        checkAndApproveERC20Stub.resolves({
            wasRequired: false,
            transactionHash: null,
            hadZeroApproval: false,
        });

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [MOCK_BRIDGE_TYPE_A] }] } });

        expect(getMarkBalancesStub.calledOnce).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).to.be.true;
        expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;

        // Check that ERC20 approval helper was called (even though no approval was needed)
        expect(checkAndApproveERC20Stub.calledOnce).to.be.true;

        // Check that transaction submission helper was called for the bridge transaction
        expect(submitTransactionWithLoggingStub.calledOnce).to.be.true;
        const txCall = submitTransactionWithLoggingStub.firstCall.args[0];
        expect(txCall.txRequest.to).to.equal(MOCK_BRIDGE_A_SPENDER);
        expect(txCall.txRequest.data).to.equal('0xbridgeData');

        expect(mockRebalanceCache.addRebalances.calledOnce).to.be.true;
    });

    // Add more tests: Native success, other errors...

});

describe('Zodiac Address Validation', () => {
    let mockContext: SinonStubbedInstance<ProcessingContext>;
    let mockLogger: SinonStubbedInstance<Logger>;
    let mockRebalanceCache: SinonStubbedInstance<RebalanceCache>;
    let mockChainService: SinonStubbedInstance<ChainService>;
    let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
    let mockPrometheus: SinonStubbedInstance<PrometheusAdapter>;
    let mockSpecificBridgeAdapter: MockBridgeAdapterInterface;

    // Stubs for module functions
    let executeDestinationCallbacksStub: SinonStub;
    let getMarkBalancesStub: SinonStub;
    let getERC20ContractStub: SinonStub;
    let checkAndApproveERC20Stub: SinonStub;
    let submitTransactionWithLoggingStub: SinonStub;

    const MOCK_REQUEST_ID = 'zodiac-rebalance-request-id';
    const MOCK_OWN_ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
    const MOCK_SAFE_ADDRESS = '0x9876543210987654321098765432109876543210' as `0x${string}`;
    const MOCK_ASSET_ERC20 = '0xErc20AssetAddress' as `0x${string}`;
    const MOCK_BRIDGE_TYPE = SupportedBridge.Across;
    const MOCK_ERC20_TICKER_HASH = '0xerc20tickerhashtest' as `0x${string}`;

    const mockZodiacConfig = {
        zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
        zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
        gnosisSafeAddress: MOCK_SAFE_ADDRESS
    };

    const mockEOAConfig = {
        zodiacRoleModuleAddress: undefined,
        zodiacRoleKey: undefined,
        gnosisSafeAddress: undefined
    };

    beforeEach(() => {
        mockLogger = createStubInstance(Logger);
        mockRebalanceCache = createStubInstance(RebalanceCache);
        mockChainService = createStubInstance(ChainService);
        mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
        mockPrometheus = createStubInstance(PrometheusAdapter);

        mockSpecificBridgeAdapter = {
            getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
            send: stub<[string, string, string, RebalanceRoute], Promise<ViemTransactionRequest>>(),
            type: stub<[], SupportedBridge>(),
        };

        // Stub helper functions
        executeDestinationCallbacksStub = stub(callbacks, 'executeDestinationCallbacks').resolves();
        getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances').resolves(new Map());
        getERC20ContractStub = stub(contractHelpers, 'getERC20Contract');
        checkAndApproveERC20Stub = stub(erc20Helper, 'checkAndApproveERC20').resolves({
            wasRequired: false,
            transactionHash: undefined,
            hadZeroApproval: false,
        });
        submitTransactionWithLoggingStub = stub(transactionHelper, 'submitTransactionWithLogging').resolves({
            hash: '0xBridgeTxHash',
            submissionType: TransactionSubmissionType.Onchain,
            receipt: { transactionHash: '0xBridgeTxHash', blockNumber: 121, status: 1 } as providers.TransactionReceipt,
        });

        // Default configuration with two chains - one with Zodiac, one without
        const mockConfig: MarkConfiguration = {
            routes: [{
                origin: 42161, // Arbitrum (with Zodiac)
                destination: 1, // Ethereum (without Zodiac)
                asset: MOCK_ASSET_ERC20,
                maximum: '10000000000000000000', // 10 tokens
                slippage: 0.01,
                preferences: [MOCK_BRIDGE_TYPE],
            }],
            ownAddress: MOCK_OWN_ADDRESS,
            pushGatewayUrl: 'http://localhost:9091',
            web3SignerUrl: 'http://localhost:8545',
            everclearApiUrl: 'http://localhost:3000',
            relayer: '0xRelayerAddress' as `0x${string}`,
            invoiceAge: 3600,
            logLevel: 'info',
            pollingInterval: 60000,
            maxRetries: 3,
            retryDelay: 1000,
            chains: {
                '42161': { // Arbitrum with Zodiac
                    providers: ['http://arbitrumprovider'],
                    assets: [
                        { address: MOCK_ASSET_ERC20, tickerHash: MOCK_ERC20_TICKER_HASH, symbol: 'MOCKERC20', decimals: 18, isNative: false, balanceThreshold: '0' },
                    ],
                    invoiceAge: 0,
                    gasThreshold: '0',
                    deployments: {
                        everclear: '0x1234567890123456789012345678901234567890',
                        permit2: '0x1234567890123456789012345678901234567890',
                        multicall3: '0x1234567890123456789012345678901234567890'
                    },
                    ...mockZodiacConfig
                },
                '1': { // Ethereum without Zodiac
                    providers: ['http://mainnetprovider'],
                    assets: [
                        { address: MOCK_ASSET_ERC20, tickerHash: MOCK_ERC20_TICKER_HASH, symbol: 'MOCKERC20', decimals: 18, isNative: false, balanceThreshold: '0' },
                    ],
                    invoiceAge: 0,
                    gasThreshold: '0',
                    deployments: {
                        everclear: '0x1234567890123456789012345678901234567890',
                        permit2: '0x1234567890123456789012345678901234567890',
                        multicall3: '0x1234567890123456789012345678901234567890'
                    },
                    ...mockEOAConfig
                },
            },
            supportedSettlementDomains: [1, 42161],
        } as unknown as MarkConfiguration;

        mockContext = {
            config: mockConfig,
            requestId: MOCK_REQUEST_ID,
            startTime: Date.now(),
            logger: mockLogger,
            rebalanceCache: mockRebalanceCache,
            chainService: mockChainService,
            rebalance: mockRebalanceAdapter,
            prometheus: mockPrometheus,
            everclear: undefined,
            purchaseCache: undefined,
            web3Signer: undefined,
        } as unknown as SinonStubbedInstance<ProcessingContext>;

        // Default stubs
        mockRebalanceCache.isPaused.resolves(false); // Critical: allow rebalancing to proceed
        mockRebalanceCache.addRebalances.resolves(); // Mock the cache addition
        mockRebalanceAdapter.getAdapter.returns(mockSpecificBridgeAdapter as any);
        mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE);
        mockSpecificBridgeAdapter.getReceivedAmount.resolves('19980000000000000001'); // Good quote for 20 tokens (just above minimum slippage)
        mockSpecificBridgeAdapter.send.resolves({
            to: '0xBridgeSpender',
            data: '0xbridgeData' as Hex,
            value: 0n,
        });

        // Mock successful transaction
        mockChainService.submitAndMonitor.resolves({
            transactionHash: '0xMockTxHash',
            blockNumber: 123,
            status: 1
        } as any);
    });

    afterEach(() => {
        restore();
    });

    it('should use Safe address as sender for Zodiac-enabled origin chain', async () => {
        // Uses default route: Arbitrum (Zodiac) -> Ethereum (EOA)
        const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([
            ['42161', currentBalance]
        ]));
        getMarkBalancesStub.resolves(balances);

        await rebalanceInventory(mockContext);

        // Verify adapter.send was called with Safe address as sender (first parameter)
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
        const sendCall = mockSpecificBridgeAdapter.send.firstCall;
        expect(sendCall.args[0]).to.equal(MOCK_SAFE_ADDRESS); // sender = Safe address from origin chain (42161)
        expect(sendCall.args[1]).to.equal(MOCK_OWN_ADDRESS); // recipient = EOA address for destination chain (1)
    });

    it('should use EOA address as sender for non-Zodiac origin chain', async () => {
        // Configure route: Ethereum (EOA) -> Arbitrum (Zodiac)
        mockContext.config.routes = [{
            origin: 1, // Ethereum (without Zodiac)
            destination: 42161, // Arbitrum (with Zodiac)
            asset: MOCK_ASSET_ERC20,
            maximum: '10000000000000000000',
            slippage: 0.01,
            preferences: [MOCK_BRIDGE_TYPE],
        }];

        const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([
            ['1', currentBalance]
        ]));
        getMarkBalancesStub.resolves(balances);

        await rebalanceInventory(mockContext);

        // Verify adapter.send was called with EOA address as sender and Safe address as recipient
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
        const sendCall = mockSpecificBridgeAdapter.send.firstCall;
        expect(sendCall.args[0]).to.equal(MOCK_OWN_ADDRESS); // sender = EOA address from origin chain (1)
        expect(sendCall.args[1]).to.equal(MOCK_SAFE_ADDRESS); // recipient = Safe address for destination chain (42161)
    });

    it('should use Safe addresses for both sender and recipient when both chains have Zodiac', async () => {
        // Add second Zodiac-enabled chain
        const mockSafeAddress2 = '0x2222222222222222222222222222222222222222' as `0x${string}`;
        mockContext.config.chains['10'] = {
            providers: ['http://optimismprovider'],
            assets: [
                { address: MOCK_ASSET_ERC20, tickerHash: MOCK_ERC20_TICKER_HASH, symbol: 'MOCKERC20', decimals: 18, isNative: false, balanceThreshold: '0' },
            ],
            invoiceAge: 0,
            gasThreshold: '0',
            deployments: {
                everclear: '0x1234567890123456789012345678901234567890',
                permit2: '0x1234567890123456789012345678901234567890',
                multicall3: '0x1234567890123456789012345678901234567890'
            },
            zodiacRoleModuleAddress: '0x2345678901234567890123456789012345678901',
            zodiacRoleKey: '0x2345678901234567890123456789012345678901234567890123456789012345',
            gnosisSafeAddress: mockSafeAddress2
        };
        mockContext.config.supportedSettlementDomains = [1, 10, 42161];

        // Configure route: Arbitrum (Zodiac) -> Optimism (Zodiac)
        mockContext.config.routes = [{
            origin: 42161, // Arbitrum (with Zodiac)
            destination: 10, // Optimism (with Zodiac)
            asset: MOCK_ASSET_ERC20,
            maximum: '10000000000000000000',
            slippage: 0.01,
            preferences: [MOCK_BRIDGE_TYPE],
        }];

        const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([
            ['42161', currentBalance]
        ]));
        getMarkBalancesStub.resolves(balances);

        await rebalanceInventory(mockContext);

        // Verify adapter.send was called with Safe addresses for both sender and recipient
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
        const sendCall = mockSpecificBridgeAdapter.send.firstCall;
        expect(sendCall.args[0]).to.equal(MOCK_SAFE_ADDRESS); // sender = Safe address from origin chain (42161)
        expect(sendCall.args[1]).to.equal(mockSafeAddress2); // recipient = Safe address for destination chain (10)
    });

    it('should use EOA addresses for both sender and recipient when neither chain has Zodiac', async () => {
        // Add second EOA-only chain
        mockContext.config.chains['10'] = {
            providers: ['http://optimismprovider'],
            assets: [
                { address: MOCK_ASSET_ERC20, tickerHash: MOCK_ERC20_TICKER_HASH, symbol: 'MOCKERC20', decimals: 18, isNative: false, balanceThreshold: '0' },
            ],
            invoiceAge: 0,
            gasThreshold: '0',
            deployments: {
                everclear: '0x1234567890123456789012345678901234567890',
                permit2: '0x1234567890123456789012345678901234567890',
                multicall3: '0x1234567890123456789012345678901234567890'
            },
            ...mockEOAConfig
        };
        mockContext.config.supportedSettlementDomains = [1, 10, 42161];

        // Configure route: Ethereum (EOA) -> Optimism (EOA)
        mockContext.config.routes = [{
            origin: 1, // Ethereum (without Zodiac)
            destination: 10, // Optimism (without Zodiac)
            asset: MOCK_ASSET_ERC20,
            maximum: '10000000000000000000',
            slippage: 0.01,
            preferences: [MOCK_BRIDGE_TYPE],
        }];

        const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([
            ['1', currentBalance]
        ]));
        getMarkBalancesStub.resolves(balances);

        await rebalanceInventory(mockContext);

        // Verify adapter.send was called with EOA addresses for both sender and recipient
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
        const sendCall = mockSpecificBridgeAdapter.send.firstCall;
        expect(sendCall.args[0]).to.equal(MOCK_OWN_ADDRESS); // sender = EOA address from origin chain (1)
        expect(sendCall.args[1]).to.equal(MOCK_OWN_ADDRESS); // recipient = EOA address for destination chain (10)
    });
}); 