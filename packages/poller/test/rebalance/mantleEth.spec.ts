import sinon, { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore } from 'sinon';

// Mock database functions
jest.mock('@mark/database', () => ({
  ...jest.requireActual('@mark/database'),
  createRebalanceOperation: jest.fn(),
  getRebalanceOperations: jest.fn().mockResolvedValue({ operations: [], total: 0 }),
  updateRebalanceOperation: jest.fn(),
  updateEarmarkStatus: jest.fn(),
  getActiveEarmarkForInvoice: jest.fn().mockResolvedValue(null),
  createEarmark: jest.fn(),
  removeEarmark: jest.fn(),
  initializeDatabase: jest.fn(),
  getPool: jest.fn(),
}));

// Mock core functions
jest.mock('@mark/core', () => ({
  ...jest.requireActual('@mark/core'),
  getDecimalsFromConfig: jest.fn(() => 18), // WETH/mETH use 18 decimals
  getTokenAddressFromConfig: jest.fn(() => '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), // WETH address
}));

import { rebalanceMantleEth, executeMethCallbacks } from '../../src/rebalance/mantleEth';
import * as database from '@mark/database';
import * as balanceHelpers from '../../src/helpers/balance';
import * as transactionHelpers from '../../src/helpers/transactions';
import { createDatabaseMock } from '../mocks/database';
import { MarkConfiguration, SupportedBridge, RebalanceOperationStatus, EarmarkStatus, MAINNET_CHAIN_ID, MANTLE_CHAIN_ID } from '@mark/core';
import { RebalanceTransactionMemo } from '@mark/rebalance';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';
import { PurchaseCache } from '@mark/cache';
import { RebalanceAdapter } from '@mark/rebalance';
import { PrometheusAdapter } from '@mark/prometheus';
import { EverclearAdapter } from '@mark/everclear';

// Constants
const MOCK_REQUEST_ID = 'meth-rebalance-test-001';
const MOCK_OWN_ADDRESS = '0x1111111111111111111111111111111111111111';
const MOCK_MM_ADDRESS = '0x2222222222222222222222222222222222222222';
const MOCK_FS_ADDRESS = '0x3333333333333333333333333333333333333333';
const MOCK_FS_SENDER_ADDRESS = '0x4444444444444444444444444444444444444444';
const WETH_TICKER_HASH = '0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8';
const METH_TICKER_HASH = '0xd5a2aecb01320815a5625da6d67fbe0b34c12b267ebb3b060c014486ec5484d8';

// Shared mock config factory
const createMockConfig = (overrides?: Partial<MarkConfiguration>): MarkConfiguration => ({
  pushGatewayUrl: 'http://localhost:9091',
  web3SignerUrl: 'http://localhost:8545',
  everclearApiUrl: 'http://localhost:3000',
  relayer: {},
  binance: {},
  kraken: {},
  coinbase: {},
  near: {},
  stargate: {},
  tac: { tonRpcUrl: 'https://toncenter.com', network: 'mainnet' },
  ton: { mnemonic: 'test mnemonic words here', rpcUrl: 'https://toncenter.com', apiKey: 'test-key' },
  redis: { host: 'localhost', port: 6379 },
  ownAddress: MOCK_OWN_ADDRESS,
  stage: 'development',
  environment: 'devnet',
  logLevel: 'debug',
  supportedSettlementDomains: [1, 5000],
  chains: {
    '1': {
      providers: ['http://localhost:8545'],
      assets: [
        {
          tickerHash: WETH_TICKER_HASH,
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          decimals: 18,
          symbol: 'WETH',
          isNative: false,
          balanceThreshold: '0',
        },
      ],
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      invoiceAge: 3600,
      gasThreshold: '1000000000000000000',
    },
    '5000': {
      providers: ['http://localhost:8546'],
      assets: [
        {
          tickerHash: METH_TICKER_HASH,
          address: '0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000',
          decimals: 18,
          symbol: 'mETH',
          isNative: false,
          balanceThreshold: '0',
        },
      ],
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      invoiceAge: 3600,
      gasThreshold: '1000000000000000000',
    },
  },
  routes: [],
  database: { connectionString: 'postgresql://test:test@localhost:5432/test' },
  methRebalance: {
    enabled: true,
    marketMaker: {
      address: MOCK_MM_ADDRESS,
      onDemandEnabled: false,
      thresholdEnabled: false,
      threshold: '100000000000000000000', // 100 WETH in wei (18 decimals)
      targetBalance: '500000000000000000000', // 500 WETH in wei
    },
    fillService: {
      address: MOCK_FS_ADDRESS,
      senderAddress: MOCK_FS_SENDER_ADDRESS,
      thresholdEnabled: true,
      threshold: '100000000000000000000', // 100 mETH in wei (18 decimals)
      targetBalance: '500000000000000000000', // 500 mETH in wei
    },
    bridge: {
      slippageDbps: 500, // 5%
      minRebalanceAmount: '10000000000000000000', // 10 WETH in wei (18 decimals)
      maxRebalanceAmount: '1000000000000000000000', // 1000 WETH in wei
    },
  },
  regularRebalanceOpTTLMinutes: 24 * 60, // 24 hours
  ...overrides,
} as unknown as MarkConfiguration);

describe('mETH Rebalancing', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockFillServiceChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
  let mockPrometheus: SinonStubbedInstance<PrometheusAdapter>;
  let mockEverclear: SinonStubbedInstance<EverclearAdapter>;
  let mockPurchaseCache: SinonStubbedInstance<PurchaseCache>;

  let getEvmBalanceStub: SinonStub;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup database mocks
    (database.initializeDatabase as jest.Mock).mockReturnValue({});
    (database.getPool as jest.Mock).mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    });
    (database.getRebalanceOperations as jest.Mock).mockResolvedValue({ operations: [], total: 0 });
    (database.createRebalanceOperation as jest.Mock).mockResolvedValue({
      id: 'rebalance-001',
      status: RebalanceOperationStatus.PENDING,
    });
    (database.getActiveEarmarkForInvoice as jest.Mock).mockResolvedValue(null);
    (database.createEarmark as jest.Mock).mockResolvedValue({
      id: 'earmark-001',
      invoiceId: 'intent-001',
      designatedPurchaseChain: Number(MANTLE_CHAIN_ID),
      tickerHash: WETH_TICKER_HASH,
      minAmount: '10000000000000000000',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create mock instances
    mockLogger = createStubInstance(Logger);
    mockChainService = createStubInstance(ChainService);
    mockFillServiceChainService = createStubInstance(ChainService);
    mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
    mockPrometheus = createStubInstance(PrometheusAdapter);
    mockEverclear = createStubInstance(EverclearAdapter);
    mockPurchaseCache = createStubInstance(PurchaseCache);

    // Default stub behaviors
    mockRebalanceAdapter.isPaused.resolves(false);
    mockEverclear.fetchIntents.resolves([]);

    // Stub balance helper - now used directly for each intent's origin chain
    getEvmBalanceStub = stub(balanceHelpers, 'getEvmBalance');
    getEvmBalanceStub.resolves(BigInt('1000000000000000000000')); // 1000 WETH in wei

    const mockConfig = createMockConfig();

    mockContext = {
      config: mockConfig,
      requestId: MOCK_REQUEST_ID,
      startTime: Date.now(),
      logger: mockLogger,
      purchaseCache: mockPurchaseCache,
      chainService: mockChainService,
      fillServiceChainService: mockFillServiceChainService,
      rebalance: mockRebalanceAdapter,
      prometheus: mockPrometheus,
      everclear: mockEverclear,
      web3Signer: undefined,
      database: createDatabaseMock(),
    } as unknown as SinonStubbedInstance<ProcessingContext>;
  });

  afterEach(() => {
    restore();
  });

  describe('rebalanceMantleEth - Main Flow', () => {
    it('should return empty array when mETH rebalancing is disabled', async () => {
      const disabledConfig = createMockConfig({
        methRebalance: { ...createMockConfig().methRebalance!, enabled: false },
      });

      const result = await rebalanceMantleEth({
        ...mockContext,
        config: disabledConfig,
      } as unknown as ProcessingContext);

      expect(result).toEqual([]);
      expect(mockLogger.warn.calledWithMatch('mETH Rebalance is not enabled')).toBe(true);
    });

    it('should return empty array when rebalance adapter is paused', async () => {
      mockRebalanceAdapter.isPaused.resolves(true);

      const result = await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      expect(result).toEqual([]);
      expect(mockLogger.warn.calledWithMatch('mETH Rebalance loop is paused')).toBe(true);
    });

    it('should validate configuration and return empty on missing fillService.address', async () => {
      const invalidConfig = createMockConfig({
        methRebalance: {
          ...createMockConfig().methRebalance!,
          fillService: {
            ...createMockConfig().methRebalance!.fillService!,
            address: undefined,
          },
        },
      });

      const result = await rebalanceMantleEth({
        ...mockContext,
        config: invalidConfig,
      } as unknown as ProcessingContext);

      expect(result).toEqual([]);
      expect(mockLogger.error.calledWithMatch('mETH rebalance configuration validation failed')).toBe(true);
    });

    it('should log initial configuration at start', async () => {
      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const infoCalls = mockLogger.info.getCalls();
      const startLog = infoCalls.find((call) => call.args[0] && call.args[0].includes('Starting mETH rebalancing'));
      expect(startLog).toBeTruthy();
    });

    it('should complete cycle and log summary', async () => {
      // Setup: FS above threshold, no rebalancing needed
      getEvmBalanceStub.resolves(BigInt('500000000000000000000')); // 500 mETH (above 100 threshold)

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const infoCalls = mockLogger.info.getCalls();
      const completeLog = infoCalls.find(
        (call) => call.args[0] && call.args[0].includes('Completed mETH rebalancing cycle'),
      );
      expect(completeLog).toBeTruthy();
    });

    it('should execute callbacks before rebalancing', async () => {
      // Mock callback execution by stubbing the database call
      const dbMock = mockContext.database as any;
      dbMock.getRebalanceOperations = stub().resolves({ operations: [], total: 0 });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      // Verify callbacks were executed (getRebalanceOperations was called)
      expect(dbMock.getRebalanceOperations.called).toBe(true);
    });
  });

  describe('Fill Service - Intent Based Flow (Priority 1)', () => {
    it('should process intents to Mantle', async () => {
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '20000000000000000000', // 20 WETH in wei
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID],
        tickerHash: WETH_TICKER_HASH,
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      // Balance on origin chain (mainnet) for FS address is sufficient
      getEvmBalanceStub.resolves(BigInt('500000000000000000000')); // 500 WETH

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      // Should create earmark for intent
      expect(database.createEarmark).toHaveBeenCalled();
    });

    it('should skip intent if active earmark already exists', async () => {
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '20000000000000000000',
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID],
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      // Use context database mock
      const dbMock = mockContext.database as any;
      dbMock.getActiveEarmarkForInvoice = stub().resolves({
        id: 'existing-earmark',
        status: 'pending',
      });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      // Should not create new earmark
      const createEarmarkCalls = (database.createEarmark as jest.Mock).mock.calls;
      expect(createEarmarkCalls.length).toBe(0);

      const warnCalls = mockLogger.warn.getCalls();
      const existingEarmarkLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('Active earmark already exists for intent'),
      );
      expect(existingEarmarkLog).toBeTruthy();
    });

    it('should remove earmark when no operations are executed for intent', async () => {
      const mockIntent = {
        intent_id: 'intent-no-ops',
        amount_out_min: '20000000000000000000', // 20 WETH
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID],
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      // Sufficient WETH balance on origin chain (mainnet) for FS address
      getEvmBalanceStub.resolves(BigInt('500000000000000000000')); // 500 WETH

      // Force processThresholdRebalancing to produce no actions by making adapter unavailable
      // (executeMethBridge will log error and return [])
      (mockRebalanceAdapter.getAdapter as any)?.returns(undefined);

      const removeEarmarkMock = database.removeEarmark as jest.Mock;
      removeEarmarkMock.mockResolvedValue(undefined);

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      // Earmark should be removed because no actions were created for the intent
      expect(removeEarmarkMock).toHaveBeenCalled();
      const infoCalls = mockLogger.info.getCalls();
      const removeLog = infoCalls.find(
        (call) =>
          call.args[0] &&
          call.args[0].includes('Removed earmark for intent rebalance because no operations were executed'),
      );
      expect(removeLog).toBeTruthy();
    });

    it('should skip intent if amount is below minimum rebalance', async () => {
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '5000000000000000000', // 5 WETH (below 10 WETH minimum)
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID],
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const warnCalls = mockLogger.warn.getCalls();
      const minAmountLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('Intent amount is less than min staking amount'),
      );
      expect(minAmountLog).toBeTruthy();
    });

    it('should skip intent if balance is insufficient', async () => {
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '20000000000000000000', // 20 WETH
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID],
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      // Balance on origin chain (mainnet) for FS address is less than intent amount
      getEvmBalanceStub.resolves(BigInt('10000000000000000000')); // 10 WETH (less than 20 needed)

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const infoCalls = mockLogger.info.getCalls();
      const balanceLog = infoCalls.find(
        (call) => call.args[0] && call.args[0].includes('Balance is below intent amount, skipping route'),
      );
      expect(balanceLog).toBeTruthy();
    });

    it('should handle unique constraint violation when creating earmark', async () => {
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '20000000000000000000',
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID],
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      // Simulate unique constraint violation
      const uniqueError = new Error('duplicate key value violates unique constraint');
      (database.createEarmark as jest.Mock).mockRejectedValueOnce(uniqueError);

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const infoCalls = mockLogger.info.getCalls();
      const raceConditionLog = infoCalls.find(
        (call) => call.args[0] && call.args[0].includes('Earmark already created by another instance'),
      );
      expect(raceConditionLog).toBeTruthy();
    });

    it('should skip intent if missing hub_settlement_domain', async () => {
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '20000000000000000000',
        hub_settlement_domain: null,
        destinations: [MANTLE_CHAIN_ID],
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const warnCalls = mockLogger.warn.getCalls();
      const missingDomainLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('Intent does not have a hub settlement domain'),
      );
      expect(missingDomainLog).toBeTruthy();
    });

    it('should skip intent if destination is not exactly Mantle', async () => {
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '20000000000000000000',
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID, '999'], // Multiple destinations
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const warnCalls = mockLogger.warn.getCalls();
      const destinationLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('Intent does not have exactly one destination - mantle'),
      );
      expect(destinationLog).toBeTruthy();
    });
  });

  describe('Fill Service - Threshold Rebalancing (Priority 2)', () => {
    it('should skip if thresholdEnabled is false', async () => {
      const noFsThresholdConfig = createMockConfig({
        methRebalance: {
          ...createMockConfig().methRebalance!,
          fillService: {
            ...createMockConfig().methRebalance!.fillService,
            thresholdEnabled: false,
          },
        },
      });

      await rebalanceMantleEth({
        ...mockContext,
        config: noFsThresholdConfig,
      } as unknown as ProcessingContext);

      const debugCalls = mockLogger.debug.getCalls();
      const fsDisabledLog = debugCalls.find(
        (call) => call.args[0] && call.args[0].includes('FS threshold rebalancing disabled'),
      );
      expect(fsDisabledLog).toBeTruthy();
    });

    it('should skip if fillServiceChainService is not available', async () => {
      const contextWithoutFsService = {
        ...mockContext,
        fillServiceChainService: undefined,
      };

      await rebalanceMantleEth(contextWithoutFsService as unknown as ProcessingContext);

      const warnCalls = mockLogger.warn.getCalls();
      const missingServiceLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('Fill service chain service not found'),
      );
      expect(missingServiceLog).toBeTruthy();
    });

    it('should skip if FS receiver has enough mETH', async () => {
      // FS receiver has 500 mETH (above 100 threshold)
      getEvmBalanceStub.callsFake(async (_config, chainId, address) => {
        if (chainId === MANTLE_CHAIN_ID.toString() && address === MOCK_FS_ADDRESS) {
          return BigInt('500000000000000000000'); // 500 mETH
        }
        return BigInt('1000000000000000000000'); // 1000 WETH on mainnet
      });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const infoCalls = mockLogger.info.getCalls();
      const enoughBalanceLog = infoCalls.find(
        (call) => call.args[0] && call.args[0].includes('FS receiver has enough mETH, no rebalance needed'),
      );
      expect(enoughBalanceLog).toBeTruthy();
    });

    it('should skip if shortfall is below minimum rebalance amount', async () => {
      // FS receiver has 100 mETH (threshold is 100, target is 105, shortfall is 5)
      // Shortfall of 5 is below 10 minimum, should skip
      const smallShortfallConfig = createMockConfig({
        methRebalance: {
          ...createMockConfig().methRebalance!,
          fillService: {
            ...createMockConfig().methRebalance!.fillService,
            threshold: '100000000000000000000', // 100 mETH
            targetBalance: '105000000000000000000', // 105 mETH (small target)
          },
          bridge: {
            ...createMockConfig().methRebalance!.bridge!,
            minRebalanceAmount: '10000000000000000000', // 10 mETH minimum
          },
        },
      });

      getEvmBalanceStub.callsFake(async (_config, chainId, address) => {
        if (chainId === MANTLE_CHAIN_ID.toString() && address === MOCK_FS_ADDRESS) {
          // Set to 99 mETH (below threshold) so it doesn't return early
          // Shortfall = 105 - 99 = 6 mETH (below 10 minimum)
          return BigInt('99000000000000000000'); // 99 mETH
        }
        return BigInt('1000000000000000000000'); // 1000 WETH on mainnet
      });

      await rebalanceMantleEth({
        ...mockContext,
        config: smallShortfallConfig,
      } as unknown as ProcessingContext);

      const debugCalls = mockLogger.debug.getCalls();
      const shortfallLog = debugCalls.find(
        (call) => call.args[0] && call.args[0].includes('FS shortfall below minimum rebalance amount'),
      );
      expect(shortfallLog).toBeTruthy();
    });

    it('should bridge available amount if sender has less than shortfall', async () => {
      // FS receiver has 50 mETH (below 100 threshold, target is 500, shortfall is 450)
      // FS sender has 200 WETH (less than 450 shortfall)
      // Should bridge 200 WETH (available amount)
      getEvmBalanceStub.callsFake(async (_config, chainId, address) => {
        if (chainId === MANTLE_CHAIN_ID.toString() && address === MOCK_FS_ADDRESS) {
          return BigInt('50000000000000000000'); // 50 mETH (below threshold)
        }
        if (chainId === MAINNET_CHAIN_ID.toString() && address === MOCK_FS_SENDER_ADDRESS) {
          return BigInt('200000000000000000000'); // 200 WETH (less than 450 shortfall)
        }
        return BigInt('1000000000000000000000'); // 1000 WETH for others
      });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const warnCalls = mockLogger.warn.getCalls();
      const insufficientLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('FS sender has insufficient WETH to cover the full shortfall'),
      );
      expect(insufficientLog).toBeTruthy();

      const infoCalls = mockLogger.info.getCalls();
      const triggerLog = infoCalls.find(
        (call) => call.args[0] && call.args[0].includes('FS threshold rebalancing triggered'),
      );
      expect(triggerLog).toBeTruthy();
    });

    it('should skip if available amount is below minimum', async () => {
      // FS receiver has 50 mETH, shortfall is 450
      // FS sender has only 5 WETH (below 10 minimum)
      getEvmBalanceStub.callsFake(async (_config, chainId, address) => {
        if (chainId === MANTLE_CHAIN_ID.toString() && address === MOCK_FS_ADDRESS) {
          return BigInt('50000000000000000000'); // 50 mETH
        }
        if (chainId === MAINNET_CHAIN_ID.toString() && address === MOCK_FS_SENDER_ADDRESS) {
          return BigInt('5000000000000000000'); // 5 WETH (below 10 minimum)
        }
        return BigInt('1000000000000000000000');
      });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const infoCalls = mockLogger.info.getCalls();
      const belowMinLog = infoCalls.find(
        (call) => call.args[0] && call.args[0].includes('Available WETH below minimum rebalance threshold'),
      );
      expect(belowMinLog).toBeTruthy();
    });

    it('should add committed funds to receiver balance', async () => {
      // This test verifies that committed funds from intent-based flow
      // are added to receiver balance in threshold flow
      const mockIntent = {
        intent_id: 'intent-001',
        amount_out_min: '10000000000000000000', // 10 WETH
        hub_settlement_domain: MAINNET_CHAIN_ID.toString(),
        destinations: [MANTLE_CHAIN_ID],
      };

      mockEverclear.fetchIntents.resolves([mockIntent] as any);

      // FS receiver has 90 mETH (below 100 threshold)
      // After committing 10 WETH from intent, effective balance is 100 (at threshold)
      getEvmBalanceStub.callsFake(async (_config, chainId, address) => {
        if (chainId === MANTLE_CHAIN_ID.toString() && address === MOCK_FS_ADDRESS) {
          return BigInt('90000000000000000000'); // 90 mETH
        }
        // Balance on mainnet for FS address (for intent processing)
        if (chainId === MAINNET_CHAIN_ID.toString() && address === MOCK_FS_ADDRESS) {
          return BigInt('500000000000000000000'); // 500 WETH (sufficient for intent)
        }
        return BigInt('1000000000000000000000');
      });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      // Should process intent first, then check threshold with committed funds
      expect(database.createEarmark).toHaveBeenCalled();
    });
  });

  describe('Operation Timeout Handling', () => {
    it('should mark timed-out operations as cancelled', async () => {
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 25); // 25 hours ago (exceeds 24h TTL)

      const timedOutOperation = {
        id: 'op-timeout-001',
        earmarkId: null,
        originChainId: Number(MAINNET_CHAIN_ID),
        destinationChainId: Number(MANTLE_CHAIN_ID),
        tickerHash: WETH_TICKER_HASH,
        amount: '10000000000000000000',
        slippage: 500,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'across-mantle',
        transactions: {},
        createdAt: oldDate,
        updatedAt: oldDate,
      };

      const dbMock = mockContext.database as any;
      dbMock.getRebalanceOperations = stub().resolves({
        operations: [timedOutOperation],
        total: 1,
      });
      dbMock.updateRebalanceOperation = stub().resolves({});

      await executeMethCallbacks(mockContext as unknown as ProcessingContext);

      expect(dbMock.updateRebalanceOperation.called).toBe(true);
      expect(dbMock.updateRebalanceOperation.calledWith(
        'op-timeout-001',
        sinon.match.object,
      )).toBe(true);
    });

    it('should cancel associated earmark when operation times out', async () => {
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 25);

      const timedOutOperation = {
        id: 'op-timeout-002',
        earmarkId: 'earmark-timeout-001',
        originChainId: Number(MAINNET_CHAIN_ID),
        destinationChainId: Number(MANTLE_CHAIN_ID),
        tickerHash: WETH_TICKER_HASH,
        amount: '10000000000000000000',
        slippage: 500,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'across-mantle',
        transactions: {},
        createdAt: oldDate,
        updatedAt: oldDate,
      };

      const dbMock = mockContext.database as any;
      dbMock.getRebalanceOperations = stub().resolves({
        operations: [timedOutOperation],
        total: 1,
      });
      dbMock.updateRebalanceOperation = stub().resolves({});
      dbMock.updateEarmarkStatus = stub().resolves({});

      await executeMethCallbacks(mockContext as unknown as ProcessingContext);

      expect(dbMock.updateEarmarkStatus.called).toBe(true);
      expect(dbMock.updateEarmarkStatus.calledWith('earmark-timeout-001', EarmarkStatus.CANCELLED)).toBe(true);
    });

    it('should use config TTL if provided', async () => {
      const customTtlConfig = createMockConfig({
        regularRebalanceOpTTLMinutes: 12 * 60, // 12 hours
      });

      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 13); // 13 hours ago (exceeds 12h TTL)

      const timedOutOperation = {
        id: 'op-timeout-003',
        earmarkId: null,
        originChainId: Number(MAINNET_CHAIN_ID),
        destinationChainId: Number(MANTLE_CHAIN_ID),
        tickerHash: WETH_TICKER_HASH,
        amount: '10000000000000000000',
        slippage: 500,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'across-mantle',
        transactions: {},
        createdAt: oldDate,
        updatedAt: oldDate,
      };

      const dbMock = mockContext.database as any;
      dbMock.getRebalanceOperations = stub().resolves({
        operations: [timedOutOperation],
        total: 1,
      });
      dbMock.updateRebalanceOperation = stub().resolves({});

      await executeMethCallbacks({
        ...mockContext,
        config: customTtlConfig,
      } as unknown as ProcessingContext);

      expect(dbMock.updateRebalanceOperation.called).toBe(true);
    });
  });

  describe('Callback Execution', () => {
    it('should process pending operations', async () => {
      const pendingOperation = {
        id: 'op-pending-001',
        earmarkId: null,
        originChainId: 999, // Not mainnet (so needs receipt)
        destinationChainId: Number(MAINNET_CHAIN_ID),
        tickerHash: WETH_TICKER_HASH,
        amount: '10000000000000000000',
        slippage: 500,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'across-mantle',
        recipient: MOCK_FS_ADDRESS, // FS recipient
        transactions: {
          '999': {
            transactionHash: '0x123',
            metadata: {
              receipt: {
                transactionHash: '0x123',
                blockNumber: 1000n,
              },
            },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const dbMock = mockContext.database as any;
      dbMock.getRebalanceOperations = stub().resolves({
        operations: [pendingOperation],
        total: 1,
      });
      dbMock.updateRebalanceOperation = stub().resolves({});

      // Mock adapter
      const mockAdapter = {
        type: stub().returns(SupportedBridge.Across),
        readyOnDestination: stub().resolves(false),
        destinationCallback: stub().resolves(null),
        getReceivedAmount: stub().resolves('10000000000000000000'),
        send: stub().resolves([]),
      };

      mockRebalanceAdapter.getAdapter.returns(mockAdapter as any);

      await executeMethCallbacks(mockContext as unknown as ProcessingContext);

      expect(mockAdapter.readyOnDestination.called).toBe(true);
    });

    it('should skip operations not ready for callback', async () => {
      const pendingOperation = {
        id: 'op-pending-002',
        earmarkId: null,
        originChainId: 999, // Not mainnet (so needs receipt)
        destinationChainId: Number(MAINNET_CHAIN_ID),
        tickerHash: WETH_TICKER_HASH,
        amount: '10000000000000000000',
        slippage: 500,
        status: RebalanceOperationStatus.PENDING,
        bridge: 'across-mantle',
        recipient: MOCK_MM_ADDRESS, // MM recipient
        transactions: {
          '999': {
            transactionHash: '0x123',
            metadata: {
              receipt: {
                transactionHash: '0x123',
                blockNumber: 1000n,
              },
            },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const dbMock = mockContext.database as any;
      dbMock.getRebalanceOperations = stub().resolves({
        operations: [pendingOperation],
        total: 1,
      });
      dbMock.updateRebalanceOperation = stub().resolves({});

      const mockAdapter = {
        type: stub().returns(SupportedBridge.Across),
        readyOnDestination: stub().resolves(false), // Not ready
        destinationCallback: stub().resolves(null),
        getReceivedAmount: stub().resolves('10000000000000000000'),
        send: stub().resolves([]),
      };

      mockRebalanceAdapter.getAdapter.returns(mockAdapter as any);

      await executeMethCallbacks(mockContext as unknown as ProcessingContext);

      const infoCalls = mockLogger.info.getCalls();
      const notReadyLog = infoCalls.find(
        (call) => call.args[0] && call.args[0].includes('Action not ready for destination callback'),
      );
      expect(notReadyLog).toBeTruthy();
    });

    it('should use FS sender for FS recipient operations in callbacks', async () => {
      const awaitingCallbackOperation = {
        id: 'op-callback-001',
        earmarkId: null,
        originChainId: Number(MAINNET_CHAIN_ID),
        destinationChainId: Number(MANTLE_CHAIN_ID),
        tickerHash: WETH_TICKER_HASH,
        amount: '10000000000000000000',
        slippage: 50,
        status: RebalanceOperationStatus.AWAITING_CALLBACK,
        bridge: 'across-mantle',
        recipient: MOCK_FS_ADDRESS, // FS recipient
        transactions: {
          [MAINNET_CHAIN_ID]: {
            transactionHash: '0x123',
            metadata: {
              receipt: {
                transactionHash: '0x123',
                blockNumber: 1000n,
              },
            },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const dbMock = mockContext.database as any;
      dbMock.getRebalanceOperations = stub().resolves({
        operations: [awaitingCallbackOperation],
        total: 1,
      });
      dbMock.updateRebalanceOperation = stub().resolves({});

      // Mock Mantle adapter for Leg 2
      const mockMantleAdapter = {
        type: stub().returns(SupportedBridge.Mantle),
        getReceivedAmount: stub().resolves('10000000000000000000'),
        send: stub().resolves([
          {
            transaction: {
              to: '0x123',
              data: '0x456',
              value: BigInt('10000000000000000000'),
            },
            memo: RebalanceTransactionMemo.Rebalance,
            effectiveAmount: '10000000000000000000',
          },
        ]),
      };

      mockRebalanceAdapter.getAdapter.callsFake((bridgeType: SupportedBridge) => {
        if (bridgeType === SupportedBridge.Mantle) {
          return mockMantleAdapter as any;
        }
        return null;
      });

      // Mock submitTransactionWithLogging to capture sender
      const submitTxStub = stub(transactionHelpers, 'submitTransactionWithLogging');
      submitTxStub.resolves({
        hash: '0x789',
        receipt: {
          transactionHash: '0x789',
          blockNumber: 2000n,
          from: MOCK_FS_SENDER_ADDRESS,
          to: '0x123',
          cumulativeGasUsed: 100000n,
          effectiveGasPrice: 20000000000n,
          gasUsed: 100000n,
          status: 'success',
          logs: [],
          transactionIndex: 0,
        } as any,
        submissionType: 'direct' as any,
      });

      await executeMethCallbacks(mockContext as unknown as ProcessingContext);

      // Verify FS sender was used - check that submitTransactionWithLogging was called
      // with fillServiceChainService (indirectly via selectedChainService)
      expect(submitTxStub.called).toBe(true);
      expect(dbMock.updateRebalanceOperation.called).toBe(true);
      submitTxStub.restore();
    });
  });

  describe('Error Handling', () => {
    it('should handle errors when checking FS receiver balance', async () => {
      getEvmBalanceStub.callsFake(async (_config, chainId, address) => {
        if (chainId === MANTLE_CHAIN_ID.toString() && address === MOCK_FS_ADDRESS) {
          throw new Error('RPC error');
        }
        return BigInt('1000000000000000000000');
      });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const warnCalls = mockLogger.warn.getCalls();
      const errorLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('Failed to check FS receiver mETH balance'),
      );
      expect(errorLog).toBeTruthy();
    });

    it('should handle errors when checking FS sender balance', async () => {
      getEvmBalanceStub.callsFake(async (_config, chainId, address) => {
        if (chainId === MAINNET_CHAIN_ID.toString() && address === MOCK_FS_SENDER_ADDRESS) {
          throw new Error('RPC error');
        }
        return BigInt('1000000000000000000000');
      });

      await rebalanceMantleEth(mockContext as unknown as ProcessingContext);

      const warnCalls = mockLogger.warn.getCalls();
      const errorLog = warnCalls.find(
        (call) => call.args[0] && call.args[0].includes('Failed to check FS sender WETH balance'),
      );
      expect(errorLog).toBeTruthy();
    });

    it('should handle errors when fetching intents', async () => {
      mockEverclear.fetchIntents.rejects(new Error('API error'));

      await expect(rebalanceMantleEth(mockContext as unknown as ProcessingContext)).rejects.toThrow('API error');
    });
  });
});
