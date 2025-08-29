import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub, match, restore } from 'sinon';
import { rebalanceInventory } from '../../src/rebalance/rebalance';
import * as balanceHelpers from '../../src/helpers/balance';
import * as contractHelpers from '../../src/helpers/contracts';
import * as callbacks from '../../src/rebalance/callbacks'; // To mock executeDestinationCallbacks
import * as erc20Helper from '../../src/helpers/erc20';
import * as transactionHelper from '../../src/helpers/transactions';
import {
  MarkConfiguration,
  SupportedBridge,
  RebalanceRoute,
  RouteRebalancingConfig,
  TransactionSubmissionType,
} from '@mark/core';
import { Logger } from '@mark/logger';
import { ChainService, ChainServiceTransactionReceipt } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { RebalanceCache, RebalanceAction } from '@mark/cache';
import { RebalanceAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '@mark/rebalance';
import { PrometheusAdapter } from '@mark/prometheus';
import { zeroAddress, Hex, erc20Abi } from 'viem'; // For adapter.send return type

interface MockBridgeAdapterInterface {
  getReceivedAmount: SinonStub<[string, RebalanceRoute], Promise<string>>;
  send: SinonStub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>;
  type: SinonStub<[], SupportedBridge>;
  // Add other methods if they are called by the SUT
}

const mockReceipt: ChainServiceTransactionReceipt = {
  transactionHash: '0xBridgeTxHash',
  blockNumber: 121,
  status: 1,
  confirmations: 10,
  effectiveGasPrice: '10',
  cumulativeGasUsed: '100',
  logs: [],
};

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
      send: stub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>(),
      type: stub<[], SupportedBridge>(),
    };

    // Stub helper functions using sinon.replace for ESM compatibility
    executeDestinationCallbacksStub = stub(callbacks, 'executeDestinationCallbacks').resolves();
    getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances');
    // Configure default behavior for getMarkBalances
    getMarkBalancesStub.callsFake(async () => new Map());
    getERC20ContractStub = stub(contractHelpers, 'getERC20Contract');
    checkAndApproveERC20Stub = stub(erc20Helper, 'checkAndApproveERC20').resolves({
      wasRequired: false,
      transactionHash: undefined,
      hadZeroApproval: false,
    });
    submitTransactionWithLoggingStub = stub(transactionHelper, 'submitTransactionWithLogging').resolves({
      submissionType: TransactionSubmissionType.Onchain,
      hash: '0xBridgeTxHash',
      receipt: mockReceipt,
    });

    const mockERC20RouteValues: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      slippages: [0.01, 0.01],
      preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
    };

    const mockNativeRouteValues: RouteRebalancingConfig = {
      origin: 1,
      destination: 42,
      asset: MOCK_ASSET_NATIVE,
      maximum: '5000000000000000000', // 5 ETH
      slippages: [0.005],
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
            {
              address: MOCK_ASSET_ERC20,
              tickerHash: MOCK_ERC20_TICKER_HASH,
              symbol: 'MOCKERC20',
              decimals: 18,
              isNative: false,
              balanceThreshold: '0',
            },
            {
              address: MOCK_ASSET_NATIVE,
              tickerHash: MOCK_NATIVE_TICKER_HASH,
              symbol: 'MOCKNATIVE',
              decimals: 18,
              isNative: true,
              balanceThreshold: '0',
            },
          ],
        },
        '10': {
          providers: ['http://optimismprovider'],
          assets: [
            {
              address: MOCK_ASSET_ERC20,
              tickerHash: MOCK_ERC20_TICKER_HASH,
              symbol: 'MOCKERC20',
              decimals: 18,
              isNative: false,
              balanceThreshold: '0',
            },
          ],
        },
        '42': {
          providers: ['http://kovanprovider'],
          assets: [
            {
              address: MOCK_ASSET_NATIVE,
              tickerHash: MOCK_NATIVE_TICKER_HASH,
              symbol: 'MOCKNATIVE',
              decimals: 18,
              isNative: true,
              balanceThreshold: '0',
            },
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

  it('should return early when rebalance is paused', async () => {
    mockRebalanceCache.isPaused.resolves(true);
    
    const result = await rebalanceInventory(mockContext);
    
    expect(result).to.be.empty;
    expect(mockLogger.warn.calledWith('Rebalance loop is paused')).to.be.true;
    expect(executeDestinationCallbacksStub.called).to.be.false;
  });

  it('should execute callbacks first', async () => {
    await rebalanceInventory(mockContext);
    expect(executeDestinationCallbacksStub.calledOnceWith(mockContext)).to.be.true;
  });

  it('should skip route if balance is at or below maximum', async () => {
    const routeToCheck = mockContext.config.routes[0];
    const atMaximumBalance = BigInt(routeToCheck.maximum);
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(
      MOCK_ERC20_TICKER_HASH.toLowerCase(),
      new Map([[routeToCheck.origin.toString(), atMaximumBalance - 1n]]),
    );
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToCheck] } });

    expect(mockLogger.info.calledWith(match(/Balance is at or below maximum, skipping route/))).to.be.true;
    expect(mockRebalanceAdapter.getAdapter.called).to.be.false;
  });

  it('should skip route if no balance found for origin chain', async () => {
    const balances = new Map<string, Map<string, bigint>>();
    getMarkBalancesStub.callsFake(async () => balances);
    const routeToCheck = mockContext.config.routes[0];

    await rebalanceInventory(mockContext);

    expect(mockLogger.warn.calledWith(match(/No balances found for ticker/), match({ route: routeToCheck }))).to.be
      .true;
    expect(mockRebalanceAdapter.getAdapter.called).to.be.false;
  });

  it('should successfully rebalance an ERC20 asset with approval needed', async () => {
    const routeToTest = mockContext.config.routes[0] as RouteRebalancingConfig;
    // Ensure currentBalance is greater than maximum to trigger rebalancing
    const currentBalance = BigInt(routeToTest.maximum) + 1_000_000_000_000_000_000n; // maximum + 1e18 (1 token)
    // Adjust quoteAmount to be realistic for the new currentBalance and pass slippage
    // Simulating a 0.05% slippage: currentBalance - (currentBalance / 2000n)
    const quoteAmount = (currentBalance - currentBalance / 2000n).toString();
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Mock approval transaction and bridge transaction returned serially
    const mockApprovalTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: routeToTest.asset as `0x${string}`,
        data: MOCK_APPROVE_DATA,
        value: 0n,
      },
      memo: 'Approval' as any,
    };

    const mockBridgeTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: MOCK_BRIDGE_A_SPENDER,
        data: '0xbridgeData' as Hex,
        value: 0n,
      },
      memo: RebalanceTransactionMemo.Rebalance,
    };

    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockSpecificBridgeAdapter as any);

    // Simplify the stub for debugging
    mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
    mockSpecificBridgeAdapter.send
      .withArgs(
        MOCK_OWN_ADDRESS,
        MOCK_OWN_ADDRESS,
        currentBalance.toString(),
        match({ ...routeToTest, preferences: [SupportedBridge.Across] }),
      )
      .resolves([mockApprovalTxRequest, mockBridgeTxRequest]);

    await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [SupportedBridge.Across] }] },
    });

    expect(getMarkBalancesStub.calledOnce).to.be.true;
    expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).to.be.true;
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;

    // Check that transaction submission helper was called twice (approval + bridge)
    expect(submitTransactionWithLoggingStub.calledTwice).to.be.true;

    // Check the approval transaction
    const approvalTxCall = submitTransactionWithLoggingStub.firstCall.args[0];
    expect(approvalTxCall.txRequest.to).to.equal(routeToTest.asset);
    expect(approvalTxCall.txRequest.data).to.equal(MOCK_APPROVE_DATA);

    // Check the bridge transaction
    const bridgeTxCall = submitTransactionWithLoggingStub.secondCall.args[0];
    expect(bridgeTxCall.txRequest.to).to.equal(MOCK_BRIDGE_A_SPENDER);
    expect(bridgeTxCall.txRequest.data).to.equal('0xbridgeData');

    const expectedAction: Partial<RebalanceAction> = {
      bridge: MOCK_BRIDGE_TYPE_A,
      amount: currentBalance.toString(),
      origin: routeToTest.origin,
      destination: routeToTest.destination,
      asset: routeToTest.asset,
      transaction: '0xBridgeTxHash',
      recipient: MOCK_OWN_ADDRESS,
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
    // Reset and configure the stub to handle any arguments
    getMarkBalancesStub.reset();
    getMarkBalancesStub.callsFake(async () => balances);

    // First preference (Across) returns no adapter
    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(undefined as any);
    // Second preference (Stargate) returns the mock adapter
    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockSpecificBridgeAdapter as any);
    mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_B); // Ensure type reflects the successful adapter
    mockSpecificBridgeAdapter.getReceivedAmount.resolves('99'); // Assume success for the second bridge
    mockSpecificBridgeAdapter.send.resolves([
      {
        transaction: { to: '0xOtherSpender', data: '0xbridgeData', value: 0n },
        memo: RebalanceTransactionMemo.Rebalance,
      },
    ]); // Assume success for the second bridge

    // Mock allowance and contract for the second bridge attempt (assuming ERC20)
    const mockContractInstance = {
      read: { allowance: stub().resolves(1000n) },
      abi: erc20Abi,
      address: MOCK_ASSET_ERC20,
    };
    getERC20ContractStub
      .withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    expect(
      mockLogger.warn.calledWith(match(/Adapter not found for bridge type/), match({ bridgeType: MOCK_BRIDGE_TYPE_A })),
    ).to.be.true;
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
    // Reset and configure the stub to handle any arguments
    getMarkBalancesStub.reset();
    getMarkBalancesStub.callsFake(async () => balances);

    const mockAdapterA = { ...mockSpecificBridgeAdapter, getReceivedAmount: stub().rejects(new Error('Quote failed')) };
    const mockAdapterB = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves('99'),
      send: stub().resolves([
        {
          transaction: { to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: stub().returns(MOCK_BRIDGE_TYPE_B),
    };

    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockAdapterA as any);
    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockAdapterB as any);

    // Mock allowance and contract for the second bridge attempt (assuming ERC20)
    const mockContractInstance = {
      read: { allowance: stub().resolves(1000n) },
      abi: erc20Abi,
      address: MOCK_ASSET_ERC20,
    };
    getERC20ContractStub
      .withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    expect(
      mockLogger.error.calledWith(match(/Failed to get quote from adapter/), match({ bridgeType: MOCK_BRIDGE_TYPE_A })),
    ).to.be.true;
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
    // Reset and configure the stub to handle any arguments
    getMarkBalancesStub.reset();
    getMarkBalancesStub.callsFake(async () => balances);

    const mockAdapterA = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves(lowQuote),
      type: stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    const mockAdapterB = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves('9950'),
      send: stub().resolves([
        {
          transaction: { to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: stub().returns(MOCK_BRIDGE_TYPE_B),
    };

    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockAdapterA as any);
    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockAdapterB as any);

    // Mock allowance and contract for the second bridge attempt (assuming ERC20)
    const mockContractInstance = {
      read: { allowance: stub().resolves(10000n) },
      abi: erc20Abi,
      address: MOCK_ASSET_ERC20,
    };
    getERC20ContractStub
      .withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    expect(
      mockLogger.warn.calledWith(
        match(/Quote does not meet slippage requirements/),
        match({ bridgeType: MOCK_BRIDGE_TYPE_A }),
      ),
    ).to.be.true;
    expect(mockAdapterA.getReceivedAmount.calledOnce).to.be.true;
    expect(mockAdapterB.getReceivedAmount.calledOnce).to.be.true; // Ensure B was tried
    // Add assertions to confirm bridge B logic executed
  });

  it('should try the next bridge preference if adapter send fails', async () => {
    const routeToTest = mockContext.config.routes[0];
    const balances = new Map<string, Map<string, bigint>>();
    const balanceForRoute = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
    // Reset and configure the stub to handle any arguments
    getMarkBalancesStub.reset();
    getMarkBalancesStub.callsFake(async () => balances);

    // Adjust getReceivedAmount to pass slippage check
    const receivedAmountForSlippagePass = balanceForRoute.toString();

    const mockAdapterA_sendFails = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves(receivedAmountForSlippagePass),
      send: stub().rejects(new Error('Send failed')),
      type: stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    const mockAdapterB_sendFails = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves(receivedAmountForSlippagePass),
      send: stub().resolves([
        {
          transaction: { to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: stub().returns(MOCK_BRIDGE_TYPE_B),
    };

    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockAdapterA_sendFails as any);
    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_B).returns(mockAdapterB_sendFails as any);

    // Mock allowance and contract for the second bridge attempt (assuming ERC20)
    const mockContractInstance = {
      read: { allowance: stub().resolves(1000n) },
      abi: erc20Abi,
      address: MOCK_ASSET_ERC20,
    };
    getERC20ContractStub
      .withArgs(match.any, routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    expect(
      mockLogger.error.calledWith(
        match(/Failed to get bridge transaction request from adapter/),
        match({ bridgeType: MOCK_BRIDGE_TYPE_A }),
      ),
    ).to.be.true;
    expect(mockAdapterA_sendFails.send.calledOnce).to.be.true;
    expect(mockAdapterB_sendFails.send.calledOnce).to.be.true; // Ensure B send was tried
    // Add assertions to confirm bridge B logic executed
  });

  it('should successfully rebalance an ERC20 asset with sufficient allowance', async () => {
    const currentBalance = 1000n;
    const routeToTest = {
      ...(mockContext.config.routes[0] as RouteRebalancingConfig),
      maximum: (currentBalance - 1n).toString(),
    };
    const quoteAmount = '999';
    const balances = new Map<string, Map<string, bigint>>();
    // Corrected key for the inner map to use routeToTest.origin.toString()
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    const mockTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: MOCK_BRIDGE_A_SPENDER, // Spender for the bridge
        data: '0xbridgeData' as Hex,
        value: 0n,
      },
      memo: RebalanceTransactionMemo.Rebalance,
    };

    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE_A).returns(mockSpecificBridgeAdapter as any);
    mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_A);
    mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
    mockSpecificBridgeAdapter.send
      .withArgs(MOCK_OWN_ADDRESS, MOCK_OWN_ADDRESS, currentBalance.toString(), match.object)
      .resolves([mockTxRequest]);

    await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [MOCK_BRIDGE_TYPE_A] }] },
    });

    expect(getMarkBalancesStub.calledOnce).to.be.true;
    expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).to.be.true;
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;

    // Check that transaction submission helper was called for the bridge transaction
    expect(submitTransactionWithLoggingStub.calledOnce).to.be.true;
    const txCall = submitTransactionWithLoggingStub.firstCall.args[0];
    expect(txCall.txRequest.to).to.equal(MOCK_BRIDGE_A_SPENDER);
    expect(txCall.txRequest.data).to.equal('0xbridgeData');

    expect(mockRebalanceCache.addRebalances.calledOnce).to.be.true;
  });

  // Add more tests: Native success, other errors...
});

describe('Reserve Amount Functionality', () => {
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
  let submitTransactionWithLoggingStub: SinonStub;

  const MOCK_REQUEST_ID = 'reserve-test-request-id';
  const MOCK_OWN_ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const MOCK_ASSET_ERC20 = '0xErc20AssetAddress' as `0x${string}`;
  const MOCK_BRIDGE_TYPE = SupportedBridge.Across;
  const MOCK_ERC20_TICKER_HASH = '0xerc20tickerhashtest' as `0x${string}`;

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockRebalanceCache = createStubInstance(RebalanceCache);
    mockChainService = createStubInstance(ChainService);
    mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
    mockPrometheus = createStubInstance(PrometheusAdapter);

    mockSpecificBridgeAdapter = {
      getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
      send: stub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>(),
      type: stub<[], SupportedBridge>(),
    };

    // Stub helper functions
    executeDestinationCallbacksStub = stub(callbacks, 'executeDestinationCallbacks').resolves();
    getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances').callsFake(async () => new Map());
    submitTransactionWithLoggingStub = stub(transactionHelper, 'submitTransactionWithLogging').resolves({
      hash: '0xBridgeTxHash',
      submissionType: TransactionSubmissionType.Onchain,
      receipt: mockReceipt,
    });

    mockContext = {
      logger: mockLogger,
      requestId: MOCK_REQUEST_ID,
      rebalanceCache: mockRebalanceCache,
      config: {
        routes: [],
        ownAddress: MOCK_OWN_ADDRESS,
        chains: {
          '1': {
            providers: ['http://localhost:8545'],
            assets: [
              {
                symbol: 'ERC20',
                address: MOCK_ASSET_ERC20,
                decimals: 18,
                tickerHash: MOCK_ERC20_TICKER_HASH,
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            invoiceAge: 1,
            gasThreshold: '5000000000000000',
            deployments: {
              everclear: '0xEverclearAddress',
              permit2: '0xPermit2Address',
              multicall3: '0xMulticall3Address',
            },
          },
          '10': {
            providers: ['http://localhost:8546'],
            assets: [
              {
                symbol: 'ERC20',
                address: MOCK_ASSET_ERC20,
                decimals: 18,
                tickerHash: MOCK_ERC20_TICKER_HASH,
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            invoiceAge: 1,
            gasThreshold: '5000000000000000',
            deployments: {
              everclear: '0xEverclearAddress',
              permit2: '0xPermit2Address',
              multicall3: '0xMulticall3Address',
            },
          },
        },
      },
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
      prometheus: mockPrometheus,
    } as any;

    mockRebalanceCache.isPaused.resolves(false);
    mockRebalanceCache.addRebalances.resolves();
    mockRebalanceAdapter.getAdapter.withArgs(MOCK_BRIDGE_TYPE).returns(mockSpecificBridgeAdapter as any);
    mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE);
  });

  afterEach(() => {
    restore();
  });

  it('should bridge only the amount minus reserve when reserve is configured', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      reserve: '3000000000000000000', // 3 tokens reserve
      slippages: [0.01],
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens
    const expectedAmountToBridge = BigInt('17000000000000000000'); // 20 - 3 = 17 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['1', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    const mockTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: '0xBridgeAddress' as `0x${string}`,
        data: '0xbridgeData' as Hex,
        value: 0n,
      },
      memo: RebalanceTransactionMemo.Rebalance,
    };

    mockSpecificBridgeAdapter.getReceivedAmount.resolves(expectedAmountToBridge.toString());
    mockSpecificBridgeAdapter.send.resolves([mockTxRequest]);

    await rebalanceInventory(mockContext);

    // Verify the amount sent to bridge is currentBalance - reserve
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).to.equal(expectedAmountToBridge.toString());

    expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).to.equal(expectedAmountToBridge.toString());

    // Verify rebalance action records the correct amount
    expect(mockRebalanceCache.addRebalances.calledOnce).to.be.true;
    const rebalanceAction = mockRebalanceCache.addRebalances.firstCall.args[0][0] as RebalanceAction;
    expect(rebalanceAction.amount).to.equal(expectedAmountToBridge.toString());
  });

  it('should skip rebalancing when amount to bridge after reserve is zero', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      reserve: '15000000000000000000', // 15 tokens reserve
      slippages: [0.01],
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('15000000000000000000'); // 15 tokens (same as reserve)
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['1', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Should not attempt to get quote or send transaction
    expect(mockSpecificBridgeAdapter.getReceivedAmount.called).to.be.false;
    expect(mockSpecificBridgeAdapter.send.called).to.be.false;
    expect(submitTransactionWithLoggingStub.called).to.be.false;
    expect(mockRebalanceCache.addRebalances.called).to.be.false;

    // Should log that amount to bridge is zero
    expect(mockLogger.info.calledWith('Amount to bridge after reserve is zero or negative, skipping route')).to.be.true;
  });

  it('should skip rebalancing when amount to bridge after reserve is negative', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      reserve: '25000000000000000000', // 25 tokens reserve (more than current balance)
      slippages: [0.01],
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens (less than reserve)
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['1', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Should not attempt to get quote or send transaction
    expect(mockSpecificBridgeAdapter.getReceivedAmount.called).to.be.false;
    expect(mockSpecificBridgeAdapter.send.called).to.be.false;
    expect(submitTransactionWithLoggingStub.called).to.be.false;
    expect(mockRebalanceCache.addRebalances.called).to.be.false;

    // Should log that amount to bridge is negative
    expect(mockLogger.info.calledWith('Amount to bridge after reserve is zero or negative, skipping route')).to.be.true;
  });

  it('should work normally without reserve (backward compatibility)', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      // No reserve field
      slippages: [0.01],
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['1', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    const mockTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: '0xBridgeAddress' as `0x${string}`,
        data: '0xbridgeData' as Hex,
        value: 0n,
      },
      memo: RebalanceTransactionMemo.Rebalance,
    };

    mockSpecificBridgeAdapter.getReceivedAmount.resolves(currentBalance.toString());
    mockSpecificBridgeAdapter.send.resolves([mockTxRequest]);

    await rebalanceInventory(mockContext);

    // Should bridge the full current balance (no reserve)
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).to.equal(currentBalance.toString());

    expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).to.equal(currentBalance.toString());

    // Verify rebalance action records the full amount
    expect(mockRebalanceCache.addRebalances.calledOnce).to.be.true;
    const rebalanceAction = mockRebalanceCache.addRebalances.firstCall.args[0][0] as RebalanceAction;
    expect(rebalanceAction.amount).to.equal(currentBalance.toString());
  });

  it('should use slippage calculation based on amount to bridge (minus reserve)', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      reserve: '5000000000000000000', // 5 tokens reserve
      slippages: [100], // 1% slippage (100 basis points)
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens
    const amountToBridge = BigInt('15000000000000000000'); // 20 - 5 = 15 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['1', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Quote should be slightly less than amountToBridge to test slippage logic
    const receivedAmount = BigInt('14850000000000000000'); // 14.85 tokens (1% slippage exactly)

    const mockTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: '0xBridgeAddress' as `0x${string}`,
        data: '0xbridgeData' as Hex,
        value: 0n,
      },
      memo: RebalanceTransactionMemo.Rebalance,
    };

    mockSpecificBridgeAdapter.getReceivedAmount.resolves(receivedAmount.toString());
    mockSpecificBridgeAdapter.send.resolves([mockTxRequest]);

    await rebalanceInventory(mockContext);

    // Should succeed because slippage is exactly at the limit
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).to.equal(amountToBridge.toString());

    expect(mockSpecificBridgeAdapter.send.calledOnce).to.be.true;
    expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).to.equal(amountToBridge.toString());
  });
});

describe('Decimal Handling', () => {
  it('should handle USDC (6 decimals) correctly when comparing balances and calling adapters', async () => {
    // Setup for 6-decimal USDC testing
    const MOCK_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`;
    const MOCK_USDC_TICKER_HASH = '0xusdctickerhashtest' as `0x${string}`;

    const mockSpecificBridgeAdapter = {
      getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
      send: stub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>(),
      type: stub<[], SupportedBridge>().returns(SupportedBridge.Binance),
    };

    stub(callbacks, 'executeDestinationCallbacks').resolves();
    const getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances');
    stub(transactionHelper, 'submitTransactionWithLogging').resolves({
      hash: '0xBridgeTxHash',
      submissionType: TransactionSubmissionType.Onchain,
      receipt: mockReceipt,
    });

    const mockLogger = createStubInstance(Logger);
    const mockRebalanceCache = createStubInstance(RebalanceCache);
    const mockChainService = createStubInstance(ChainService);
    const mockRebalanceAdapter = createStubInstance(RebalanceAdapter);

    mockRebalanceCache.isPaused.resolves(false);
    mockRebalanceCache.addRebalances.resolves();
    mockChainService.getAddress.resolves({
      '42161': '0x1111111111111111111111111111111111111111',
      '10': '0x1111111111111111111111111111111111111111'
    });
    mockRebalanceAdapter.getAdapter.returns(mockSpecificBridgeAdapter as any);

    const route: RouteRebalancingConfig = {
      origin: 42161,
      destination: 10,
      asset: MOCK_USDC_ADDRESS,
      maximum: '1000000000000000000', // 1 USDC in 18 decimal format
      reserve: '47000000000000000000', // 47 USDC in 18 decimal format
      slippages: [50],
      preferences: [SupportedBridge.Binance],
    };

    const mockContext = {
      logger: mockLogger,
      requestId: 'decimal-test',
      rebalanceCache: mockRebalanceCache,
      config: {
        routes: [route],
        ownAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        chains: {
          '42161': {
            providers: ['http://localhost:8545'],
            assets: [{ symbol: 'USDC', address: MOCK_USDC_ADDRESS, decimals: 6, tickerHash: MOCK_USDC_TICKER_HASH, isNative: false, balanceThreshold: '0' }],
            invoiceAge: 1, gasThreshold: '5000000000000000',
            deployments: { everclear: '0xEverclearAddress', permit2: '0xPermit2Address', multicall3: '0xMulticall3Address' },
          },
          '10': {
            providers: ['http://localhost:8546'],
            assets: [{ symbol: 'USDC', address: MOCK_USDC_ADDRESS, decimals: 6, tickerHash: MOCK_USDC_TICKER_HASH, isNative: false, balanceThreshold: '0' }],
            invoiceAge: 1, gasThreshold: '5000000000000000',
            deployments: { everclear: '0xEverclearAddress', permit2: '0xPermit2Address', multicall3: '0xMulticall3Address' },
          },
        },
      },
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
    } as any;

    // Balance: 48.796999 USDC (in 18 decimals from balance system)
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_USDC_TICKER_HASH.toLowerCase(), new Map([['42161', BigInt('48796999000000000000')]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Expected: 48796999 - 47000000 = 1796999 (in 6-decimal USDC format)
    const expectedAmountToBridge = '1796999';

    mockSpecificBridgeAdapter.getReceivedAmount.resolves('1790000');
    mockSpecificBridgeAdapter.send.resolves([{
      transaction: { to: '0xBridgeAddress' as `0x${string}`, data: '0xbridgeData' as Hex, value: 0n },
      memo: RebalanceTransactionMemo.Rebalance,
    }]);

    await rebalanceInventory(mockContext);

    // Verify adapters receive amounts in USDC native decimals (6)
    expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).to.equal(expectedAmountToBridge);
    expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).to.equal(expectedAmountToBridge);

    // Verify cache stores native decimal amount
    const rebalanceAction = mockRebalanceCache.addRebalances.firstCall.args[0][0] as RebalanceAction;
    expect(rebalanceAction.amount).to.equal(expectedAmountToBridge);

    // Cleanup
    restore();
  });

  it('should skip USDC route when balance is at maximum', async () => {
    const MOCK_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`;
    const MOCK_USDC_TICKER_HASH = '0xusdctickerhashtest' as `0x${string}`;

    const mockSpecificBridgeAdapter = {
      getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
      send: stub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>(),
      type: stub<[], SupportedBridge>().returns(SupportedBridge.Binance),
    };

    const executeDestinationCallbacksStub = stub(callbacks, 'executeDestinationCallbacks').resolves();
    const getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances');

    const mockLogger = createStubInstance(Logger);
    const mockRebalanceCache = createStubInstance(RebalanceCache);
    const mockRebalanceAdapter = createStubInstance(RebalanceAdapter);

    mockRebalanceCache.isPaused.resolves(false);
    mockRebalanceAdapter.getAdapter.returns(mockSpecificBridgeAdapter as any);

    const mockContext = {
      logger: mockLogger,
      requestId: 'decimal-skip-test',
      rebalanceCache: mockRebalanceCache,
      config: {
        routes: [{
          origin: 42161, destination: 10, asset: MOCK_USDC_ADDRESS,
          maximum: '1000000000000000000', // 1 USDC in 18 decimal format
          slippages: [50], preferences: [SupportedBridge.Binance],
        }],
        ownAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        chains: {
          '42161': {
            providers: ['http://localhost:8545'],
            assets: [{ symbol: 'USDC', address: MOCK_USDC_ADDRESS, decimals: 6, tickerHash: MOCK_USDC_TICKER_HASH, isNative: false, balanceThreshold: '0' }],
            invoiceAge: 1, gasThreshold: '5000000000000000',
            deployments: { everclear: '0xEverclearAddress', permit2: '0xPermit2Address', multicall3: '0xMulticall3Address' },
          },
        },
      },
      rebalance: mockRebalanceAdapter,
    } as any;

    // Balance exactly at maximum (1 USDC in 18 decimals)
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_USDC_TICKER_HASH.toLowerCase(), new Map([['42161', BigInt('1000000000000000000')]]));
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Should skip due to balance being at maximum
    expect(mockLogger.info.calledWith(match(/Balance is at or below maximum, skipping route/))).to.be.true;
    expect(mockSpecificBridgeAdapter.getReceivedAmount.called).to.be.false;

    // Cleanup
    restore();
  });

});
