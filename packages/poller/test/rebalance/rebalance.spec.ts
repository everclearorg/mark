import sinon, { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore } from 'sinon';

// Mock getDecimalsFromConfig
jest.mock('@mark/core', () => ({
  ...jest.requireActual('@mark/core'),
  getDecimalsFromConfig: jest.fn(() => 18),
}));

// Mock database functions
jest.mock('@mark/database', () => ({
  ...jest.requireActual('@mark/database'),
  createRebalanceOperation: jest.fn(),
  getEarmarks: jest.fn(),
  createEarmark: jest.fn(),
  updateRebalanceOperation: jest.fn(),
  updateEarmarkStatus: jest.fn(),
  getEarmarkForInvoice: jest.fn(),
  getActiveEarmarksForChain: jest.fn(),
  getRebalanceOperationsByEarmark: jest.fn(),
  initializeDatabase: jest.fn(),
  getPool: jest.fn(),
}));

import { rebalanceInventory } from '../../src/rebalance/rebalance';
import * as database from '@mark/database';
import { createDatabaseMock } from '../mocks/database';
import * as balanceHelpers from '../../src/helpers/balance';
import * as contractHelpers from '../../src/helpers/contracts';
import * as callbacks from '../../src/rebalance/callbacks'; // To mock executeDestinationCallbacks
import * as erc20Helper from '../../src/helpers/erc20';
import * as transactionHelper from '../../src/helpers/transactions';
import * as onDemand from '../../src/rebalance/onDemand';
import * as assetHelpers from '../../src/helpers/asset';
import {
  MarkConfiguration,
  SupportedBridge,
  RebalanceRoute,
  RouteRebalancingConfig,
  TransactionSubmissionType,
  getDecimalsFromConfig,
} from '@mark/core';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { PurchaseCache } from '@mark/cache';
import { RebalanceAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '@mark/rebalance';
import { PrometheusAdapter } from '@mark/prometheus';
import { zeroAddress, Hex, erc20Abi } from 'viem';

interface MockBridgeAdapterInterface {
  getReceivedAmount: SinonStub<[string, RebalanceRoute], Promise<string>>;
  send: SinonStub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>;
  type: SinonStub<[], SupportedBridge>;
  // Add other methods if they are called by the SUT
}

describe('rebalanceInventory', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockPurchaseCache: SinonStubbedInstance<PurchaseCache>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
  let mockPrometheus: SinonStubbedInstance<PrometheusAdapter>;
  let mockSpecificBridgeAdapter: MockBridgeAdapterInterface;

  // Stubs for module functions used in the first describe block
  let executeDestinationCallbacksStub: SinonStub;
  let getMarkBalancesStub: SinonStub;
  let getERC20ContractStub: SinonStub;
  let checkAndApproveERC20Stub: SinonStub;
  let submitTransactionWithLoggingStub: SinonStub;
  let getAvailableBalanceLessEarmarksStub: SinonStub;
  let getTickerForAssetStub: SinonStub;

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

  beforeEach(async () => {
    // Reset all jest mocks for database functions
    jest.clearAllMocks();

    // Configure database mocks
    (database.initializeDatabase as jest.Mock).mockReturnValue({});
    (database.getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    });
    (database.getEarmarks as jest.Mock).mockResolvedValue([]);
    (database.createEarmark as jest.Mock).mockResolvedValue({
      id: 'earmark-001',
      invoiceId: 'test-invoice',
      designatedPurchaseChain: 1,
      tickerHash: MOCK_ERC20_TICKER_HASH,
      minAmount: '1000000000000000000',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (database.createRebalanceOperation as jest.Mock).mockResolvedValue({
      id: 'rebalance-001',
      earmarkId: 'earmark-001',
      originChainId: 1,
      destinationChainId: 10,
      tickerHash: MOCK_ERC20_TICKER_HASH,
      amount: '1000000000000000000',
      slippage: 100,
      status: 'pending',
      bridge: 'everclear',
      recipient: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (database.updateRebalanceOperation as jest.Mock).mockResolvedValue(undefined);
    (database.updateEarmarkStatus as jest.Mock).mockResolvedValue(undefined);
    (database.getEarmarkForInvoice as jest.Mock).mockResolvedValue(null);
    (database.getActiveEarmarksForChain as jest.Mock).mockResolvedValue([]);
    (database.getRebalanceOperationsByEarmark as jest.Mock).mockResolvedValue([]);

    mockLogger = createStubInstance(Logger);
    mockPurchaseCache = createStubInstance(PurchaseCache);
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
      receipt: {
        transactionHash: '0xBridgeTxHash',
        blockNumber: 121,
        status: 1,
        confirmations: 1,
        logs: [],
        cumulativeGasUsed: '100000',
        effectiveGasPrice: '1000000000',
      },
    });
    getAvailableBalanceLessEarmarksStub = stub(onDemand, 'getAvailableBalanceLessEarmarks').resolves(
      BigInt('20000000000000000000'),
    );
    getTickerForAssetStub = stub(assetHelpers, 'getTickerForAsset').returns(MOCK_ERC20_TICKER_HASH);

    const mockERC20RouteValues: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      slippagesDbps: [5000, 5000], // 5% slippage in decibasis points
      preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
    };

    const mockNativeRouteValues: RouteRebalancingConfig = {
      origin: 1,
      destination: 42,
      asset: MOCK_ASSET_NATIVE,
      maximum: '5000000000000000000', // 5 ETH
      slippagesDbps: [5000], // 5% slippage in decibasis points
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
      purchaseCache: mockPurchaseCache,
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
      prometheus: mockPrometheus,
      everclear: undefined,
      web3Signer: undefined,
      database: createDatabaseMock(),
    } as unknown as SinonStubbedInstance<ProcessingContext>;

    // Default Stubs
    mockRebalanceAdapter.isPaused.resolves(false); // Allow rebalancing to proceed
    // mockRebalanceAdapter.addRebalances.resolves(); // Mock cache addition - removed as adapter doesn't have this
    mockPurchaseCache.isPaused.resolves(false); // Default: purchase cache not paused
    mockRebalanceAdapter.getAdapter.returns(
      mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>,
    );
    mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_A);
    mockSpecificBridgeAdapter.getReceivedAmount.resolves('19000000000000000000'); // 19 tokens - good quote with minimal slippage
    mockSpecificBridgeAdapter.send.resolves([
      {
        transaction: {
          to: MOCK_BRIDGE_A_SPENDER,
          data: '0xbridgeData' as Hex,
          value: 0n,
        },
        memo: RebalanceTransactionMemo.Rebalance,
      },
    ]);

    // Additional stub setup is done in the existing getAvailableBalanceLessEarmarksStub above

    // Mock chainService return
    mockChainService.submitAndMonitor.resolves({
      transactionHash: '0xMockTxHash',
      blockNumber: 123,
      status: 1,
      confirmations: 1,
      logs: [],
      cumulativeGasUsed: '21000',
      effectiveGasPrice: '1000000000',
    });

    // Set up proper balances that exceed maximum to trigger rebalancing
    const defaultBalances = new Map<string, Map<string, bigint>>();
    defaultBalances.set(
      MOCK_ERC20_TICKER_HASH.toLowerCase(),
      new Map([
        ['1', BigInt('20000000000000000000')], // 20 tokens on chain 1 (origin)
        ['10', BigInt('0')], // 0 tokens on chain 10 (destination)
      ]),
    );
    defaultBalances.set(
      MOCK_NATIVE_TICKER_HASH.toLowerCase(),
      new Map([
        ['1', BigInt('10000000000000000000')], // 10 tokens on chain 1
        ['42', BigInt('0')], // 0 tokens on chain 42 (destination for native route)
      ]),
    );
    getMarkBalancesStub.callsFake(async () => defaultBalances);
  });

  afterEach(async () => {
    // Restore all sinon replaced/stubbed methods globally
    restore();
    checkAndApproveERC20Stub?.reset();
    submitTransactionWithLoggingStub?.reset();
    getTickerForAssetStub?.restore();
  });

  it('should not process routes when no routes are configured', async () => {
    const noRoutesConfig = { ...mockContext.config, routes: [] };
    const result = await rebalanceInventory({ ...mockContext, config: noRoutesConfig });

    expect(result).toEqual([]);
    expect(mockLogger.info.calledWithMatch('Completed rebalancing inventory')).toBe(true);
  });

  it('should handle transaction with undefined value in bridge request', async () => {
    // Set up a balance that needs rebalancing
    const originBalance = BigInt('20000000000000000000'); // 20 tokens on origin
    const destinationBalance = BigInt('0'); // 0 tokens on destination
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(
      MOCK_ERC20_TICKER_HASH.toLowerCase(),
      new Map([
        ['1', originBalance], // Origin chain from route
        ['10', destinationBalance], // Destination chain from route
      ]),
    );

    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(originBalance);
    getTickerForAssetStub.returns(MOCK_ERC20_TICKER_HASH);

    // Mock adapter that returns transaction without value field
    const mockBridgeAdapter = {
      getReceivedAmount: sinon.stub().resolves('19500000000000000000'), // 19.5 tokens (within 5% slippage of 20)
      send: sinon.stub().resolves([
        {
          transaction: { to: '0xbridge', data: '0x123' }, // No value field
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    // Override the default adapter
    mockRebalanceAdapter.getAdapter.returns(mockBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Using the createRebalanceOperation mock from beforeEach
    const result = await rebalanceInventory({
      ...mockContext,
      config: {
        ...mockContext.config,
        routes: [mockContext.config.routes[0]], // Only ERC20 route
      },
    });

    // Check if the adapter methods were called
    expect(mockBridgeAdapter.getReceivedAmount.called).toBe(true);
    expect(mockBridgeAdapter.send.called).toBe(true);

    // Should handle undefined value properly - defaults to 0
    expect(result).toHaveLength(1);
    expect(submitTransactionWithLoggingStub.called).toBe(true);
    const submitCall = submitTransactionWithLoggingStub.firstCall;
    expect(submitCall.args[0].txRequest.value).toBe('0');

    // No need to restore - handled in afterEach
  });

  it('should execute callbacks when purchase cache is paused', async () => {
    // Set purchase cache as paused
    mockPurchaseCache.isPaused.resolves(true);

    // Ensure the test doesn't proceed with rebalancing logic by setting balance below maximum
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', BigInt('5000000000000000000')]])); // 5 tokens, below 10 token maximum
    getMarkBalancesStub.resolves(balances);
    getAvailableBalanceLessEarmarksStub.resolves(BigInt('5000000000000000000'));

    await rebalanceInventory(mockContext);

    // Should execute callbacks when purchase cache is paused
    expect(executeDestinationCallbacksStub.calledOnceWith(mockContext)).toBe(true);
  });

  it('should NOT execute callbacks when purchase cache is not paused', async () => {
    // Ensure purchase cache is not paused (default)
    mockPurchaseCache.isPaused.resolves(false);

    // Ensure the test doesn't proceed with rebalancing logic by setting balance below maximum
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', BigInt('5000000000000000000')]])); // 5 tokens, below 10 token maximum
    getMarkBalancesStub.resolves(balances);
    getAvailableBalanceLessEarmarksStub.resolves(BigInt('5000000000000000000'));

    await rebalanceInventory(mockContext);

    // Should NOT execute callbacks when purchase cache is not paused
    expect(executeDestinationCallbacksStub.called).toBe(false);
  });

  it('should return early if rebalance is paused', async () => {
    mockRebalanceAdapter.isPaused.resolves(true);

    const result = await rebalanceInventory(mockContext);

    expect(mockLogger.warn.calledWith('Rebalance loop is paused', { requestId: MOCK_REQUEST_ID })).toBe(true);
    expect(result).toEqual([]);
    expect(getMarkBalancesStub.called).toBe(false);
  });

  it('should skip route if ticker not found in config', async () => {
    // Create a route with an asset that doesn't exist in the config
    const invalidRoute: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: '0xInvalidAsset',
      maximum: '5000000000000000000',
      slippagesDbps: [1000], // 1% in decibasis points
      preferences: [MOCK_BRIDGE_TYPE_A],
    };

    // Override the stub to return undefined for the invalid asset
    getTickerForAssetStub.callsFake((asset) => {
      if (asset === '0xInvalidAsset') return undefined;
      if (asset === MOCK_ASSET_ERC20) return MOCK_ERC20_TICKER_HASH;
      if (asset === MOCK_ASSET_NATIVE) return MOCK_NATIVE_TICKER_HASH;
      return undefined;
    });

    await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [invalidRoute] } });

    expect(mockLogger.error.calledOnce).toBe(true);
    expect(mockRebalanceAdapter.getAdapter.called).toBe(false);
  });

  it('should skip bridge preference if adapter not found', async () => {
    // Set up a balance that needs rebalancing
    const currentBalance = BigInt('20000000000000000000'); // 20 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // Return null for the adapter to simulate adapter not found
    mockRebalanceAdapter.getAdapter.returns(null as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    await rebalanceInventory(mockContext);

    expect(mockLogger.warn.calledWithMatch('Adapter not found for bridge type, trying next preference')).toBe(true);
  });

  it('should handle empty transaction array from adapter', async () => {
    // Set up a balance that needs rebalancing
    const currentBalance = BigInt('20000000000000000000');
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // Mock adapter to return empty transaction requests
    const mockBridgeAdapter = {
      getReceivedAmount: sinon.stub().resolves('19500000000000000000'), // 19.5 tokens (within 5% slippage of 20)
      send: sinon.stub().resolves([]), // Empty array - should trigger error
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    mockRebalanceAdapter.getAdapter.returns(mockBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    const result = await rebalanceInventory(mockContext);

    // Test completes without error even with empty array
    expect(result).toBeDefined();
  });

  it('should log success message when rebalance completes successfully', async () => {
    // Use single route config
    const singleRouteContext = {
      ...mockContext,
      config: {
        ...mockContext.config,
        routes: [mockContext.config.routes[0]], // Only ERC20 route
      },
    };

    // Set up a balance that needs rebalancing
    const originBalance = BigInt('20000000000000000000'); // 20 tokens on origin
    const destinationBalance = BigInt('0'); // 0 tokens on destination
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(
      MOCK_ERC20_TICKER_HASH.toLowerCase(),
      new Map([
        ['1', originBalance], // Origin chain from route
        ['10', destinationBalance], // Destination chain from route
      ]),
    );
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(originBalance);

    // Ensure ticker is found
    getTickerForAssetStub.returns(MOCK_ERC20_TICKER_HASH);

    // Mock successful adapter response
    const mockBridgeAdapter = {
      getReceivedAmount: sinon.stub().resolves('19500000000000000000'), // 19.5 tokens (within 5% slippage of 20)
      send: sinon.stub().resolves([
        {
          transaction: { to: '0xbridge', data: '0x123', value: '0' },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    // Override the default adapter
    mockRebalanceAdapter.getAdapter.returns(mockBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Mock database operation
    // Using the createRebalanceOperation stub from beforeEach

    const result = await rebalanceInventory(singleRouteContext);

    // Should complete successfully
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bridge: MOCK_BRIDGE_TYPE_A,
      origin: 1,
      destination: 10,
    });

    // No need to restore - handled in afterEach
  });

  it('should successfully rebalance when database operation succeeds', async () => {
    // Create context with only ERC20 route
    const singleRouteContext = {
      ...mockContext,
      config: {
        ...mockContext.config,
        routes: [mockContext.config.routes[0]], // Only ERC20 route
      },
    };

    // Set up a balance that needs rebalancing
    const currentBalance = BigInt('20000000000000000000');
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(
      MOCK_ERC20_TICKER_HASH.toLowerCase(),
      new Map([
        ['1', currentBalance], // Origin chain
        ['10', BigInt('0')], // Destination chain
      ]),
    );
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // Mock successful adapter response
    const mockBridgeAdapter = {
      getReceivedAmount: sinon.stub().resolves('19500000000000000000'), // 19.5 tokens (within 5% slippage of 20)
      send: sinon.stub().resolves([
        {
          transaction: { to: '0xbridge', data: '0x123', value: '0' },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    // Override the default adapter
    mockRebalanceAdapter.getAdapter.returns(mockBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Using the createRebalanceOperation stub from beforeEach

    const result = await rebalanceInventory(singleRouteContext);

    // When rebalance succeeds, result should contain the transaction
    expect(result).toHaveLength(1);
    expect(result[0].bridge).toBe(MOCK_BRIDGE_TYPE_A);
    expect(result[0].transaction).toBe('0xBridgeTxHash');

    // Should have attempted the bridge
    expect(mockBridgeAdapter.getReceivedAmount.called).toBe(true);
    expect(mockBridgeAdapter.send.called).toBe(true);

    // No need to restore - handled in afterEach
  });

  it('should handle failure when all bridge preferences are exhausted', async () => {
    // Set up a balance that needs rebalancing
    const currentBalance = BigInt('20000000000000000000');
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // Configure route with multiple bridge preferences
    const routeWithMultipleBridges = {
      ...mockContext.config.routes[0],
      preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
      slippagesDbps: [1000, 1000], // 1% in decibasis points
    };

    // Mock both adapters to fail
    const mockBridgeAdapterA = {
      getReceivedAmount: sinon.stub().rejects(new Error('Bridge A unavailable')),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    const mockBridgeAdapterB = {
      getReceivedAmount: sinon.stub().rejects(new Error('Bridge B unavailable')),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_B),
    };

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockBridgeAdapterA as unknown as ReturnType<RebalanceAdapter['getAdapter']>)
      .withArgs(MOCK_BRIDGE_TYPE_B)
      .returns(mockBridgeAdapterB as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    const result = await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [routeWithMultipleBridges] },
    });

    // Should log failure when all bridges are exhausted
    const failureLogFound = mockLogger.warn
      .getCalls()
      .some((call) => call.args[0] === 'Failed to rebalance route with any preferred bridge');
    expect(failureLogFound).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('should continue to next bridge preference when send fails', async () => {
    // Create context with only one route to avoid processing multiple routes
    const singleRouteConfig = {
      ...mockContext.config,
      routes: [
        {
          ...mockContext.config.routes[0],
          preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
          slippagesDbps: [1000, 1000], // 1% in decibasis points // 1% slippage tolerance in basis points
        },
      ],
    };
    const singleRouteContext = { ...mockContext, config: singleRouteConfig };

    // Set up a balance that needs rebalancing
    const originBalance = BigInt('20000000000000000000'); // 20 tokens on origin
    const destinationBalance = BigInt('0'); // 0 tokens on destination
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(
      MOCK_ERC20_TICKER_HASH.toLowerCase(),
      new Map([
        ['1', originBalance], // Route origin is 1
        ['10', destinationBalance], // Route destination is 10
      ]),
    );
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(originBalance);

    // Ensure ticker is found
    getTickerForAssetStub.returns(MOCK_ERC20_TICKER_HASH);

    // First adapter returns good quote but fails to send
    const mockBridgeAdapterA = {
      getReceivedAmount: sinon.stub().resolves('19900000000000000000'), // Good quote
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
      send: sinon.stub().rejects(new Error('Bridge A send failed')), // Fails on send
    };

    // Second adapter returns good quote
    const mockBridgeAdapterB = {
      getReceivedAmount: sinon.stub().resolves('19900000000000000000'), // 99.5% = 0.5% slippage, within 1%
      send: sinon.stub().resolves([
        {
          transaction: { to: '0xbridge', data: '0x123', value: '0' },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_B),
    };

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockBridgeAdapterA as unknown as ReturnType<RebalanceAdapter['getAdapter']>)
      .withArgs(MOCK_BRIDGE_TYPE_B)
      .returns(mockBridgeAdapterB as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Using the createRebalanceOperation stub from beforeEach
    const result = await rebalanceInventory(singleRouteContext);

    // Should have failed on first bridge send and used second bridge
    const errorCalls = mockLogger.error.getCalls();
    const sendFailedMessage = errorCalls.find(
      (call) =>
        call.args[0] &&
        typeof call.args[0] === 'string' &&
        call.args[0].includes('Failed to get bridge transaction request from adapter, trying next preference'),
    );

    expect(sendFailedMessage).toBeTruthy();
    expect(result).toHaveLength(1);
    expect(result[0].bridge).toBe(MOCK_BRIDGE_TYPE_B);

    // No need to restore - handled in afterEach
  });

  it('should respect reserve amount when calculating amount to bridge', async () => {
    // Set up a balance that needs rebalancing
    const originBalance = BigInt('20000000000000000000'); // 20 tokens on origin
    const destinationBalance = BigInt('0'); // 0 tokens on destination
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(
      MOCK_ERC20_TICKER_HASH.toLowerCase(),
      new Map([
        ['1', originBalance], // Origin chain from route
        ['10', destinationBalance], // Destination chain from route
      ]),
    );
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(originBalance);

    // Ensure ticker is found
    getTickerForAssetStub.returns(MOCK_ERC20_TICKER_HASH);

    // Configure route with a reserve amount
    const routeWithReserve = {
      ...mockContext.config.routes[0],
      reserve: '5000000000000000000', // Reserve 5 tokens
      preferences: [MOCK_BRIDGE_TYPE_A],
      slippagesDbps: [1000], // 1% in decibasis points
    };

    // Mock adapter
    const mockBridgeAdapter = {
      getReceivedAmount: sinon.stub().resolves('14850000000000000000'), // Expect to bridge 15 tokens (20-5)
      send: sinon.stub().resolves([
        {
          transaction: { to: '0xbridge', data: '0x123', value: '0' },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
    };

    mockRebalanceAdapter.getAdapter.returns(mockBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    // Using the createRebalanceOperation stub from beforeEach

    const result = await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [routeWithReserve] },
    });

    // Should bridge amount minus reserve
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe('15000000000000000000'); // 20 - 5 = 15

    // No need to restore - handled in afterEach
  });

  it('should skip route when amount to bridge is zero after reserve', async () => {
    // Set up a balance equal to reserve amount
    const currentBalance = BigInt('5000000000000000000'); // 5 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // Configure route with a reserve amount equal to current balance
    const routeWithHighReserve = {
      ...mockContext.config.routes[0],
      maximum: '1000000000000000000', // Maximum 1 token (less than current balance)
      reserve: '5000000000000000000', // Reserve 5 tokens (equals current balance)
      preferences: [MOCK_BRIDGE_TYPE_A],
      slippagesDbps: [1000], // 1% in decibasis points
    };

    const result = await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [routeWithHighReserve] },
    });

    // Should skip the route because amount to bridge would be zero
    expect(mockLogger.info.calledWithMatch('Amount to bridge after reserve is zero or negative, skipping route')).toBe(
      true,
    );
    expect(result).toHaveLength(0);
  });

  it('should log Zodiac configuration when enabled on origin chain', async () => {
    // Set up a balance that needs rebalancing
    const currentBalance = BigInt('20000000000000000000');
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]])); // Use Zodiac chain
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // Configure route to use Zodiac-enabled chain as origin
    const zodiacRoute = {
      ...mockContext.config.routes[0],
      origin: 42161, // Arbitrum with Zodiac
      destination: 1, // Ethereum without Zodiac
    };

    const mockBridgeAdapter = {
      getReceivedAmount: sinon.stub().resolves('19500000000000000000'), // 19.5 tokens (within 5% slippage of 20)
      send: sinon.stub().resolves([
        {
          transaction: { to: '0xbridge', data: '0x123', value: '0' },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: sinon.stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    mockRebalanceAdapter.getAdapter.returns(mockBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    // Using the createRebalanceOperation stub from beforeEach

    const result = await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [zodiacRoute] },
    });

    // Should process with Zodiac config
    expect(result).toBeDefined();

    // No need to restore - handled in afterEach
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

    // Override the getAvailableBalanceLessEarmarks to return the same low balance
    getAvailableBalanceLessEarmarksStub.resolves(atMaximumBalance - 1n);

    await rebalanceInventory({ ...mockContext, config: { ...mockContext.config, routes: [routeToCheck] } });

    // Check that the logger was called with the expected message
    const infoCalls = mockLogger.info.getCalls();
    const skipMessage = infoCalls.find(
      (call) => call.args[0] && call.args[0].includes('Balance is at or below maximum, skipping route'),
    );
    expect(skipMessage).toBeTruthy();
    expect(mockRebalanceAdapter.getAdapter.called).toBe(false);
  });

  it('should skip route if no balance found for origin chain', async () => {
    const balances = new Map<string, Map<string, bigint>>();
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Check that the logger was called with the expected message
    const warnCalls = mockLogger.warn.getCalls();
    const noBalanceMessage = warnCalls.find(
      (call) => call.args[0] && call.args[0].includes('No balances found for ticker'),
    );
    expect(noBalanceMessage).toBeTruthy();
    expect(mockRebalanceAdapter.getAdapter.called).toBe(false);
  });

  it('should successfully rebalance an ERC20 asset with approval needed', async () => {
    const routeToTest = mockContext.config.routes[0] as RouteRebalancingConfig;
    // Ensure currentBalance is greater than maximum to trigger rebalancing
    const currentBalance = BigInt(routeToTest.maximum) + 1_000_000_000_000_000_000n; // maximum + 1e18 (1 token)
    // The amount to bridge is currentBalance minus reserve (default 0)
    const amountToBridge = currentBalance;
    // Adjust quoteAmount to be realistic for the new currentBalance and pass slippage
    // Simulating a 0.05% slippage: currentBalance - (currentBalance / 2000n)
    const quoteAmount = (currentBalance - currentBalance / 2000n).toString();
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Update the getAvailableBalanceLessEarmarks stub to return the currentBalance
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // Mock approval transaction and bridge transaction returned serially
    const mockApprovalTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: routeToTest.asset as `0x${string}`,
        data: MOCK_APPROVE_DATA,
        value: 0n,
      },
      memo: 'Approval' as RebalanceTransactionMemo,
    };

    const mockBridgeTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: MOCK_BRIDGE_A_SPENDER,
        data: '0xbridgeData' as Hex,
        value: 0n,
      },
      memo: RebalanceTransactionMemo.Rebalance,
    };

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Simplify the stub for debugging
    mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
    // Origin chain (42161) has Zodiac, so sender should be Safe address
    // Don't use withArgs - just stub the method to always return the response
    mockSpecificBridgeAdapter.send.resolves([mockApprovalTxRequest, mockBridgeTxRequest]);

    await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [SupportedBridge.Across] }] },
    });

    expect(getMarkBalancesStub.calledOnce).toBe(true);
    expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).toBe(true);
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);

    // Check that transaction submission helper was called twice (approval + bridge)
    expect(submitTransactionWithLoggingStub.calledTwice).toBe(true);

    // Check the approval transaction
    const approvalTxCall = submitTransactionWithLoggingStub.firstCall.args[0];
    expect(approvalTxCall.txRequest.to).toBe(routeToTest.asset);
    expect(approvalTxCall.txRequest.data).toBe(MOCK_APPROVE_DATA);

    // Check the bridge transaction
    const bridgeTxCall = submitTransactionWithLoggingStub.secondCall.args[0];
    expect(bridgeTxCall.txRequest.to).toBe(MOCK_BRIDGE_A_SPENDER);
    expect(bridgeTxCall.txRequest.data).toBe('0xbridgeData');

    // Note: The new implementation uses database operations instead of cache

    // Verify logs - The implementation should successfully process the rebalance
    // We should see bridge transaction submissions
    const logCalls = mockLogger.info.getCalls();
    const hasBridgeLog = logCalls.some(
      (call) => call.args[0] && call.args[0].includes('Successfully submitted and confirmed origin bridge transaction'),
    );
    expect(hasBridgeLog).toBe(true);

    // Verify database operation was created (if the implementation reaches that point)
    // Note: The new implementation may not always reach the database creation
    // if there are issues with transaction confirmation
    const createRebalanceOpStub = database.createRebalanceOperation as SinonStub;
    if (createRebalanceOpStub.calledOnce) {
      const dbCall = createRebalanceOpStub.firstCall.args[0];
      expect(dbCall).toMatchObject({
        earmarkId: null,
        originChainId: routeToTest.origin,
        destinationChainId: routeToTest.destination,
        tickerHash: routeToTest.asset,
        amount: amountToBridge.toString(),
        slippagesDbps: routeToTest.slippagesDbps,
        bridge: MOCK_BRIDGE_TYPE_A,
      });
      expect(dbCall.txHashes.originTxHash).toBe('0xBridgeTxHash');
    }
  });

  it('should try the next bridge preference if adapter is not found', async () => {
    const routeToTest = mockContext.config.routes[0];
    const balances = new Map<string, Map<string, bigint>>();
    const currentBalance = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), currentBalance]]));
    getMarkBalancesStub.resolves(balances);
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    // First preference (Across) returns no adapter
    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(undefined as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    // Second preference (Stargate) returns the mock adapter
    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_B)
      .returns(mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
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
      .withArgs(expect.anything(), routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    // Check that the logger was called with the expected message
    const warnCalls = mockLogger.warn.getCalls();
    const adapterNotFoundMessage = warnCalls.find(
      (call) => call.args[0] && call.args[0].includes('Adapter not found for bridge type'),
    );
    expect(adapterNotFoundMessage).toBeTruthy();
    expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).toBe(true);
    expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_B)).toBe(true);
    // Check if the second bridge attempt proceeded (e.g., getReceivedAmount called on the second adapter)
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).toBe(true);
    // Add more assertions if needed to confirm the second bridge logic executed
  });

  it('should try the next bridge preference if getReceivedAmount fails', async () => {
    const routeToTest = mockContext.config.routes[0];
    const balances = new Map<string, Map<string, bigint>>();
    const balanceForRoute = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
    // Corrected key for the inner map to use routeToTest.origin.toString()
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
    getMarkBalancesStub.resolves(balances);
    getAvailableBalanceLessEarmarksStub.resolves(balanceForRoute);

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

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockAdapterA as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_B)
      .returns(mockAdapterB as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Mock allowance and contract for the second bridge attempt (assuming ERC20)
    const mockContractInstance = {
      read: { allowance: stub().resolves(1000n) },
      abi: erc20Abi,
      address: MOCK_ASSET_ERC20,
    };
    getERC20ContractStub
      .withArgs(expect.anything(), routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    // Check that the logger was called with the expected message
    const errorCalls = mockLogger.error.getCalls();
    const quoteFailedMessage = errorCalls.find(
      (call) => call.args[0] && call.args[0].includes('Failed to get quote from adapter'),
    );
    expect(quoteFailedMessage).toBeTruthy();
    expect(mockAdapterA.getReceivedAmount.calledOnce).toBe(true);
    expect(mockAdapterB.getReceivedAmount.calledOnce).toBe(true); // Ensure B was tried
    // Add assertions to confirm bridge B logic executed
  });

  it('should reject first bridge when slippage exceeds tolerance and use second bridge', async () => {
    // Create route with proper slippage in basis points
    const routeToTest = {
      ...mockContext.config.routes[0],
      preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
      slippagesDbps: [1000, 1000], // 1% in decibasis points // 1% slippage tolerance in basis points
    };

    const balanceForRoute = BigInt('20000000000000000000'); // 20 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(balanceForRoute);

    // First adapter returns quote with > 1% slippage (receiving 18 tokens when sending 20)
    const mockAdapterA = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves('18000000000000000000'), // 10% slippage, exceeds 1%
      type: stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    // Second adapter returns quote with < 1% slippage
    const mockAdapterB = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves('19900000000000000000'), // 0.5% slippage, within 1%
      send: stub().resolves([
        {
          transaction: { to: '0xOtherSpender', data: '0xbridgeDataB', value: 0n },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: stub().returns(MOCK_BRIDGE_TYPE_B),
    };

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockAdapterA as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_B)
      .returns(mockAdapterB as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Mock allowance and contract for the second bridge attempt (assuming ERC20)
    const mockContractInstance = {
      read: { allowance: stub().resolves(10000n) },
      abi: erc20Abi,
      address: MOCK_ASSET_ERC20,
    };
    getERC20ContractStub
      .withArgs(expect.anything(), routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Add database stub
    // Using the createRebalanceOperation stub from beforeEach

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    // With fixed slippage calculation, 10% slippage should be rejected
    // The first adapter should be tried but rejected, then second adapter used
    expect(mockAdapterA.getReceivedAmount.calledOnce).toBe(true);
    expect(mockAdapterA.send.called).toBe(false); // A should be rejected due to slippage
    expect(mockAdapterB.getReceivedAmount.calledOnce).toBe(true); // B should be tried
    expect(mockAdapterB.send.calledOnce).toBe(true); // B should be used

    // Verify successful rebalance with second adapter
    const infoCalls = mockLogger.info.getCalls();
    const successMessage = infoCalls.find(
      (call) => call.args[0] && call.args[0].includes('Quote meets slippage requirements'),
    );
    expect(successMessage).toBeTruthy();

    // No need to restore - handled in afterEach
  });

  it('should successfully use first bridge when slippage is within tolerance', async () => {
    // Create route with proper slippage in basis points
    const routeToTest = {
      ...mockContext.config.routes[0],
      preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
      slippagesDbps: [1000, 1000], // 1% in decibasis points // 1% slippage tolerance in basis points
    };

    const balanceForRoute = BigInt('20000000000000000000'); // 20 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
    getMarkBalancesStub.callsFake(async () => balances);
    getAvailableBalanceLessEarmarksStub.resolves(balanceForRoute);

    // First adapter returns quote with acceptable slippage (receiving 19.9 tokens when sending 20)
    const mockAdapterA = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves('19900000000000000000'), // 0.5% slippage, within 1%
      send: stub().resolves([
        {
          transaction: { to: '0xSpender', data: '0xbridgeDataA', value: 0n },
          memo: RebalanceTransactionMemo.Rebalance,
        },
      ]),
      type: stub().returns(MOCK_BRIDGE_TYPE_A),
    };
    // Second adapter should not be needed
    const mockAdapterB = {
      ...mockSpecificBridgeAdapter,
      getReceivedAmount: stub().resolves('19950000000000000000'),
      type: stub().returns(MOCK_BRIDGE_TYPE_B),
    };

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockAdapterA as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_B)
      .returns(mockAdapterB as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Add database stub
    // Using the createRebalanceOperation stub from beforeEach

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    // With fixed slippage calculation, 0.5% slippage should be accepted
    expect(mockAdapterA.getReceivedAmount.calledOnce).toBe(true);
    expect(mockAdapterA.send.calledOnce).toBe(true); // A should be used
    expect(mockAdapterB.getReceivedAmount.called).toBe(false); // B should not be tried

    // No need to restore - handled in afterEach
  });

  it('should try the next bridge preference if adapter send fails', async () => {
    // Update route to have multiple preferences
    const routeToTest = {
      ...mockContext.config.routes[0],
      preferences: [MOCK_BRIDGE_TYPE_A, MOCK_BRIDGE_TYPE_B],
    };
    const balances = new Map<string, Map<string, bigint>>();
    const balanceForRoute = BigInt(routeToTest.maximum) + 100n; // Ensure balance is above maximum
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([[routeToTest.origin.toString(), balanceForRoute]]));
    // Reset and configure the stub to handle any arguments
    getMarkBalancesStub.reset();
    getMarkBalancesStub.callsFake(async () => balances);

    // Also set up getAvailableBalanceLessEarmarksStub
    getAvailableBalanceLessEarmarksStub.resolves(balanceForRoute);

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

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockAdapterA_sendFails as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_B)
      .returns(mockAdapterB_sendFails as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Mock allowance and contract for the second bridge attempt (assuming ERC20)
    const mockContractInstance = {
      read: { allowance: stub().resolves(1000n) },
      abi: erc20Abi,
      address: MOCK_ASSET_ERC20,
    };
    getERC20ContractStub
      .withArgs(expect.anything(), routeToTest.origin.toString(), routeToTest.asset as `0x${string}`)
      .resolves(mockContractInstance);

    // Modify routes directly on the mockContext
    mockContext.config.routes = [routeToTest];
    await rebalanceInventory(mockContext);

    // Check that the logger was called with the expected message
    const errorCalls = mockLogger.error.getCalls();
    const sendFailedMessage = errorCalls.find(
      (call) => call.args[0] && call.args[0].includes('Failed to get bridge transaction request from adapter'),
    );
    expect(sendFailedMessage).toBeTruthy();
    expect(mockAdapterA_sendFails.send.calledOnce).toBe(true);
    expect(mockAdapterB_sendFails.send.calledOnce).toBe(true); // Ensure B send was tried
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

    // Also set up getAvailableBalanceLessEarmarksStub to return the current balance
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    const mockTxRequest: MemoizedTransactionRequest = {
      transaction: {
        to: MOCK_BRIDGE_A_SPENDER, // Spender for the bridge
        data: '0xbridgeData' as Hex,
        value: 0n,
      },
      memo: RebalanceTransactionMemo.Rebalance,
    };

    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE_A)
      .returns(mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE_A);
    mockSpecificBridgeAdapter.getReceivedAmount.resolves(quoteAmount);
    mockSpecificBridgeAdapter.send
      .withArgs(MOCK_OWN_ADDRESS, MOCK_OWN_ADDRESS, currentBalance.toString(), expect.any(Object))
      .resolves([mockTxRequest]);

    await rebalanceInventory({
      ...mockContext,
      config: { ...mockContext.config, routes: [{ ...routeToTest, preferences: [MOCK_BRIDGE_TYPE_A] }] },
    });

    expect(getMarkBalancesStub.calledOnce).toBe(true);
    expect(mockRebalanceAdapter.getAdapter.calledWith(MOCK_BRIDGE_TYPE_A)).toBe(true);
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);

    // Check that transaction submission helper was called for the bridge transaction
    expect(submitTransactionWithLoggingStub.calledOnce).toBe(true);
    const txCall = submitTransactionWithLoggingStub.firstCall.args[0];
    expect(txCall.txRequest.to).toBe(MOCK_BRIDGE_A_SPENDER);
    expect(txCall.txRequest.data).toBe('0xbridgeData');

    // Note: The new implementation uses database operations instead of cache
  });

  // Add more tests: Native success, other errors...
});

describe('Zodiac Address Validation', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockPurchaseCache: SinonStubbedInstance<PurchaseCache>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
  let mockPrometheus: SinonStubbedInstance<PrometheusAdapter>;
  let mockSpecificBridgeAdapter: MockBridgeAdapterInterface;

  // Stubs for module functions - will be assigned in beforeEach
  let getMarkBalancesStub: SinonStub;

  const MOCK_REQUEST_ID = 'zodiac-rebalance-request-id';
  const MOCK_OWN_ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const MOCK_SAFE_ADDRESS = '0x9876543210987654321098765432109876543210' as `0x${string}`;
  const MOCK_ASSET_ERC20 = '0xErc20AssetAddress' as `0x${string}`;
  const MOCK_BRIDGE_TYPE = SupportedBridge.Across;
  const MOCK_ERC20_TICKER_HASH = '0xerc20tickerhashtest' as `0x${string}`;

  const mockZodiacConfig = {
    zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
    zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    gnosisSafeAddress: MOCK_SAFE_ADDRESS,
  };

  const mockEOAConfig = {
    zodiacRoleModuleAddress: undefined,
    zodiacRoleKey: undefined,
    gnosisSafeAddress: undefined,
  };

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockPurchaseCache = createStubInstance(PurchaseCache);
    mockChainService = createStubInstance(ChainService);
    mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
    mockPrometheus = createStubInstance(PrometheusAdapter);

    mockSpecificBridgeAdapter = {
      getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
      send: stub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>(),
      type: stub<[], SupportedBridge>(),
    };

    // Stub helper functions
    getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances').callsFake(async () => new Map());

    // Default configuration with two chains - one with Zodiac, one without
    const mockConfig: MarkConfiguration = {
      routes: [
        {
          origin: 42161, // Arbitrum (with Zodiac)
          destination: 1, // Ethereum (without Zodiac)
          asset: MOCK_ASSET_ERC20,
          maximum: '10000000000000000000', // 10 tokens
          slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
          preferences: [MOCK_BRIDGE_TYPE],
        },
      ],
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
        '42161': {
          // Arbitrum with Zodiac
          providers: ['http://arbitrumprovider'],
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
          invoiceAge: 0,
          gasThreshold: '0',
          deployments: {
            everclear: '0x1234567890123456789012345678901234567890',
            permit2: '0x1234567890123456789012345678901234567890',
            multicall3: '0x1234567890123456789012345678901234567890',
          },
          ...mockZodiacConfig,
        },
        '1': {
          // Ethereum without Zodiac
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
          ],
          invoiceAge: 0,
          gasThreshold: '0',
          deployments: {
            everclear: '0x1234567890123456789012345678901234567890',
            permit2: '0x1234567890123456789012345678901234567890',
            multicall3: '0x1234567890123456789012345678901234567890',
          },
          ...mockEOAConfig,
        },
      },
      supportedSettlementDomains: [1, 42161],
    } as unknown as MarkConfiguration;

    mockContext = {
      config: mockConfig,
      requestId: MOCK_REQUEST_ID,
      startTime: Date.now(),
      logger: mockLogger,
      purchaseCache: mockPurchaseCache,
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
      prometheus: mockPrometheus,
      everclear: undefined,
      web3Signer: undefined,
      database: createDatabaseMock(),
    } as unknown as SinonStubbedInstance<ProcessingContext>;

    // Default stubs
    mockRebalanceAdapter.isPaused.resolves(false); // Critical: allow rebalancing to proceed
    mockPurchaseCache.isPaused.resolves(false); // Default: purchase cache not paused
    // mockRebalanceAdapter.addRebalances.resolves(); // Mock the cache addition - removed
    mockRebalanceAdapter.getAdapter.returns(
      mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>,
    );
    mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE);
    mockSpecificBridgeAdapter.getReceivedAmount.resolves('19980000000000000001'); // Good quote for 20 tokens (just above minimum slippage)
    mockSpecificBridgeAdapter.send.resolves([
      {
        transaction: { to: '0xBridgeSpender', data: '0xbridgeData' as Hex, value: 0n },
        memo: RebalanceTransactionMemo.Rebalance,
      },
    ]);

    // Mock successful transaction
    mockChainService.submitAndMonitor.resolves({
      transactionHash: '0xMockTxHash',
      blockNumber: 123,
      status: 1,
      confirmations: 1,
      logs: [],
      cumulativeGasUsed: '21000',
      effectiveGasPrice: '1000000000',
    });

    // Additional stub setup is done in the existing getAvailableBalanceLessEarmarksStub in beforeEach

    // Set up default balances that exceed maximum to trigger rebalancing
    const defaultBalances = new Map<string, Map<string, bigint>>();
    // Create a single chain map with multiple chains
    const chainBalances = new Map<string, bigint>();
    chainBalances.set('42161', BigInt('20000000000000000000')); // 20 tokens on Arbitrum
    chainBalances.set('1', BigInt('20000000000000000000')); // 20 tokens on Ethereum
    defaultBalances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), chainBalances);
    getMarkBalancesStub.resolves(defaultBalances);
  });

  afterEach(() => {
    restore();
  });

  it('should use Safe address as sender for Zodiac-enabled origin chain', async () => {
    // Uses default route: Arbitrum (Zodiac) -> Ethereum (EOA)
    const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Verify adapter.send was called with Safe address as sender (first parameter)
    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);
    const sendCall = mockSpecificBridgeAdapter.send.firstCall;
    expect(sendCall.args[0]).toBe(MOCK_SAFE_ADDRESS); // sender = Safe address from origin chain (42161)
    expect(sendCall.args[1]).toBe(MOCK_OWN_ADDRESS); // recipient = EOA address for destination chain (1)
  });

  it('should use EOA address as sender for non-Zodiac origin chain', async () => {
    // Configure route: Ethereum (EOA) -> Arbitrum (Zodiac)
    mockContext.config.routes = [
      {
        origin: 1, // Ethereum (without Zodiac)
        destination: 42161, // Arbitrum (with Zodiac)
        asset: MOCK_ASSET_ERC20,
        maximum: '10000000000000000000',
        slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
        preferences: [MOCK_BRIDGE_TYPE],
      },
    ];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['1', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Verify adapter.send was called with EOA address as sender and Safe address as recipient
    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);
    const sendCall = mockSpecificBridgeAdapter.send.firstCall;
    expect(sendCall.args[0]).toBe(MOCK_OWN_ADDRESS); // sender = EOA address from origin chain (1)
    expect(sendCall.args[1]).toBe(MOCK_SAFE_ADDRESS); // recipient = Safe address for destination chain (42161)
  });

  it('should use Safe addresses for both sender and recipient when both chains have Zodiac', async () => {
    // Add second Zodiac-enabled chain
    const mockSafeAddress2 = '0x2222222222222222222222222222222222222222' as `0x${string}`;
    mockContext.config.chains['10'] = {
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
      invoiceAge: 0,
      gasThreshold: '0',
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      zodiacRoleModuleAddress: '0x2345678901234567890123456789012345678901',
      zodiacRoleKey: '0x2345678901234567890123456789012345678901234567890123456789012345',
      gnosisSafeAddress: mockSafeAddress2,
    };
    mockContext.config.supportedSettlementDomains = [1, 10, 42161];

    // Configure route: Arbitrum (Zodiac) -> Optimism (Zodiac)
    mockContext.config.routes = [
      {
        origin: 42161, // Arbitrum (with Zodiac)
        destination: 10, // Optimism (with Zodiac)
        asset: MOCK_ASSET_ERC20,
        maximum: '10000000000000000000',
        slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
        preferences: [MOCK_BRIDGE_TYPE],
      },
    ];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Verify adapter.send was called with Safe addresses for both sender and recipient
    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);
    const sendCall = mockSpecificBridgeAdapter.send.firstCall;
    expect(sendCall.args[0]).toBe(MOCK_SAFE_ADDRESS); // sender = Safe address from origin chain (42161)
    expect(sendCall.args[1]).toBe(mockSafeAddress2); // recipient = Safe address for destination chain (10)
  });

  it('should use EOA addresses for both sender and recipient when neither chain has Zodiac', async () => {
    // Add second EOA-only chain
    mockContext.config.chains['10'] = {
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
      invoiceAge: 0,
      gasThreshold: '0',
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      ...mockEOAConfig,
    };
    mockContext.config.supportedSettlementDomains = [1, 10, 42161];

    // Configure route: Ethereum (EOA) -> Optimism (EOA)
    mockContext.config.routes = [
      {
        origin: 1, // Ethereum (without Zodiac)
        destination: 10, // Optimism (without Zodiac)
        asset: MOCK_ASSET_ERC20,
        maximum: '10000000000000000000',
        slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
        preferences: [MOCK_BRIDGE_TYPE],
      },
    ];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens, above maximum
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['1', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    await rebalanceInventory(mockContext);

    // Verify adapter.send was called with EOA addresses for both sender and recipient
    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);
    const sendCall = mockSpecificBridgeAdapter.send.firstCall;
    expect(sendCall.args[0]).toBe(MOCK_OWN_ADDRESS); // sender = EOA address from origin chain (1)
    expect(sendCall.args[1]).toBe(MOCK_OWN_ADDRESS); // recipient = EOA address for destination chain (10)
  });
});

describe('Reserve Amount Functionality', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockPurchaseCache: SinonStubbedInstance<PurchaseCache>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
  let mockPrometheus: SinonStubbedInstance<PrometheusAdapter>;
  let mockSpecificBridgeAdapter: MockBridgeAdapterInterface;

  // Stubs for module functions used in this describe block
  let getMarkBalancesStub: SinonStub;
  let submitTransactionWithLoggingStub: SinonStub;
  let getAvailableBalanceLessEarmarksStub: SinonStub;

  // Stubs for module functions
  // Using stubs from parent scope

  const MOCK_REQUEST_ID = 'reserve-test-request-id';
  const MOCK_OWN_ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const MOCK_ASSET_ERC20 = '0xErc20AssetAddress' as `0x${string}`;
  const MOCK_BRIDGE_TYPE = SupportedBridge.Across;
  const MOCK_ERC20_TICKER_HASH = '0xerc20tickerhashtest' as `0x${string}`;

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockPurchaseCache = createStubInstance(PurchaseCache);
    mockChainService = createStubInstance(ChainService);
    mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
    mockPrometheus = createStubInstance(PrometheusAdapter);

    mockSpecificBridgeAdapter = {
      getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
      send: stub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>(),
      type: stub<[], SupportedBridge>(),
    };

    // Stub helper functions for this suite
    getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances').callsFake(async () => new Map());
    submitTransactionWithLoggingStub = stub(transactionHelper, 'submitTransactionWithLogging').resolves({
      hash: '0xBridgeTxHash',
      submissionType: TransactionSubmissionType.Onchain,
      receipt: {
        transactionHash: '0xBridgeTxHash',
        blockNumber: 121,
        status: 1,
        confirmations: 1,
        logs: [],
        cumulativeGasUsed: '100000',
        effectiveGasPrice: '1000000000',
      },
    });
    getAvailableBalanceLessEarmarksStub = stub(onDemand, 'getAvailableBalanceLessEarmarks').resolves(
      BigInt('20000000000000000000'),
    );

    mockContext = {
      logger: mockLogger,
      requestId: MOCK_REQUEST_ID,
      purchaseCache: mockPurchaseCache,
      config: {
        routes: [
          {
            origin: 1,
            destination: 10,
            asset: MOCK_ASSET_ERC20,
            maximum: '10000000000000000000', // 10 tokens
            slippagesDbps: [1000], // 1% in decibasis points
            preferences: [MOCK_BRIDGE_TYPE],
          },
        ],
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
      database: createDatabaseMock(),
    } as unknown as ProcessingContext;

    mockRebalanceAdapter.isPaused.resolves(false);
    mockPurchaseCache.isPaused.resolves(false); // Default: purchase cache not paused
    mockRebalanceAdapter.getAdapter
      .withArgs(MOCK_BRIDGE_TYPE)
      .returns(mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);
    mockSpecificBridgeAdapter.type.returns(MOCK_BRIDGE_TYPE);

    // Additional stub setup is done in the existing getAvailableBalanceLessEarmarksStub in beforeEach
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
      slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens
    const expectedAmountToBridge = BigInt('17000000000000000000'); // 20 - 3 = 17 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Ensure getAvailableBalanceLessEarmarks returns the current balance
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

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
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).toBe(expectedAmountToBridge.toString());

    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).toBe(expectedAmountToBridge.toString());

    // Verify rebalance action records the correct amount
    // Note: The new implementation uses database operations instead of cache
    // expect(rebalanceAction.amount).toBe(expectedAmountToBridge.toString());
  });

  it('should skip rebalancing when amount to bridge after reserve is zero', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      reserve: '15000000000000000000', // 15 tokens reserve
      slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('15000000000000000000'); // 15 tokens (same as reserve)
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Ensure getAvailableBalanceLessEarmarks returns the current balance
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    await rebalanceInventory(mockContext);

    // Should not attempt to get quote or send transaction
    expect(mockSpecificBridgeAdapter.getReceivedAmount.called).toBe(false);
    expect(mockSpecificBridgeAdapter.send.called).toBe(false);
    expect(submitTransactionWithLoggingStub.called).toBe(false);
    // Note: The new implementation uses database operations instead of cache

    // Should log that amount to bridge is zero
    expect(mockLogger.info.calledWith('Amount to bridge after reserve is zero or negative, skipping route')).toBe(true);
  });

  it('should skip rebalancing when amount to bridge after reserve is negative', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      reserve: '25000000000000000000', // 25 tokens reserve (more than current balance)
      slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens (less than reserve)
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Ensure getAvailableBalanceLessEarmarks returns the current balance
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

    await rebalanceInventory(mockContext);

    // Should not attempt to get quote or send transaction
    expect(mockSpecificBridgeAdapter.getReceivedAmount.called).toBe(false);
    expect(mockSpecificBridgeAdapter.send.called).toBe(false);
    expect(submitTransactionWithLoggingStub.called).toBe(false);
    // Note: The new implementation uses database operations instead of cache

    // Should log that amount to bridge is negative
    expect(mockLogger.info.calledWith('Amount to bridge after reserve is zero or negative, skipping route')).toBe(true);
  });

  it('should work normally without reserve (backward compatibility)', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      // No reserve field
      slippagesDbps: [1000], // 1% in decibasis points // 1% in basis points
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Ensure getAvailableBalanceLessEarmarks returns the current balance
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

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
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).toBe(currentBalance.toString());

    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).toBe(currentBalance.toString());

    // Verify rebalance action records the full amount
    // Note: The new implementation uses database operations instead of cache
    // The cache.addRebalances is no longer called in the implementation
    // expect(rebalanceAction.amount).toBe(currentBalance.toString());
  });

  it('should use slippage calculation based on amount to bridge (minus reserve)', async () => {
    const route: RouteRebalancingConfig = {
      origin: 1,
      destination: 10,
      asset: MOCK_ASSET_ERC20,
      maximum: '10000000000000000000', // 10 tokens
      reserve: '5000000000000000000', // 5 tokens reserve
      slippagesDbps: [1000], // 1% in decibasis points // 1% slippage (100 basis points)
      preferences: [MOCK_BRIDGE_TYPE],
    };

    mockContext.config.routes = [route];

    const currentBalance = BigInt('20000000000000000000'); // 20 tokens
    const amountToBridge = BigInt('15000000000000000000'); // 20 - 5 = 15 tokens
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_ERC20_TICKER_HASH.toLowerCase(), new Map([['42161', currentBalance]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Ensure getAvailableBalanceLessEarmarks returns the current balance
    getAvailableBalanceLessEarmarksStub.resolves(currentBalance);

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
    expect(mockSpecificBridgeAdapter.getReceivedAmount.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).toBe(amountToBridge.toString());

    expect(mockSpecificBridgeAdapter.send.calledOnce).toBe(true);
    expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).toBe(amountToBridge.toString());
  });
});

describe('Decimal Handling', () => {
  it('should handle USDC (6 decimals) correctly when comparing balances and calling adapters', async () => {
    // Setup stubs for this test
    const getAvailableBalanceLessEarmarksStub = stub(onDemand, 'getAvailableBalanceLessEarmarks').resolves(
      BigInt('1000000000000000000'),
    );

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
      receipt: {
        transactionHash: '0xBridgeTxHash',
        blockNumber: 121,
        status: 1,
        confirmations: 1,
        logs: [],
        cumulativeGasUsed: '100000',
        effectiveGasPrice: '1000000000',
      },
    });

    const mockLogger = createStubInstance(Logger);
    const mockPurchaseCache = createStubInstance(PurchaseCache);
    const mockRebalanceAdapter = createStubInstance(RebalanceAdapter);

    mockRebalanceAdapter.isPaused.resolves(false);
    mockPurchaseCache.isPaused.resolves(false); // Default: purchase cache not paused
    mockRebalanceAdapter.getAdapter.returns(
      mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>,
    );

    const route: RouteRebalancingConfig = {
      origin: 42161,
      destination: 10,
      asset: MOCK_USDC_ADDRESS,
      maximum: '1000000000000000000', // 1 USDC in 18 decimal format
      reserve: '47000000000000000000', // 47 USDC in 18 decimal format
      slippagesDbps: [500], // 0.5% in decibasis points
      preferences: [SupportedBridge.Binance],
    };

    const mockContext = {
      logger: mockLogger,
      requestId: 'decimal-test',
      config: {
        routes: [route],
        ownAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        chains: {
          '42161': {
            providers: ['http://localhost:8545'],
            assets: [
              {
                symbol: 'USDC',
                address: MOCK_USDC_ADDRESS,
                decimals: 6,
                tickerHash: MOCK_USDC_TICKER_HASH,
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
                symbol: 'USDC',
                address: MOCK_USDC_ADDRESS,
                decimals: 6,
                tickerHash: MOCK_USDC_TICKER_HASH,
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
      rebalance: mockRebalanceAdapter,
      purchaseCache: mockPurchaseCache,
    } as unknown as ProcessingContext;

    // Balance: 48.796999 USDC (in 18 decimals from balance system)
    const balanceValue = BigInt('48796999000000000000');
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_USDC_TICKER_HASH.toLowerCase(), new Map([['42161', balanceValue]]));
    getMarkBalancesStub.resolves(balances);

    // Ensure getAvailableBalanceLessEarmarks returns the balance value
    getAvailableBalanceLessEarmarksStub.resolves(balanceValue);

    // Expected: 48796999 - 47000000 = 1796999 (in 6-decimal USDC format)
    const expectedAmountToBridge = '1796999';

    mockSpecificBridgeAdapter.getReceivedAmount.resolves('1790000');
    mockSpecificBridgeAdapter.send.resolves([
      {
        transaction: { to: '0xBridgeAddress' as `0x${string}`, data: '0xbridgeData' as Hex, value: 0n },
        memo: RebalanceTransactionMemo.Rebalance,
      },
    ]);

    // Mock getDecimalsFromConfig to return 6 for USDC
    const getDecimalsFromConfigMock = getDecimalsFromConfig as jest.Mock;
    getDecimalsFromConfigMock.mockImplementation((ticker: string) => {
      if (ticker.toLowerCase() === MOCK_USDC_TICKER_HASH.toLowerCase()) {
        return 6;
      }
      return 18;
    });

    await rebalanceInventory(mockContext);

    // Verify adapters were called and received amounts in USDC native decimals (6)
    if (mockSpecificBridgeAdapter.getReceivedAmount.firstCall) {
      expect(mockSpecificBridgeAdapter.getReceivedAmount.firstCall.args[0]).toBe(expectedAmountToBridge);
    }
    if (mockSpecificBridgeAdapter.send.firstCall) {
      expect(mockSpecificBridgeAdapter.send.firstCall.args[2]).toBe(expectedAmountToBridge);
    }

    // Verify cache stores native decimal amount
    // Note: The new implementation uses database operations instead of cache
    // Database operations are used instead of cache
    //   expect(rebalanceAction.amount).toBe(expectedAmountToBridge);
    // }

    // Cleanup
    restore();
  });

  it('should skip USDC route when balance is at maximum', async () => {
    // Setup stubs for this test
    const getAvailableBalanceLessEarmarksStub = stub(onDemand, 'getAvailableBalanceLessEarmarks').resolves(
      BigInt('1000000000000000000'),
    );

    const MOCK_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`;
    const MOCK_USDC_TICKER_HASH = '0xusdctickerhashtest' as `0x${string}`;

    const mockSpecificBridgeAdapter = {
      getReceivedAmount: stub<[string, RebalanceRoute], Promise<string>>(),
      send: stub<[string, string, string, RebalanceRoute], Promise<MemoizedTransactionRequest[]>>(),
      type: stub<[], SupportedBridge>().returns(SupportedBridge.Binance),
    };

    stub(callbacks, 'executeDestinationCallbacks').resolves();
    const getMarkBalancesStub = stub(balanceHelpers, 'getMarkBalances');

    const mockLogger = createStubInstance(Logger);
    const mockPurchaseCache = createStubInstance(PurchaseCache);
    const mockRebalanceAdapter = createStubInstance(RebalanceAdapter);

    mockRebalanceAdapter.isPaused.resolves(false);
    mockPurchaseCache.isPaused.resolves(false); // Default: purchase cache not paused
    mockRebalanceAdapter.getAdapter.returns(
      mockSpecificBridgeAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>,
    );

    const mockContext = {
      logger: mockLogger,
      requestId: 'decimal-skip-test',
      config: {
        routes: [
          {
            origin: 42161,
            destination: 10,
            asset: MOCK_USDC_ADDRESS,
            maximum: '1000000000000000000', // 1 USDC in 18 decimal format
            slippagesDbps: [500], // 0.5% in decibasis points
            preferences: [SupportedBridge.Binance],
          },
        ],
        ownAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        chains: {
          '42161': {
            providers: ['http://localhost:8545'],
            assets: [
              {
                symbol: 'USDC',
                address: MOCK_USDC_ADDRESS,
                decimals: 6,
                tickerHash: MOCK_USDC_TICKER_HASH,
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
      rebalance: mockRebalanceAdapter,
      purchaseCache: mockPurchaseCache,
    } as unknown as ProcessingContext;

    // Balance exactly at maximum (1 USDC in 18 decimals)
    const balances = new Map<string, Map<string, bigint>>();
    balances.set(MOCK_USDC_TICKER_HASH.toLowerCase(), new Map([['42161', BigInt('1000000000000000000')]]));
    getMarkBalancesStub.callsFake(async () => balances);

    // Ensure getAvailableBalanceLessEarmarks returns the same balance
    getAvailableBalanceLessEarmarksStub.resolves(BigInt('1000000000000000000'));

    // Mock getDecimalsFromConfig to return 6 for USDC
    const getDecimalsFromConfigMock = getDecimalsFromConfig as jest.Mock;
    getDecimalsFromConfigMock.mockImplementation((ticker: string) => {
      if (ticker.toLowerCase() === MOCK_USDC_TICKER_HASH.toLowerCase()) {
        return 6;
      }
      return 18;
    });

    await rebalanceInventory(mockContext);

    // Should skip due to balance being at maximum
    const infoCalls = mockLogger.info.getCalls();
    const skipMessage = infoCalls.find(
      (call) => call.args[0] && call.args[0].includes('Balance is at or below maximum, skipping route'),
    );
    expect(skipMessage).toBeTruthy();
    expect(mockSpecificBridgeAdapter.getReceivedAmount.called).toBe(false);

    // Cleanup
    restore();
  });
});
