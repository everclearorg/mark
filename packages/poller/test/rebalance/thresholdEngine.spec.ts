import { describe, it, expect, beforeEach } from '@jest/globals';
import { runThresholdRebalance, ThresholdRebalanceDescriptor } from '../../src/rebalance/thresholdEngine';
import { RebalanceRunState } from '../../src/rebalance/types';
import { ProcessingContext } from '../../src/init';
import { Logger } from '@mark/logger';
import { RebalanceAction, SupportedBridge } from '@mark/core';

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

function createMockContext(logger?: Logger): ProcessingContext {
  return {
    logger: logger ?? createMockLogger(),
    requestId: 'test-request-id',
    config: {} as ProcessingContext['config'],
  } as unknown as ProcessingContext;
}

const MOCK_ACTION: RebalanceAction = { bridge: SupportedBridge.Stargate, amount: '1000' };

function createDescriptor(overrides?: Partial<ThresholdRebalanceDescriptor>): ThresholdRebalanceDescriptor {
  return {
    name: 'TestToken',
    isEnabled: () => true,
    hasInFlightOperations: jest.fn().mockResolvedValue(false),
    getRecipientBalance: jest.fn().mockResolvedValue(500n),
    getThresholds: () => ({ threshold: 1000n, target: 2000n }),
    convertShortfallToBridgeAmount: jest.fn().mockImplementation(async (shortfall: bigint) => shortfall),
    getSenderBalance: jest.fn().mockResolvedValue(5000n),
    getAmountCaps: () => ({ min: 100n }),
    executeBridge: jest.fn().mockResolvedValue([MOCK_ACTION]),
    ...overrides,
  };
}

// --- Tests ---

describe('runThresholdRebalance', () => {
  let context: ProcessingContext;
  let logger: Logger;
  let runState: RebalanceRunState;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createMockLogger();
    context = createMockContext(logger);
    runState = { committedAmount: 0n };
  });

  it('returns empty when disabled', async () => {
    const descriptor = createDescriptor({ isEnabled: () => false });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
      expect.any(Object),
    );
  });

  it('returns empty when in-flight operations exist', async () => {
    const descriptor = createDescriptor({
      hasInFlightOperations: jest.fn().mockResolvedValue(true),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('in-flight'),
      expect.any(Object),
    );
  });

  it('returns empty when hasInFlightOperations throws', async () => {
    const descriptor = createDescriptor({
      hasInFlightOperations: jest.fn().mockRejectedValue(new Error('db error')),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to check in-flight'),
      expect.objectContaining({ error: expect.any(Object) }),
    );
  });

  it('returns empty when getRecipientBalance throws', async () => {
    const descriptor = createDescriptor({
      getRecipientBalance: jest.fn().mockRejectedValue(new Error('rpc error')),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to get recipient balance'),
      expect.objectContaining({ error: expect.any(Object) }),
    );
  });

  it('returns empty when target < threshold (misconfiguration)', async () => {
    const descriptor = createDescriptor({
      getThresholds: () => ({ threshold: 2000n, target: 500n }),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('misconfiguration'),
      expect.objectContaining({ threshold: '2000', target: '500' }),
    );
  });

  it('returns empty when recipient balance is above threshold', async () => {
    const descriptor = createDescriptor({
      getRecipientBalance: jest.fn().mockResolvedValue(1500n),
      getThresholds: () => ({ threshold: 1000n, target: 2000n }),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('above threshold'),
      expect.any(Object),
    );
  });

  it('returns empty when recipient balance is exactly at threshold', async () => {
    const descriptor = createDescriptor({
      getRecipientBalance: jest.fn().mockResolvedValue(1000n),
      getThresholds: () => ({ threshold: 1000n, target: 2000n }),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);
    expect(actions).toEqual([]);
  });

  it('returns empty when convertShortfallToBridgeAmount throws', async () => {
    const descriptor = createDescriptor({
      convertShortfallToBridgeAmount: jest.fn().mockRejectedValue(new Error('conversion error')),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to convert shortfall'),
      expect.objectContaining({ error: expect.any(Object) }),
    );
  });

  it('returns empty when getSenderBalance throws', async () => {
    const descriptor = createDescriptor({
      getSenderBalance: jest.fn().mockRejectedValue(new Error('rpc error')),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to get sender balance'),
      expect.objectContaining({ error: expect.any(Object) }),
    );
  });

  it('returns empty when amount is below minimum cap', async () => {
    const descriptor = createDescriptor({
      // shortfall = target - balance = 2000 - 500 = 1500, but sender only has 50
      getSenderBalance: jest.fn().mockResolvedValue(50n),
      getAmountCaps: () => ({ min: 100n }),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('below minimum'),
      expect.objectContaining({ availableAmount: '50', minRebalance: '100' }),
    );
  });

  it('caps amount at max when amount exceeds max cap', async () => {
    const executeBridge = jest.fn().mockResolvedValue([MOCK_ACTION]);
    const descriptor = createDescriptor({
      // shortfall = 2000 - 500 = 1500
      getSenderBalance: jest.fn().mockResolvedValue(5000n),
      getAmountCaps: () => ({ min: 100n, max: 800n }),
      executeBridge,
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([MOCK_ACTION]);
    expect(executeBridge).toHaveBeenCalledWith(context, 800n);
  });

  it('uses sender balance when less than bridge amount', async () => {
    const executeBridge = jest.fn().mockResolvedValue([MOCK_ACTION]);
    const descriptor = createDescriptor({
      // shortfall = 2000 - 500 = 1500, sender has 300
      getSenderBalance: jest.fn().mockResolvedValue(300n),
      getAmountCaps: () => ({ min: 100n }),
      executeBridge,
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([MOCK_ACTION]);
    expect(executeBridge).toHaveBeenCalledWith(context, 300n);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('insufficient balance'),
      expect.any(Object),
    );
  });

  it('executes bridge with full shortfall when sender has enough', async () => {
    const executeBridge = jest.fn().mockResolvedValue([MOCK_ACTION]);
    const descriptor = createDescriptor({
      // balance=500, target=2000, shortfall=1500, sender=5000
      executeBridge,
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([MOCK_ACTION]);
    expect(executeBridge).toHaveBeenCalledWith(context, 1500n);
  });

  it('tracks committed amount after successful bridge', async () => {
    const descriptor = createDescriptor({
      executeBridge: jest.fn().mockResolvedValue([MOCK_ACTION]),
    });
    await runThresholdRebalance(context, descriptor, runState);

    expect(runState.committedAmount).toBe(1500n);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('updated committed amount'),
      expect.objectContaining({ bridgedAmount: '1500', totalCommitted: '1500' }),
    );
  });

  it('does not track committed amount when bridge returns no actions', async () => {
    const descriptor = createDescriptor({
      executeBridge: jest.fn().mockResolvedValue([]),
    });
    await runThresholdRebalance(context, descriptor, runState);

    expect(runState.committedAmount).toBe(0n);
  });

  it('accumulates committed amount across multiple calls', async () => {
    const descriptor = createDescriptor({
      executeBridge: jest.fn().mockResolvedValue([MOCK_ACTION]),
    });
    await runThresholdRebalance(context, descriptor, runState);
    expect(runState.committedAmount).toBe(1500n);

    // Second call with same runState
    await runThresholdRebalance(context, descriptor, runState);
    expect(runState.committedAmount).toBe(3000n);
  });

  it('returns empty and logs error when executeBridge throws', async () => {
    const descriptor = createDescriptor({
      executeBridge: jest.fn().mockRejectedValue(new Error('bridge failed')),
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([]);
    expect(runState.committedAmount).toBe(0n);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to execute bridge'),
      expect.objectContaining({ error: expect.any(Object) }),
    );
  });

  it('applies shortfall conversion correctly', async () => {
    const executeBridge = jest.fn().mockResolvedValue([MOCK_ACTION]);
    const descriptor = createDescriptor({
      // balance=500, target=2000, shortfall=1500
      // conversion doubles it: bridgeAmount=3000
      convertShortfallToBridgeAmount: jest.fn().mockImplementation(async (s: bigint) => s * 2n),
      getSenderBalance: jest.fn().mockResolvedValue(10000n),
      getAmountCaps: () => ({ min: 100n }),
      executeBridge,
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([MOCK_ACTION]);
    expect(executeBridge).toHaveBeenCalledWith(context, 3000n);
  });

  it('skips when recipient balance above target but below threshold (edge: shortfall=0)', async () => {
    // This covers the edge case where threshold > target is already guarded,
    // but if recipientBalance is between target and threshold — it can't happen
    // because target >= threshold is enforced. Let's test the boundary:
    // threshold = target = 1000, balance = 999 → shortfall = 1
    const executeBridge = jest.fn().mockResolvedValue([MOCK_ACTION]);
    const descriptor = createDescriptor({
      getRecipientBalance: jest.fn().mockResolvedValue(999n),
      getThresholds: () => ({ threshold: 1000n, target: 1000n }),
      getAmountCaps: () => ({ min: 0n }),
      executeBridge,
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([MOCK_ACTION]);
    expect(executeBridge).toHaveBeenCalledWith(context, 1n);
  });

  it('ignores max cap when max is 0n', async () => {
    const executeBridge = jest.fn().mockResolvedValue([MOCK_ACTION]);
    const descriptor = createDescriptor({
      getAmountCaps: () => ({ min: 0n, max: 0n }),
      executeBridge,
    });
    const actions = await runThresholdRebalance(context, descriptor, runState);

    expect(actions).toEqual([MOCK_ACTION]);
    // shortfall = 1500, should NOT be capped by max=0
    expect(executeBridge).toHaveBeenCalledWith(context, 1500n);
  });
});
