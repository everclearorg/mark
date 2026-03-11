import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore } from 'sinon';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import {
  MarkConfiguration,
  SupportedBridge,
  RebalanceOperationStatus,
  MAINNET_CHAIN_ID,
  MANTLE_CHAIN_ID,
  PostBridgeActionType,
  TokenRebalanceConfig,
  WalletType,
} from '@mark/core';
import { ProcessingContext } from '../../src/init';
import { createDatabaseMock } from '../mocks/database';
import { mockConfig } from '../mocks';
import { AaveTokenFlowDescriptor } from '../../src/rebalance/aaveTokenRebalancer';

// --- Mocks ---

jest.mock('../../src/helpers', () => {
  const actual = jest.requireActual('../../src/helpers');
  return {
    ...actual,
    getEvmBalance: jest.fn().mockResolvedValue(0n),
    safeParseBigInt: jest.fn((value: string | undefined) => {
      if (!value) return 0n;
      try {
        return BigInt(value);
      } catch {
        return 0n;
      }
    }),
    convertToNativeUnits: jest.fn((amount: bigint, decimals?: number) => {
      const targetDecimals = decimals ?? 18;
      if (targetDecimals === 18) return amount;
      const divisor = BigInt(10 ** (18 - targetDecimals));
      return amount / divisor;
    }),
  };
});

jest.mock('../../src/helpers/zodiac', () => ({
  getValidatedZodiacConfig: jest.fn().mockReturnValue({ walletType: 'EOA' }),
  getActualOwner: jest.fn((_zodiacConfig: unknown, ownAddress: string) => ownAddress),
}));

jest.mock('../../src/helpers/transactions', () => ({
  submitTransactionWithLogging: jest.fn(() =>
    Promise.resolve({
      hash: '0xtestHash',
      receipt: {
        transactionHash: '0xtestHash',
        blockNumber: 1000n,
        blockHash: '0xblockhash',
        from: '0xfrom',
        to: '0xto',
        cumulativeGasUsed: 100000n,
        effectiveGasPrice: 1000000000n,
        gasUsed: 50000n,
        status: 'success',
        contractAddress: null,
        logs: [],
        logsBloom: '0x',
        transactionIndex: 0,
        type: 'legacy',
      },
    }),
  ),
}));

jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core');
  return {
    ...actual,
    getDecimalsFromConfig: jest.fn((tickerHash: string, _domain: string) => {
      // USDC: 6 decimals
      if (tickerHash === '0xusdc_ticker') return 6;
      // aToken: 18 decimals (default for aManUSDe) or 6 for aMansyrupUSDT
      if (tickerHash === '0xatoken_ticker') return 18;
      if (tickerHash === '0xatoken_ticker_6dec') return 6;
      // Intermediate token
      if (tickerHash === '0xintermediate_ticker') return 18;
      return undefined;
    }),
    getTokenAddressFromConfig: jest.fn((tickerHash: string, domain: string) => {
      if (tickerHash === '0xusdc_ticker' && domain === MAINNET_CHAIN_ID) return '0xUSDC_MAINNET';
      if (tickerHash === '0xusdc_ticker' && domain === MANTLE_CHAIN_ID) return '0xUSDC_MANTLE';
      if (tickerHash === '0xatoken_ticker' && domain === MANTLE_CHAIN_ID) return '0xATOKEN_MANTLE';
      if (tickerHash === '0xatoken_ticker_6dec' && domain === MANTLE_CHAIN_ID) return '0xATOKEN_MANTLE_6DEC';
      if (tickerHash === '0xintermediate_ticker' && domain === MANTLE_CHAIN_ID) return '0xINTERMEDIATE_MANTLE';
      return undefined;
    }),
  };
});

jest.mock('@mark/database', () => ({
  createRebalanceOperation: jest.fn().mockResolvedValue({ id: 'mock-op-id' }),
  getRebalanceOperations: jest.fn().mockResolvedValue({ operations: [], total: 0 }),
  updateRebalanceOperation: jest.fn().mockResolvedValue({ id: 'mock-op-id' }),
  initializeDatabase: jest.fn(),
  getPool: jest.fn(),
  closeDatabase: jest.fn(),
}));

jest.mock('@mark/rebalance', () => ({
  RebalanceTransactionMemo: {
    Rebalance: 'rebalance',
    Approval: 'approval',
    AaveSupply: 'aave-supply',
    DexSwap: 'dex-swap',
  },
  buildTransactionsForAction: jest.fn().mockResolvedValue([]),
  RebalanceAdapter: jest.fn(),
}));

// Import after mocks
import {
  rebalanceAaveToken,
  executeAaveTokenCallbacks,
  evaluateThresholdRebalance,
  executeStargateBridgeForAaveToken,
} from '../../src/rebalance/aaveTokenRebalancer';
import { rebalanceAManUsde, executeAManUsdeCallbacks } from '../../src/rebalance/aManUsde';
import { rebalanceAMansyrupUsdt, executeAMansyrupUsdtCallbacks } from '../../src/rebalance/aMansyrupUsdt';
import * as database from '@mark/database';
import { getEvmBalance } from '../../src/helpers';
import { submitTransactionWithLogging } from '../../src/helpers/transactions';
import { buildTransactionsForAction } from '@mark/rebalance';
import { getDecimalsFromConfig, getTokenAddressFromConfig } from '@mark/core';

// --- Test helpers ---

function createMockDescriptor(overrides?: Partial<AaveTokenFlowDescriptor>): AaveTokenFlowDescriptor {
  return {
    name: 'TestAaveToken',
    aTokenTickerHash: '0xatoken_ticker',
    intermediateTokenTickerHash: '0xintermediate_ticker',
    sourceTokenTickerHash: '0xusdc_ticker',
    bridgeTag: 'stargate-testaave',
    getConfig: (config) => config.aManUsdeRebalance,
    buildPostBridgeActions: ({ sourceTokenOnMantle, intermediateTokenOnMantle, aavePoolAddress, dexSwapSlippageBps }) => [
      {
        type: PostBridgeActionType.DexSwap as const,
        sellToken: sourceTokenOnMantle,
        buyToken: intermediateTokenOnMantle,
        slippageBps: dexSwapSlippageBps,
      },
      {
        type: PostBridgeActionType.AaveSupply as const,
        poolAddress: aavePoolAddress,
        supplyAsset: intermediateTokenOnMantle,
      },
    ],
    getAavePoolAddress: () => '0xAavePool',
    getDexSwapSlippageBps: () => 100,
    ...overrides,
  };
}

function createMockTokenRebalanceConfig(overrides?: Partial<TokenRebalanceConfig>): TokenRebalanceConfig {
  return {
    enabled: true,
    marketMaker: {
      address: '0xMM',
      onDemandEnabled: false,
      thresholdEnabled: false,
    },
    fillService: {
      address: '0xFS_RECEIVER',
      senderAddress: '0xFS_SENDER',
      thresholdEnabled: true,
      threshold: '500000000000000000000', // 500 in 18 dec
      targetBalance: '1000000000000000000000', // 1000 in 18 dec
    },
    bridge: {
      slippageDbps: 500,
      minRebalanceAmount: '1000000', // 1 USDC in 6 dec
      maxRebalanceAmount: '100000000', // 100 USDC in 6 dec
    },
    ...overrides,
  };
}

describe('Aave Token Rebalancer', () => {
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: { isPaused: SinonStub; getAdapter: SinonStub };
  let mockDatabase: ReturnType<typeof createDatabaseMock>;
  let baseConfig: MarkConfiguration;
  let mockContext: ProcessingContext;

  const MOCK_REQUEST_ID = 'aave-test-request';
  const MOCK_OWN_ADDRESS = '0x1234567890123456789012345678901234567890';

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createStubInstance(Logger);
    mockChainService = createStubInstance(ChainService);
    mockRebalanceAdapter = {
      isPaused: stub().resolves(false),
      getAdapter: stub().returns(undefined),
    };
    mockDatabase = createDatabaseMock();

    baseConfig = {
      ...mockConfig,
      ownAddress: MOCK_OWN_ADDRESS,
      aManUsdeRebalance: createMockTokenRebalanceConfig(),
    } as MarkConfiguration;

    mockContext = {
      config: baseConfig,
      requestId: MOCK_REQUEST_ID,
      startTime: Date.now(),
      logger: mockLogger,
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
      database: mockDatabase,
      everclear: { fetchIntents: stub().resolves([]) },
      prometheus: {} as any,
    } as unknown as ProcessingContext;

    // Default database behavior
    (database.getRebalanceOperations as jest.Mock).mockResolvedValue({ operations: [], total: 0 });
    (database.createRebalanceOperation as jest.Mock).mockResolvedValue({ id: 'mock-op-id' });
    (database.updateRebalanceOperation as jest.Mock).mockResolvedValue({ id: 'mock-op-id' });
  });

  afterEach(() => {
    restore();
    jest.clearAllMocks();
  });

  // ==========================================
  // A. rebalanceAaveToken (main entry)
  // ==========================================
  describe('rebalanceAaveToken', () => {
    const descriptor = createMockDescriptor();

    it('should return empty when config is disabled', async () => {
      const config = {
        ...baseConfig,
        aManUsdeRebalance: { ...createMockTokenRebalanceConfig(), enabled: false },
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      const result = await rebalanceAaveToken(ctx, descriptor);

      expect(result).toEqual([]);
      expect(mockLogger.debug.calledWithMatch('TestAaveToken rebalancing disabled')).toBe(true);
    });

    it('should return empty when rebalance adapter is paused', async () => {
      mockRebalanceAdapter.isPaused.resolves(true);

      const result = await rebalanceAaveToken(mockContext, descriptor);

      expect(result).toEqual([]);
      expect(mockLogger.warn.calledWithMatch('Rebalance loop is paused')).toBe(true);
    });

    it('should return empty when fillService.address is missing', async () => {
      const config = {
        ...baseConfig,
        aManUsdeRebalance: createMockTokenRebalanceConfig({
          fillService: {
            address: undefined,
            thresholdEnabled: true,
          },
        }),
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      const result = await rebalanceAaveToken(ctx, descriptor);

      expect(result).toEqual([]);
      expect(mockLogger.error.calledWithMatch('rebalance configuration validation failed')).toBe(true);
    });

    it('should return empty when bridge.minRebalanceAmount is missing', async () => {
      const rebalanceConfig = createMockTokenRebalanceConfig();
      (rebalanceConfig.bridge as any).minRebalanceAmount = undefined;
      const config = {
        ...baseConfig,
        aManUsdeRebalance: rebalanceConfig,
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      const result = await rebalanceAaveToken(ctx, descriptor);

      expect(result).toEqual([]);
      expect(mockLogger.error.calledWithMatch('rebalance configuration validation failed')).toBe(true);
    });

    it('should call executeAaveTokenCallbacks before threshold evaluation', async () => {
      // Config disabled means we return early after callbacks
      const config = {
        ...baseConfig,
        aManUsdeRebalance: { ...createMockTokenRebalanceConfig(), enabled: false },
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      await rebalanceAaveToken(ctx, descriptor);

      // Verify callbacks were executed (the callback function queries for operations)
      expect(
        (mockDatabase.getRebalanceOperations as SinonStub).calledWithMatch(undefined, undefined, {
          bridge: 'stargate-testaave',
        }),
      ).toBe(true);
    });

    it('should return actions from evaluateThresholdRebalance', async () => {
      // Set up a scenario where threshold rebalancing returns actions
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(0n); // aToken balance = 0 (below threshold)
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(
        BigInt('2000000000000000000000'), // sender has 2000 USDC in 18 decimals
      );

      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('99600000'), // passes slippage: min = 100M - 500k = 99.5M
        send: stub().resolves([
          {
            transaction: { to: '0xStargate', data: '0xdata', funcSig: 'send', value: 0 },
            memo: 'rebalance',
            effectiveAmount: '100000000',
          },
        ]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await rebalanceAaveToken(mockContext, descriptor);

      expect(result.length).toBe(1);
      expect(result[0].bridge).toBe(SupportedBridge.Stargate);
    });
  });

  // ==========================================
  // B. evaluateThresholdRebalance
  // ==========================================
  describe('evaluateThresholdRebalance', () => {
    const descriptor = createMockDescriptor();
    const makeRunState = () => ({ committedSourceToken: 0n });

    it('should return empty when thresholdEnabled is false', async () => {
      const config = {
        ...baseConfig,
        aManUsdeRebalance: createMockTokenRebalanceConfig({
          fillService: {
            address: '0xFS_RECEIVER',
            thresholdEnabled: false,
          },
        }),
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      const result = await evaluateThresholdRebalance(ctx, descriptor, makeRunState());

      expect(result).toEqual([]);
    });

    it('should return empty when in-flight operations exist for this bridge tag', async () => {
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [{ id: 'existing-op', status: RebalanceOperationStatus.PENDING }],
        total: 1,
      });

      const result = await evaluateThresholdRebalance(mockContext, descriptor, makeRunState());

      expect(result).toEqual([]);
      expect(mockLogger.info.calledWithMatch('in-flight')).toBe(true);
    });

    it('should return empty when aToken not found in chain config', async () => {
      const badDescriptor = createMockDescriptor({ aTokenTickerHash: '0xnonexistent' });

      const result = await evaluateThresholdRebalance(mockContext, badDescriptor, makeRunState());

      expect(result).toEqual([]);
      expect(mockLogger.error.calledWithMatch('token not found in chain config for Mantle')).toBe(true);
    });

    it('should return empty when aToken balance >= threshold', async () => {
      // Balance of 600 in 18 dec, threshold is 500
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(BigInt('600000000000000000000'));

      const result = await evaluateThresholdRebalance(mockContext, descriptor, makeRunState());

      expect(result).toEqual([]);
      expect(mockLogger.info.calledWithMatch('no rebalance needed')).toBe(true);
    });

    it('should return empty when shortfall < minRebalanceAmount', async () => {
      // Balance just slightly below threshold — shortfall is tiny
      // threshold = 500e18, target = 1000e18, balance = 999.9999e18 → shortfall ≈ 0.0001e18 → in USDC: ~0
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(BigInt('999999900000000000000'));

      const result = await evaluateThresholdRebalance(mockContext, descriptor, makeRunState());

      expect(result).toEqual([]);
    });

    it('should return empty when sender balance < minRebalanceAmount after conversion', async () => {
      // aToken balance = 0, so shortfall is large, but sender has very little USDC
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(0n); // aToken = 0
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(BigInt('100000000000')); // sender = 0.0001 USDC in 18 dec

      const result = await evaluateThresholdRebalance(mockContext, descriptor, makeRunState());

      expect(result).toEqual([]);
    });

    it('should cap amount at maxRebalanceAmount', async () => {
      // aToken balance = 0, shortfall = 1000 in USDC (1000e6), sender has plenty
      // maxRebalanceAmount = 100e6 USDC
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(0n); // aToken = 0
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(
        BigInt('5000000000000000000000'), // sender = 5000 USDC in 18 dec
      );

      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('99600000'), // passes slippage: min = 100M - 500k = 99.5M
        send: stub().resolves([
          {
            transaction: { to: '0xStargate', data: '0xdata', funcSig: 'send', value: 0 },
            memo: 'rebalance',
            effectiveAmount: '100000000',
          },
        ]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await evaluateThresholdRebalance(mockContext, descriptor, makeRunState());

      // Should have capped at 100e6 (maxRebalanceAmount)
      expect(result.length).toBe(1);
      expect(result[0].amount).toBe('100000000');
    });

    it('should bridge shortfall amount when shortfall < sender balance', async () => {
      // aToken balance = 800e18, threshold = 900e18 (below → triggers), target = 1000e18
      // Shortfall = 1000e18 - 800e18 = 200e18 → 200e6 USDC. Sender has 5000 USDC.
      // maxRebalanceAmount = 500e6 — higher than shortfall, so bridge 200e6
      const config = {
        ...baseConfig,
        aManUsdeRebalance: createMockTokenRebalanceConfig({
          fillService: {
            address: '0xFS_RECEIVER',
            senderAddress: '0xFS_SENDER',
            thresholdEnabled: true,
            threshold: '900000000000000000000', // 900 in 18 dec — balance 800 is below this
            targetBalance: '1000000000000000000000',
          },
          bridge: {
            slippageDbps: 500,
            minRebalanceAmount: '1000000',
            maxRebalanceAmount: '500000000', // 500 USDC — higher than shortfall
          },
        }),
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      (getEvmBalance as jest.Mock).mockResolvedValueOnce(BigInt('800000000000000000000')); // aToken = 800
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(
        BigInt('5000000000000000000000'), // sender = 5000 USDC in 18 dec
      );

      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('199500000'), // passes slippage: min = 200M - 1M = 199M
        send: stub().resolves([
          {
            transaction: { to: '0xStargate', data: '0xdata', funcSig: 'send', value: 0 },
            memo: 'rebalance',
            effectiveAmount: '200000000',
          },
        ]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await evaluateThresholdRebalance(ctx, descriptor, makeRunState());

      expect(result.length).toBe(1);
      // Shortfall = 200e18 → 200e6 in USDC, sender has 5000e6. Bridge 200e6.
      expect(result[0].amount).toBe('200000000');
    });

    it('should bridge sender balance when sender balance < shortfall', async () => {
      // aToken = 0, shortfall = 1000e18 → 1000e6 USDC, sender has only 50 USDC
      const config = {
        ...baseConfig,
        aManUsdeRebalance: createMockTokenRebalanceConfig({
          bridge: {
            slippageDbps: 500,
            minRebalanceAmount: '1000000', // 1 USDC
          },
        }),
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      (getEvmBalance as jest.Mock)
        .mockResolvedValueOnce(0n) // aToken = 0
        .mockResolvedValueOnce(BigInt('50000000000000000000')); // sender = 50 USDC in 18 dec

      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('49800000'), // passes slippage: min = 50M - 250k = 49.75M
        send: stub().resolves([
          {
            transaction: { to: '0xStargate', data: '0xdata', funcSig: 'send', value: 0 },
            memo: 'rebalance',
            effectiveAmount: '50000000',
          },
        ]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await evaluateThresholdRebalance(ctx, descriptor, makeRunState());

      expect(result.length).toBe(1);
      // sender has 50e6 USDC which is less than 1000e6 shortfall → bridge 50e6
      expect(result[0].amount).toBe('50000000');
    });

    it('should correctly convert between different decimal aToken and source token', async () => {
      // Test with 6-decimal aToken (like aMansyrupUSDT)
      const descriptor6dec = createMockDescriptor({
        aTokenTickerHash: '0xatoken_ticker_6dec',
      });

      const config = {
        ...baseConfig,
        aManUsdeRebalance: createMockTokenRebalanceConfig({
          fillService: {
            address: '0xFS_RECEIVER',
            senderAddress: '0xFS_SENDER',
            thresholdEnabled: true,
            // With 6-decimal aToken, getEvmBalance normalizes to 18 dec
            threshold: '500000000000000000000', // 500 in 18 dec
            targetBalance: '1000000000000000000000', // 1000 in 18 dec
          },
          bridge: {
            slippageDbps: 500,
            minRebalanceAmount: '1000000',
            maxRebalanceAmount: undefined,
          },
        }),
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      // Balance is 0 → shortfall is 1000e18 → 1000e6 in USDC
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(0n);
      (getEvmBalance as jest.Mock).mockResolvedValueOnce(
        BigInt('2000000000000000000000'), // sender = 2000 USDC in 18 dec
      );

      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('999000000'), // passes slippage: min = 1000M - 5M = 995M
        send: stub().resolves([
          {
            transaction: { to: '0xStargate', data: '0xdata', funcSig: 'send', value: 0 },
            memo: 'rebalance',
            effectiveAmount: '1000000000',
          },
        ]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await evaluateThresholdRebalance(ctx, descriptor6dec, makeRunState());

      expect(result.length).toBe(1);
    });
  });

  // ==========================================
  // C. executeStargateBridgeForAaveToken
  // ==========================================
  describe('executeStargateBridgeForAaveToken', () => {
    const descriptor = createMockDescriptor();

    it('should return empty when Stargate adapter not found', async () => {
      mockRebalanceAdapter.getAdapter.returns(undefined);

      const result = await executeStargateBridgeForAaveToken(
        mockContext,
        descriptor,
        '0xSender',
        '0xRecipient',
        1000000n,
      );

      expect(result).toEqual([]);
      expect(mockLogger.error.calledWithMatch('Stargate adapter not found')).toBe(true);
    });

    it('should return empty when quote fails slippage check', async () => {
      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('1'), // Way too low
        send: stub().resolves([]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await executeStargateBridgeForAaveToken(
        mockContext,
        descriptor,
        '0xSender',
        '0xRecipient',
        1000000n,
      );

      expect(result).toEqual([]);
      expect(mockLogger.warn.calledWithMatch('slippage requirements')).toBe(true);
    });

    it('should submit transactions and create DB record with correct bridge tag', async () => {
      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('995000'),
        send: stub().resolves([
          {
            transaction: { to: '0xStargate', data: '0xBridgeData', funcSig: 'send', value: 0 },
            memo: 'rebalance',
            effectiveAmount: '1000000',
          },
        ]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await executeStargateBridgeForAaveToken(
        mockContext,
        descriptor,
        '0xSender',
        '0xRecipient',
        1000000n,
      );

      expect(result.length).toBe(1);
      expect(result[0].bridge).toBe(SupportedBridge.Stargate);
      expect(result[0].recipient).toBe('0xRecipient');

      // Verify DB record was created with correct bridge tag
      expect(database.createRebalanceOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          bridge: 'stargate-testaave',
          tickerHash: '0xusdc_ticker',
          status: RebalanceOperationStatus.PENDING,
        }),
      );
    });

    it('should return RebalanceAction with correct fields', async () => {
      const mockStargateAdapter = {
        getReceivedAmount: stub().resolves('996000'), // passes slippage: min = 1M - 5k = 995k
        send: stub().resolves([
          {
            transaction: { to: '0xStargate', data: '0xdata', funcSig: 'send', value: 0 },
            memo: 'rebalance',
            effectiveAmount: '1000000',
          },
        ]),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      const result = await executeStargateBridgeForAaveToken(
        mockContext,
        descriptor,
        '0xSender',
        '0xRecipient',
        1000000n,
      );

      expect(result.length).toBe(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          bridge: SupportedBridge.Stargate,
          amount: '1000000',
          origin: 1,
          destination: 5000,
          asset: '0xUSDC_MAINNET',
          recipient: '0xRecipient',
        }),
      );
    });
  });

  // ==========================================
  // D. executeAaveTokenCallbacks
  // ==========================================
  describe('executeAaveTokenCallbacks', () => {
    const descriptor = createMockDescriptor();

    it('should cancel timed-out operations', async () => {
      const expiredDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-expired',
            status: RebalanceOperationStatus.PENDING,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            createdAt: expiredDate,
            transactions: {},
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptor);

      expect((mockDatabase.updateRebalanceOperation as SinonStub).calledWith('op-expired', {
        status: RebalanceOperationStatus.CANCELLED,
      })).toBe(true);
    });

    it('should transition PENDING -> AWAITING_CALLBACK when readyOnDestination is true', async () => {
      const mockStargateAdapter = {
        readyOnDestination: stub().resolves(true),
        destinationCallback: stub().resolves(null),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-pending',
            status: RebalanceOperationStatus.PENDING,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {
              1: {
                transactionHash: '0xOriginTx',
                metadata: { receipt: { transactionHash: '0xOriginTx' } },
              },
            },
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptor);

      // Should update to AWAITING_CALLBACK first, then to AWAITING_POST_BRIDGE
      const updateCalls = (mockDatabase.updateRebalanceOperation as SinonStub).getCalls();
      expect(updateCalls.some((call) => call.args[1].status === RebalanceOperationStatus.AWAITING_CALLBACK)).toBe(
        true,
      );
    });

    it('should stay PENDING when readyOnDestination is false', async () => {
      const mockStargateAdapter = {
        readyOnDestination: stub().resolves(false),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-pending',
            status: RebalanceOperationStatus.PENDING,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {
              1: {
                transactionHash: '0xOriginTx',
                metadata: { receipt: { transactionHash: '0xOriginTx' } },
              },
            },
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptor);

      // No status update should have happened
      expect((mockDatabase.updateRebalanceOperation as SinonStub).called).toBe(false);
    });

    it('should transition AWAITING_CALLBACK -> AWAITING_POST_BRIDGE after callback', async () => {
      const mockStargateAdapter = {
        destinationCallback: stub().resolves({
          transaction: { to: '0xCallbackTarget', data: '0xCallbackData', funcSig: 'callback' },
          memo: 'destination-callback',
        }),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-awaiting-callback',
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {
              1: {
                transactionHash: '0xOriginTx',
                metadata: { receipt: { transactionHash: '0xOriginTx' } },
              },
            },
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptor);

      const updateCalls = (mockDatabase.updateRebalanceOperation as SinonStub).getCalls();
      expect(
        updateCalls.some((call) => call.args[1].status === RebalanceOperationStatus.AWAITING_POST_BRIDGE),
      ).toBe(true);
      expect(submitTransactionWithLogging).toHaveBeenCalled();
    });

    it('should handle no destination callback (Stargate case)', async () => {
      const mockStargateAdapter = {
        destinationCallback: stub().resolves(null),
      };
      mockRebalanceAdapter.getAdapter.returns(mockStargateAdapter as any);

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-awaiting-callback',
            status: RebalanceOperationStatus.AWAITING_CALLBACK,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {
              1: {
                transactionHash: '0xOriginTx',
                metadata: { receipt: { transactionHash: '0xOriginTx' } },
              },
            },
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptor);

      // Should still transition to AWAITING_POST_BRIDGE even without callback
      const updateCalls = (mockDatabase.updateRebalanceOperation as SinonStub).getCalls();
      expect(
        updateCalls.some((call) => call.args[1].status === RebalanceOperationStatus.AWAITING_POST_BRIDGE),
      ).toBe(true);
      expect(mockLogger.info.calledWithMatch('No destination callback required')).toBe(true);
    });

    it('should execute post-bridge DexSwap + AaveSupply and transition to COMPLETED', async () => {
      (buildTransactionsForAction as jest.Mock)
        .mockResolvedValueOnce([
          {
            transaction: { to: '0xDex', data: '0xSwapData', funcSig: 'swap' },
            memo: 'dex-swap',
            effectiveAmount: '1000000',
          },
        ])
        .mockResolvedValueOnce([
          {
            transaction: { to: '0xAave', data: '0xSupplyData', funcSig: 'supply' },
            memo: 'aave-supply',
          },
        ]);

      mockRebalanceAdapter.getAdapter.returns({} as any); // adapter not used for post-bridge

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-post-bridge',
            status: RebalanceOperationStatus.AWAITING_POST_BRIDGE,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {},
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptor);

      // Should have called buildTransactionsForAction twice (DexSwap + AaveSupply)
      expect(buildTransactionsForAction).toHaveBeenCalledTimes(2);

      // Should have submitted both transactions
      expect(submitTransactionWithLogging).toHaveBeenCalledTimes(2);

      // Should update to COMPLETED
      const updateCalls = (mockDatabase.updateRebalanceOperation as SinonStub).getCalls();
      expect(updateCalls.some((call) => call.args[1].status === RebalanceOperationStatus.COMPLETED)).toBe(true);
    });

    it('should stay AWAITING_POST_BRIDGE on error for retry next cycle', async () => {
      (buildTransactionsForAction as jest.Mock).mockRejectedValueOnce(new Error('DexSwap failed'));

      mockRebalanceAdapter.getAdapter.returns({} as any);

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-post-bridge',
            status: RebalanceOperationStatus.AWAITING_POST_BRIDGE,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {},
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptor);

      // Should NOT have updated to COMPLETED
      const updateCalls = (mockDatabase.updateRebalanceOperation as SinonStub).getCalls();
      expect(updateCalls.some((call) => call.args[1].status === RebalanceOperationStatus.COMPLETED)).toBe(false);

      // Should have logged the error
      expect(mockLogger.error.calledWithMatch('Failed to execute post-bridge actions, will retry')).toBe(true);
    });

    it('should error when aavePoolAddress is not set', async () => {
      const descriptorNoPool = createMockDescriptor({
        getAavePoolAddress: () => undefined,
      });

      mockRebalanceAdapter.getAdapter.returns({} as any);

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-post-bridge',
            status: RebalanceOperationStatus.AWAITING_POST_BRIDGE,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {},
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptorNoPool);

      expect(mockLogger.error.calledWithMatch('Aave pool address not set')).toBe(true);
      // Should NOT update to COMPLETED
      expect((mockDatabase.updateRebalanceOperation as SinonStub).called).toBe(false);
    });

    it('should use descriptor.buildPostBridgeActions to construct the action sequence', async () => {
      const buildPostBridgeActionsSpy = jest.fn().mockReturnValue([
        {
          type: PostBridgeActionType.DexSwap,
          sellToken: '0xUSDC_MANTLE',
          buyToken: '0xINTERMEDIATE_MANTLE',
          slippageBps: 100,
        },
        {
          type: PostBridgeActionType.AaveSupply,
          poolAddress: '0xAavePool',
          supplyAsset: '0xINTERMEDIATE_MANTLE',
        },
      ]);

      const descriptorWithSpy = createMockDescriptor({
        buildPostBridgeActions: buildPostBridgeActionsSpy,
      });

      (buildTransactionsForAction as jest.Mock).mockResolvedValue([]);
      mockRebalanceAdapter.getAdapter.returns({} as any);

      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-post-bridge',
            status: RebalanceOperationStatus.AWAITING_POST_BRIDGE,
            bridge: 'stargate-testaave',
            originChainId: 1,
            destinationChainId: 5000,
            tickerHash: '0xusdc_ticker',
            amount: '1000000',
            createdAt: new Date(),
            transactions: {},
          },
        ],
        total: 1,
      });

      await executeAaveTokenCallbacks(mockContext, descriptorWithSpy);

      expect(buildPostBridgeActionsSpy).toHaveBeenCalledWith({
        sourceTokenOnMantle: '0xUSDC_MANTLE',
        intermediateTokenOnMantle: '0xINTERMEDIATE_MANTLE',
        aavePoolAddress: '0xAavePool',
        dexSwapSlippageBps: 100,
      });
    });
  });

  // ==========================================
  // E. Thin wrapper wiring
  // ==========================================
  describe('Thin wrapper wiring', () => {
    it('rebalanceAManUsde delegates to rebalanceAaveToken with correct descriptor', async () => {
      // With config disabled, it should return empty - proving delegation works
      const config = {
        ...baseConfig,
        aManUsdeRebalance: { ...createMockTokenRebalanceConfig(), enabled: false },
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      const result = await rebalanceAManUsde(ctx);

      expect(result).toEqual([]);
      expect(mockLogger.debug.calledWithMatch('aManUSDe rebalancing disabled')).toBe(true);
    });

    it('rebalanceAMansyrupUsdt delegates to rebalanceAaveToken with correct descriptor', async () => {
      // With no aMansyrupUsdtRebalance config, it should return empty
      const config = {
        ...baseConfig,
        aMansyrupUsdtRebalance: { ...createMockTokenRebalanceConfig(), enabled: false },
      } as MarkConfiguration;
      const ctx = { ...mockContext, config };

      const result = await rebalanceAMansyrupUsdt(ctx);

      expect(result).toEqual([]);
      expect(mockLogger.debug.calledWithMatch('aMansyrupUSDT rebalancing disabled')).toBe(true);
    });

    it('executeAManUsdeCallbacks delegates with correct bridge tag', async () => {
      await executeAManUsdeCallbacks(mockContext);

      expect(
        (mockDatabase.getRebalanceOperations as SinonStub).calledWithMatch(undefined, undefined, {
          bridge: 'stargate-amanusde',
        }),
      ).toBe(true);
    });

    it('executeAMansyrupUsdtCallbacks delegates with correct bridge tag', async () => {
      await executeAMansyrupUsdtCallbacks(mockContext);

      expect(
        (mockDatabase.getRebalanceOperations as SinonStub).calledWithMatch(undefined, undefined, {
          bridge: 'stargate-amansyrupusdt',
        }),
      ).toBe(true);
    });
  });
});
