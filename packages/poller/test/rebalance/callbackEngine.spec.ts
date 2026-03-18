import { describe, it, expect, beforeEach } from '@jest/globals';
import { runCallbackLoop, CallbackDescriptor, RebalanceOperation } from '../../src/rebalance/callbackEngine';
import { ProcessingContext } from '../../src/init';
import { Logger } from '@mark/logger';
import { RebalanceOperationStatus } from '@mark/core';

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

function createMockOperation(overrides?: Partial<RebalanceOperation>): RebalanceOperation {
  return {
    id: 'op-1',
    earmarkId: null,
    originChainId: 1,
    destinationChainId: 5000,
    tickerHash: '0xabc',
    amount: '1000000',
    slippage: 100,
    status: RebalanceOperationStatus.PENDING,
    bridge: 'stargate-test',
    createdAt: new Date(), // fresh — not timed out
    updatedAt: new Date(),
    recipient: '0xRecipient',
    transactions: {},
    ...overrides,
  } as unknown as RebalanceOperation;
}

function createMockContext(
  logger: Logger,
  operations: RebalanceOperation[] = [],
): ProcessingContext {
  return {
    logger,
    requestId: 'test-request-id',
    config: {} as ProcessingContext['config'],
    database: {
      getRebalanceOperations: jest.fn().mockResolvedValue({ operations }),
      updateRebalanceOperation: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as ProcessingContext;
}

// --- Tests ---

describe('runCallbackLoop', () => {
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createMockLogger();
  });

  it('processes no operations when none found', async () => {
    const context = createMockContext(logger, []);
    const processOperation = jest.fn();
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      processOperation,
    };

    await runCallbackLoop(context, descriptor);

    expect(processOperation).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Executing callbacks for TestBridge'),
      expect.any(Object),
    );
  });

  it('delegates each operation to processOperation', async () => {
    const op1 = createMockOperation({ id: 'op-1' });
    const op2 = createMockOperation({ id: 'op-2' });
    const context = createMockContext(logger, [op1, op2]);
    const processOperation = jest.fn();
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      processOperation,
    };

    await runCallbackLoop(context, descriptor);

    expect(processOperation).toHaveBeenCalledTimes(2);
    expect(processOperation).toHaveBeenCalledWith(op1, context);
    expect(processOperation).toHaveBeenCalledWith(op2, context);
  });

  it('marks timed-out operations and skips processing', async () => {
    const timedOutOp = createMockOperation({
      id: 'op-timeout',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
    });
    const context = createMockContext(logger, [timedOutOp]);
    const processOperation = jest.fn();
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      processOperation,
    };

    await runCallbackLoop(context, descriptor);

    expect(processOperation).not.toHaveBeenCalled();
    expect(context.database.updateRebalanceOperation).toHaveBeenCalledWith(
      'op-timeout',
      { status: RebalanceOperationStatus.CANCELLED },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      expect.objectContaining({ operationId: 'op-timeout' }),
    );
  });

  it('uses custom timeout status when provided', async () => {
    const timedOutOp = createMockOperation({
      id: 'op-timeout',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const context = createMockContext(logger, [timedOutOp]);
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      timeoutStatus: RebalanceOperationStatus.FAILED,
      processOperation: jest.fn(),
    };

    await runCallbackLoop(context, descriptor);

    expect(context.database.updateRebalanceOperation).toHaveBeenCalledWith(
      'op-timeout',
      { status: RebalanceOperationStatus.FAILED },
    );
  });

  it('calls onTimeout callback after updating status', async () => {
    const timedOutOp = createMockOperation({
      id: 'op-timeout',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const context = createMockContext(logger, [timedOutOp]);
    const onTimeout = jest.fn();
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      onTimeout,
      processOperation: jest.fn(),
    };

    await runCallbackLoop(context, descriptor);

    expect(onTimeout).toHaveBeenCalledWith(timedOutOp, context);
  });

  it('catches errors from processOperation without affecting other operations', async () => {
    const op1 = createMockOperation({ id: 'op-1' });
    const op2 = createMockOperation({ id: 'op-2' });
    const context = createMockContext(logger, [op1, op2]);
    const processOperation = jest.fn()
      .mockRejectedValueOnce(new Error('process failed'))
      .mockResolvedValueOnce(undefined);
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      processOperation,
    };

    await runCallbackLoop(context, descriptor);

    // Both operations were attempted
    expect(processOperation).toHaveBeenCalledTimes(2);
    // Error was logged for op1
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process TestBridge callback'),
      expect.objectContaining({ operationId: 'op-1', error: expect.any(Object) }),
    );
  });

  it('catches errors from timeout handling', async () => {
    const timedOutOp = createMockOperation({
      id: 'op-timeout',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const context = createMockContext(logger, [timedOutOp]);
    (context.database.updateRebalanceOperation as jest.Mock).mockRejectedValueOnce(new Error('db error'));
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      processOperation: jest.fn(),
    };

    await runCallbackLoop(context, descriptor);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to handle timed-out'),
      expect.objectContaining({ operationId: 'op-timeout', error: expect.any(Object) }),
    );
  });

  it('uses custom TTL from descriptor', async () => {
    // Op is 2 hours old. Default TTL is 24h so it would NOT timeout.
    // But custom TTL of 60 min means it SHOULD timeout.
    const op = createMockOperation({
      id: 'op-custom-ttl',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    });
    const context = createMockContext(logger, [op]);
    const processOperation = jest.fn();
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      ttlMinutes: 60,
      processOperation,
    };

    await runCallbackLoop(context, descriptor);

    expect(processOperation).not.toHaveBeenCalled();
    expect(context.database.updateRebalanceOperation).toHaveBeenCalledWith(
      'op-custom-ttl',
      { status: RebalanceOperationStatus.CANCELLED },
    );
  });

  it('does not timeout operation without createdAt', async () => {
    const op = createMockOperation({
      id: 'op-no-date',
      createdAt: undefined as unknown as Date,
    });
    const context = createMockContext(logger, [op]);
    const processOperation = jest.fn();
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: 'stargate-test',
      statuses: [RebalanceOperationStatus.PENDING],
      processOperation,
    };

    await runCallbackLoop(context, descriptor);

    expect(processOperation).toHaveBeenCalledWith(op, context);
    expect(context.database.updateRebalanceOperation).not.toHaveBeenCalled();
  });

  it('passes bridge filter and statuses to database query', async () => {
    const context = createMockContext(logger, []);
    const descriptor: CallbackDescriptor = {
      name: 'TestBridge',
      bridge: ['stargate-test', 'across-test'],
      statuses: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
      chainId: 5000,
      processOperation: jest.fn(),
    };

    await runCallbackLoop(context, descriptor);

    expect(context.database.getRebalanceOperations).toHaveBeenCalledWith(
      undefined,
      undefined,
      {
        status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
        bridge: ['stargate-test', 'across-test'],
        chainId: 5000,
      },
    );
  });
});
