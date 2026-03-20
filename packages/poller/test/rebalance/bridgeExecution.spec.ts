import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock database functions
jest.mock('@mark/database', () => ({
  createRebalanceOperation: jest.fn().mockResolvedValue({ id: 'mock-op-id' }),
  initializeDatabase: jest.fn(),
  getPool: jest.fn(),
}));

// Mock transaction helpers
jest.mock('../../src/helpers/transactions', () => ({
  submitTransactionWithLogging: jest.fn(() =>
    Promise.resolve({
      hash: '0xBridgeTxHash',
      receipt: {
        transactionHash: '0xBridgeTxHash',
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

import { submitBridgeTransactions, executeEvmBridge } from '../../src/rebalance/bridgeExecution';
import { submitTransactionWithLogging } from '../../src/helpers/transactions';
import * as database from '@mark/database';
import {
  SupportedBridge,
  RebalanceOperationStatus,
  WalletType,
  DBPS_MULTIPLIER,
} from '@mark/core';
import { RebalanceTransactionMemo } from '@mark/rebalance';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import { ProcessingContext } from '../../src/init';

// --- Helpers ---

function createMockLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createMockChainService(): ChainService {
  return {
    submitAndMonitor: jest.fn(),
    getBalance: jest.fn(),
  } as unknown as ChainService;
}

function createMockAdapter(overrides?: {
  getReceivedAmount?: jest.Mock;
  send?: jest.Mock;
}) {
  return {
    type: jest.fn().mockReturnValue(SupportedBridge.Stargate),
    getReceivedAmount: overrides?.getReceivedAmount ?? jest.fn().mockResolvedValue('9995'),
    send: overrides?.send ?? jest.fn().mockResolvedValue([
      {
        transaction: {
          to: '0xBridgeContract',
          data: '0xApprovalData',
          value: 0n,
          funcSig: 'approve(address,uint256)',
        },
        memo: RebalanceTransactionMemo.Approval,
      },
      {
        transaction: {
          to: '0xBridgeContract',
          data: '0xBridgeData',
          value: 0n,
          funcSig: 'bridge(uint256)',
        },
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount: '9950',
      },
    ]),
    destinationCallback: jest.fn(),
    readyOnDestination: jest.fn(),
    getMinimumAmount: jest.fn(),
  };
}

const MOCK_CONFIG = {
  ownAddress: '0xOwner',
} as ProcessingContext['config'];

// --- Tests ---

describe('submitBridgeTransactions', () => {
  const mockLogger = createMockLogger();
  const mockChainService = createMockChainService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('submits all transactions and captures receipt from Rebalance memo', async () => {
    const bridgeTxRequests = [
      {
        transaction: { to: '0xBridge', data: '0xApproval', value: 0n, funcSig: 'approve' },
        memo: RebalanceTransactionMemo.Approval,
      },
      {
        transaction: { to: '0xBridge', data: '0xBridge', value: 0n, funcSig: 'bridge' },
        memo: RebalanceTransactionMemo.Rebalance,
        effectiveAmount: '950',
      },
    ];

    const result = await submitBridgeTransactions({
      context: { logger: mockLogger, config: MOCK_CONFIG, requestId: 'test-1' },
      chainService: mockChainService,
      route: { origin: 1, destination: 5000, asset: '0xWETH' },
      bridgeType: SupportedBridge.Across,
      bridgeTxRequests: bridgeTxRequests as any,
      amountToBridge: 1000n,
    });

    expect(submitTransactionWithLogging).toHaveBeenCalledTimes(2);
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.transactionHash).toBe('0xBridgeTxHash');
    expect(result.effectiveBridgedAmount).toBe('950');
  });

  it('uses senderOverride address when provided', async () => {
    const bridgeTxRequests = [
      {
        transaction: { to: '0xBridge', data: '0xData', value: 0n, funcSig: '' },
        memo: RebalanceTransactionMemo.Rebalance,
      },
    ];

    await submitBridgeTransactions({
      context: { logger: mockLogger, config: MOCK_CONFIG, requestId: 'test-2' },
      chainService: mockChainService,
      route: { origin: 1, destination: 5000, asset: '0xWETH' },
      bridgeType: SupportedBridge.Across,
      bridgeTxRequests: bridgeTxRequests as any,
      amountToBridge: 1000n,
      senderOverride: { address: '0xFiller', label: 'fill-service' },
    });

    expect(submitTransactionWithLogging).toHaveBeenCalledWith(
      expect.objectContaining({
        txRequest: expect.objectContaining({ from: '0xFiller' }),
      }),
    );
  });

  it('defaults effectiveBridgedAmount to amountToBridge when no effectiveAmount', async () => {
    const bridgeTxRequests = [
      {
        transaction: { to: '0xBridge', data: '0xData', value: 0n, funcSig: '' },
        memo: RebalanceTransactionMemo.Rebalance,
        // no effectiveAmount
      },
    ];

    const result = await submitBridgeTransactions({
      context: { logger: mockLogger, config: MOCK_CONFIG, requestId: 'test-3' },
      chainService: mockChainService,
      route: { origin: 1, destination: 5000, asset: '0xWETH' },
      bridgeType: SupportedBridge.Across,
      bridgeTxRequests: bridgeTxRequests as any,
      amountToBridge: 2000n,
    });

    expect(result.effectiveBridgedAmount).toBe('2000');
  });

  it('passes zodiacConfig through to submitTransactionWithLogging', async () => {
    const bridgeTxRequests = [
      {
        transaction: { to: '0xBridge', data: '0xData', value: 0n, funcSig: '' },
        memo: RebalanceTransactionMemo.Rebalance,
      },
    ];
    const zodiacConfig = {
      walletType: WalletType.Zodiac,
      moduleAddress: '0xModule' as `0x${string}`,
      roleKey: '0xRole' as `0x${string}`,
      safeAddress: '0xSafe' as `0x${string}`,
    };

    await submitBridgeTransactions({
      context: { logger: mockLogger, config: MOCK_CONFIG, requestId: 'test-4' },
      chainService: mockChainService,
      route: { origin: 1, destination: 5000, asset: '0xWETH' },
      bridgeType: SupportedBridge.Across,
      bridgeTxRequests: bridgeTxRequests as any,
      amountToBridge: 1000n,
      zodiacConfig,
    });

    expect(submitTransactionWithLogging).toHaveBeenCalledWith(
      expect.objectContaining({ zodiacConfig }),
    );
  });
});

describe('executeEvmBridge', () => {
  let mockContext: ProcessingContext;
  const mockLogger = createMockLogger();
  const mockChainService = createMockChainService();

  beforeEach(() => {
    jest.clearAllMocks();
    mockContext = {
      logger: mockLogger,
      requestId: 'test-exec-1',
      config: MOCK_CONFIG,
      chainService: mockChainService,
    } as unknown as ProcessingContext;
  });

  it('completes 5-step bridge flow and returns action', async () => {
    const adapter = createMockAdapter();

    const result = await executeEvmBridge({
      context: mockContext,
      adapter: adapter as any,
      route: { origin: 1, destination: 5000, asset: '0xToken' },
      amount: 10000n,
      sender: '0xSender',
      recipient: '0xRecipient',
      slippageTolerance: 100n,
      slippageMultiplier: DBPS_MULTIPLIER,
      chainService: mockChainService,
      dbRecord: {
        earmarkId: null,
        tickerHash: '0xTickerHash',
        bridgeTag: 'stargate-test',
        status: RebalanceOperationStatus.PENDING,
      },
      label: 'test bridge',
    });

    expect(adapter.getReceivedAmount).toHaveBeenCalledWith('10000', expect.any(Object));
    expect(adapter.send).toHaveBeenCalledWith('0xSender', '0xRecipient', '10000', expect.any(Object));
    expect(submitTransactionWithLogging).toHaveBeenCalledTimes(2);
    expect(database.createRebalanceOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        earmarkId: null,
        tickerHash: '0xTickerHash',
        bridge: 'stargate-test',
        status: RebalanceOperationStatus.PENDING,
        recipient: '0xRecipient',
      }),
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].bridge).toBe(SupportedBridge.Stargate);
    expect(result.effectiveBridgedAmount).toBe('9950');
  });

  it('returns empty actions when quote fails', async () => {
    const adapter = createMockAdapter({
      getReceivedAmount: jest.fn().mockRejectedValue(new Error('Quote API error')),
    });

    const result = await executeEvmBridge({
      context: mockContext,
      adapter: adapter as any,
      route: { origin: 1, destination: 5000, asset: '0xToken' },
      amount: 10000n,
      sender: '0xSender',
      recipient: '0xRecipient',
      slippageTolerance: 100n,
      slippageMultiplier: DBPS_MULTIPLIER,
      chainService: mockChainService,
      dbRecord: {
        earmarkId: null,
        tickerHash: '0xTickerHash',
        bridgeTag: 'stargate-test',
        status: RebalanceOperationStatus.PENDING,
      },
      label: 'test bridge',
    });

    expect(result.actions).toHaveLength(0);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(database.createRebalanceOperation).not.toHaveBeenCalled();
  });

  it('returns empty actions when slippage is too high', async () => {
    // Quote returns 5000 for amount 10000 — 50% slippage exceeds 1% tolerance
    const adapter = createMockAdapter({
      getReceivedAmount: jest.fn().mockResolvedValue('5000'),
    });

    const result = await executeEvmBridge({
      context: mockContext,
      adapter: adapter as any,
      route: { origin: 1, destination: 5000, asset: '0xToken' },
      amount: 10000n,
      sender: '0xSender',
      recipient: '0xRecipient',
      slippageTolerance: 100n,     // 1% in DBPS
      slippageMultiplier: DBPS_MULTIPLIER,
      chainService: mockChainService,
      dbRecord: {
        earmarkId: null,
        tickerHash: '0xTickerHash',
        bridgeTag: 'stargate-test',
        status: RebalanceOperationStatus.PENDING,
      },
      label: 'test bridge',
    });

    expect(result.actions).toHaveLength(0);
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('returns empty actions when send returns empty array', async () => {
    const adapter = createMockAdapter({
      send: jest.fn().mockResolvedValue([]),
    });

    const result = await executeEvmBridge({
      context: mockContext,
      adapter: adapter as any,
      route: { origin: 1, destination: 5000, asset: '0xToken' },
      amount: 10000n,
      sender: '0xSender',
      recipient: '0xRecipient',
      slippageTolerance: 100n,
      slippageMultiplier: DBPS_MULTIPLIER,
      chainService: mockChainService,
      dbRecord: {
        earmarkId: null,
        tickerHash: '0xTickerHash',
        bridgeTag: 'stargate-test',
        status: RebalanceOperationStatus.PENDING,
      },
      label: 'test bridge',
    });

    expect(result.actions).toHaveLength(0);
    expect(database.createRebalanceOperation).not.toHaveBeenCalled();
  });

  it('uses dbRecipient override for DB record and action', async () => {
    const adapter = createMockAdapter();

    const result = await executeEvmBridge({
      context: mockContext,
      adapter: adapter as any,
      route: { origin: 1, destination: 5000, asset: '0xToken' },
      amount: 10000n,
      sender: '0xSender',
      recipient: '0xTonRecipient',
      dbRecipient: '0xTacRecipient',
      slippageTolerance: 100n,
      slippageMultiplier: DBPS_MULTIPLIER,
      chainService: mockChainService,
      dbRecord: {
        earmarkId: 'earmark-1',
        tickerHash: '0xTickerHash',
        bridgeTag: 'stargate-tac',
        status: RebalanceOperationStatus.PENDING,
      },
      label: 'test TAC bridge',
    });

    // adapter.send should use tonRecipient (the `recipient` param)
    expect(adapter.send).toHaveBeenCalledWith('0xSender', '0xTonRecipient', '10000', expect.any(Object));
    // DB record should use tacRecipient (the `dbRecipient` param)
    expect(database.createRebalanceOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: '0xTacRecipient',
        earmarkId: 'earmark-1',
      }),
    );
    // Action should also use tacRecipient
    expect(result.actions[0].recipient).toBe('0xTacRecipient');
  });

  it('uses dbAmount for DB record and action tracking when adapter uses native units', async () => {
    const adapter = createMockAdapter({
      getReceivedAmount: jest.fn().mockResolvedValue('9995000'),  // within slippage for 10000000
    });

    const result = await executeEvmBridge({
      context: mockContext,
      adapter: adapter as any,
      route: { origin: 1, destination: 5000, asset: '0xToken' },
      amount: 10000000n,                   // 10 USDT in 6 decimals (native units for adapter)
      dbAmount: 10000000000000000000n,      // 10 USDT in 18 decimals (for DB/tracking)
      sender: '0xSender',
      recipient: '0xRecipient',
      slippageTolerance: 100n,
      slippageMultiplier: DBPS_MULTIPLIER,
      chainService: mockChainService,
      dbRecord: {
        earmarkId: null,
        tickerHash: '0xTickerHash',
        bridgeTag: 'stargate-tac',
        status: RebalanceOperationStatus.PENDING,
      },
      label: 'test bridge',
    });

    // adapter.send should use the native-unit amount
    expect(adapter.send).toHaveBeenCalledWith('0xSender', '0xRecipient', '10000000', expect.any(Object));
    // action amount should use dbAmount (18 decimals) for tracking
    expect(result.actions[0].amount).toBe('10000000000000000000');
    // effectiveBridgedAmount default should use dbAmount (18 decimals)
    // (the mock adapter returns effectiveAmount '9950' which overrides, so check via the mock)
    expect(result.effectiveBridgedAmount).toBe('9950');
  });

  it('throws on tx submission failure (caller catches)', async () => {
    const adapter = createMockAdapter();
    (submitTransactionWithLogging as jest.Mock).mockRejectedValueOnce(new Error('tx failed'));

    await expect(
      executeEvmBridge({
        context: mockContext,
        adapter: adapter as any,
        route: { origin: 1, destination: 5000, asset: '0xToken' },
        amount: 10000n,
        sender: '0xSender',
        recipient: '0xRecipient',
        slippageTolerance: 100n,
        slippageMultiplier: DBPS_MULTIPLIER,
        chainService: mockChainService,
        dbRecord: {
          earmarkId: null,
          tickerHash: '0xTickerHash',
          bridgeTag: 'stargate-test',
          status: RebalanceOperationStatus.PENDING,
        },
        label: 'test bridge',
      }),
    ).rejects.toThrow('tx failed');
  });
});
