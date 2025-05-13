import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub, match, restore } from 'sinon';
import { rebalanceInventory } from '../../src/rebalance/rebalance';
import * as balanceHelpers from '../../src/helpers/balance';
import * as contractHelpers from '../../src/helpers/contracts';
import * as callbacks from '../../src/rebalance/callbacks'; // To mock executeDestinationCallbacks
import { MarkConfiguration, SupportedBridge, RebalanceRoute, RouteRebalancingConfig } from '@mark/core';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceCache, RebalanceAction } from '@mark/cache';
import { RebalanceAdapter } from '@mark/adapters-rebalance'; // Assuming interface export
import { PrometheusAdapter } from '@mark/prometheus';
import { providers } from 'ethers'; // For TransactionRequest type used by submitAndMonitor
import { TransactionRequest as ViemTransactionRequest, zeroAddress, Hex, erc20Abi } from 'viem'; // For adapter.send return type


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

    const MOCK_REQUEST_ID = 'rebalance-request-id';
    const MOCK_OWN_ADDRESS = '0xOwnerAddress' as `0x${string}`;
    const MOCK_ASSET_ERC20 = '0xErc20AssetAddress' as `0x${string}`;
    const MOCK_ASSET_NATIVE = zeroAddress;
    const MOCK_BRIDGE_TYPE_A = SupportedBridge.Across;
    const MOCK_BRIDGE_TYPE_B: SupportedBridge = 'stargate' as SupportedBridge;
    const MOCK_BRIDGE_A_SPENDER = '0x25d07db6a8b00bb1d8745de4b34e8bdee59e871c' as `0x${string}`;
    const MOCK_APPROVE_DATA = '0x095ea7b3' as Hex; // Example data for approve

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
                '1': { providers: ['http://mainnetprovider'] },
                '10': { providers: ['http://optimismprovider'] },
                '42': { providers: ['http://kovanprovider'] },
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
    });

    it('should execute callbacks first', async () => {
        await rebalanceInventory(mockContext);
        expect(executeDestinationCallbacksStub.calledOnceWith(mockContext)).to.be.true;
    });

    it('should skip route if balance is at or above maximum', async () => {
        const routeToCheck = mockContext.config.routes[0];
        const highBalance = BigInt(routeToCheck.maximum) + 1n;
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(routeToCheck.origin.toString(), new Map([[routeToCheck.asset.toLowerCase(), highBalance]]));
        getMarkBalancesStub.resolves(balances);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToCheck] } });

        expect(mockLogger.info.calledWith(match(/Balance is at or above maximum/), match({ route: routeToCheck }))).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.called).to.be.false;
    });

    it('should skip route if no balance found for origin chain', async () => {
        const balances = new Map<string, Map<string, bigint>>();
        getMarkBalancesStub.resolves(balances);
        const routeToCheck = mockContext.config.routes[0];

        await rebalanceInventory(mockContext);

        expect(mockLogger.warn.calledWith(match(/No balances found for origin chain/), match({ route: routeToCheck }))).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.called).to.be.false;
    });

    it('should successfully rebalance an ERC20 asset with approval needed', async () => {
        const routeToTest = mockContext.config.routes[0] as RouteRebalancingConfig;
        const currentBalance = 1000n;
        const quoteAmount = '995';
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(routeToTest.origin.toString(), new Map([[routeToTest.asset.toLowerCase(), currentBalance]]));
        getMarkBalancesStub.resolves(balances);

        const mockTxRequest: ViemTransactionRequest = {
            to: MOCK_BRIDGE_A_SPENDER,
            data: '0xbridgeData' as Hex,
            value: 0n,
        };
        const mockApprovalTxRequest: providers.TransactionRequest = {
            to: MOCK_ASSET_ERC20,
            data: MOCK_APPROVE_DATA,
            value: '0',
        };
        const mockBridgeTxSubmit: providers.TransactionRequest = {
            to: MOCK_BRIDGE_A_SPENDER,
            data: '0xbridgeData',
            value: '0',
        };
        const approvalReceipt = { transactionHash: '0xApprovalTxHash', blockNumber: 120, status: 1 };
        const bridgeReceipt = { transactionHash: '0xBridgeTxHash', blockNumber: 121, status: 1 };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockSpecificBridgeAdapter as any);

        // Simplify the stub for debugging
        mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
        mockSpecificBridgeAdapter.send.withArgs(MOCK_OWN_ADDRESS, MOCK_OWN_ADDRESS, currentBalance.toString(), match({ ...routeToTest, preferences: [SupportedBridge.Across] })).resolves(mockTxRequest);

        const mockContractInstance = {
            read: {
                allowance: stub().resolves(0n)
            },
            abi: erc20Abi,
            address: MOCK_ASSET_ERC20
        };
        getERC20ContractStub.withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`).resolves(mockContractInstance);

        mockChainService.submitAndMonitor
            .withArgs(routeToTest.origin.toString(), match(mockApprovalTxRequest))
            .resolves(approvalReceipt as any)
            .withArgs(routeToTest.origin.toString(), match(mockBridgeTxSubmit))
            .resolves(bridgeReceipt as any);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [SupportedBridge.Across] }] } });

        expect(getMarkBalancesStub.calledOnce).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).to.be.true;
        expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
        expect(getERC20ContractStub.calledOnce).to.be.true;
        expect(mockContractInstance.read.allowance.calledOnceWith([MOCK_OWN_ADDRESS, MOCK_BRIDGE_A_SPENDER])).to.be.true;
        expect(mockChainService.submitAndMonitor.firstCall.args[1].to).to.be.eq(MOCK_ASSET_ERC20)
        expect(mockChainService.submitAndMonitor.firstCall.args[1].data).to.include(MOCK_APPROVE_DATA);
        expect(mockLogger.info.calledWith(match(/Successfully submitted and confirmed ERC20 approval/))).to.be.true;
        expect(mockChainService.submitAndMonitor.secondCall.args[1]).to.deep.include({ to: MOCK_BRIDGE_A_SPENDER });
        expect(mockLogger.info.calledWith(match(/Successfully submitted and confirmed origin bridge transaction/))).to.be.true;

        const expectedAction: Partial<RebalanceAction> = {
            bridge: MOCK_BRIDGE_TYPE_A,
            amount: currentBalance.toString(),
            origin: routeToTest.origin,
            destination: routeToTest.destination,
            asset: routeToTest.asset,
            transaction: '0xMockTxHash',
        };
        expect(mockRebalanceCache.addRebalances.firstCall.args[0]).to.be.deep.eq([expectedAction]);
        expect(mockLogger.info.calledWith(match(/Successfully added rebalance action to cache/))).to.be.true;
        expect(mockLogger.info.calledWith(match(/Rebalance successful for route/))).to.be.true;
        expect(getERC20ContractStub.calledOnce).to.be.true;
    });

    it('should try the next bridge preference if adapter is not found', async () => {
        const routeToTest = mockContext.config.routes[0];
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(routeToTest.origin.toString(), new Map([[routeToTest.asset.toLowerCase(), 100n]]));
        getMarkBalancesStub.resolves(balances);

        // First preference (Across) returns no adapter
        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(undefined);
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
        balances.set(routeToTest.origin.toString(), new Map([[routeToTest.asset.toLowerCase(), 100n]]));
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
        const currentBalance = 10000n;
        const lowQuote = '9899'; // Less than 9900 (1% slippage)
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(routeToTest.origin.toString(), new Map([[routeToTest.asset.toLowerCase(), currentBalance]]));
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
        const currentBalance = 100n;
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(routeToTest.origin.toString(), new Map([[routeToTest.asset.toLowerCase(), currentBalance]]));
        getMarkBalancesStub.resolves(balances);

        const mockAdapterA = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().resolves('99'), send: stub().rejects(new Error('Send failed')), type: stub().returns(MOCK_BRIDGE_TYPE_A) };
        const mockAdapterB = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().resolves('99'), send: stub().resolves({ to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n }), type: stub().returns(MOCK_BRIDGE_TYPE_B) };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockAdapterA as any);
        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockAdapterB as any);

        // Mock allowance and contract for the second bridge attempt (assuming ERC20)
        const mockContractInstance = { read: { allowance: stub().resolves(1000n) }, abi: erc20Abi, address: MOCK_ASSET_ERC20 };
        getERC20ContractStub.withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`).resolves(mockContractInstance);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToTest] } });

        expect(mockLogger.error.calledWith(match(/Failed to get bridge transaction request from adapter/), match({ bridgeType: MOCK_BRIDGE_TYPE_A }))).to.be.true;
        expect(mockAdapterA.send.calledOnce).to.be.true;
        expect(mockAdapterB.send.calledOnce).to.be.true; // Ensure B send was tried
        // Add assertions to confirm bridge B logic executed
    });

    it('should successfully rebalance an ERC20 asset with sufficient allowance', async () => {
        const routeToTest = mockContext.config.routes[0] as RouteRebalancingConfig;
        const currentBalance = 1000n;
        const quoteAmount = '995'; // Sufficient for slippage
        const balances = new Map<string, Map<string, bigint>>();
        balances.set(routeToTest.origin.toString(), new Map([[routeToTest.asset.toLowerCase(), currentBalance]]));
        getMarkBalancesStub.resolves(balances);

        const mockTxRequest: ViemTransactionRequest = {
            to: MOCK_BRIDGE_A_SPENDER, // Spender for the bridge
            data: '0xbridgeData' as Hex,
            value: 0n,
        };
        const bridgeReceipt = { transactionHash: '0xBridgeTxHashSufficient', blockNumber: 130, status: 1 };

        mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockSpecificBridgeAdapter as any);
        mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_A);
        mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
        mockSpecificBridgeAdapter.send.withArgs(MOCK_OWN_ADDRESS, MOCK_OWN_ADDRESS, currentBalance.toString(), match.object).resolves(mockTxRequest);

        const mockContractInstance = {
            read: {
                allowance: stub().resolves(currentBalance + 100n) // Allowance is greater than currentBalance
            },
            abi: erc20Abi,
            address: MOCK_ASSET_ERC20
        };
        getERC20ContractStub.withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`).resolves(mockContractInstance);

        mockChainService.submitAndMonitor
            .withArgs(routeToTest.origin.toString(), match({ to: MOCK_BRIDGE_A_SPENDER, data: '0xbridgeData' }))
            .resolves(bridgeReceipt as any);

        await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [MOCK_BRIDGE_TYPE_A] }] } });

        expect(getMarkBalancesStub.calledOnce).to.be.true;
        expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).to.be.true;
        expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
        expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
        expect(getERC20ContractStub.calledOnce).to.be.true;
        expect(mockContractInstance.read.allowance.calledOnceWith([MOCK_OWN_ADDRESS, MOCK_BRIDGE_A_SPENDER])).to.be.true;
        // Crucially, submitAndMonitor should only be called ONCE for the bridge tx, not for approval
        expect(mockChainService.submitAndMonitor.calledOnce).to.be.true;
        expect(mockChainService.submitAndMonitor.firstCall.args[1].to).to.deep.equal(MOCK_BRIDGE_A_SPENDER);
        expect(mockLogger.info.calledWith(match(/Sufficient allowance already exists for token/))).to.be.true;
        expect(mockLogger.info.calledWith(match(/Successfully submitted and confirmed origin bridge transaction/))).to.be.true;
        expect(mockRebalanceCache.addRebalances.calledOnce).to.be.true;
    });

    // Add more tests: Native success, other errors...

}); 