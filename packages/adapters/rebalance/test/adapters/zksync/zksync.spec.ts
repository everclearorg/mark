import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@mark/logger';
import { SupportedBridge } from '@mark/core';
import { RebalanceTransactionMemo } from '../../../src/types';
import { ZKSyncNativeBridgeAdapter } from '../../../src/adapters/zksync/zksync';
import {
  BASE_COST_BUFFER_PERCENT,
  ETH_TOKEN_L2,
  L1_MESSAGE_SENT_TOPIC,
  L1_MESSENGER,
  ZKSYNC_DIAMOND_PROXY,
  ZKSYNC_L1_BRIDGE,
  ZKSYNC_L2_BRIDGE,
} from '../../../src/adapters/zksync/constants';

const mockLogger = {
  debug: jest.fn<any>(),
  info: jest.fn<any>(),
  warn: jest.fn<any>(),
  error: jest.fn<any>(),
} as unknown as Logger;

const mockChains = {
  '1': {
    providers: ['https://mock-l1'],
    assets: [],
    invoiceAge: 0,
    gasThreshold: '0',
    deployments: {
      everclear: '0x0000000000000000000000000000000000000001',
      permit2: '0x0000000000000000000000000000000000000002',
      multicall3: '0x0000000000000000000000000000000000000003',
    },
  },
  '324': {
    providers: ['https://mock-l2'],
    assets: [],
    invoiceAge: 0,
    gasThreshold: '0',
    deployments: {
      everclear: '0x0000000000000000000000000000000000000001',
      permit2: '0x0000000000000000000000000000000000000002',
      multicall3: '0x0000000000000000000000000000000000000003',
    },
  },
};

const sender = '0x' + '1'.repeat(40);
const recipient = '0x' + '2'.repeat(40);
const amount = '1000000000000000000';
const ethAsset = '0x0000000000000000000000000000000000000000';

const mockReceipt = {
  blockHash: '0xblock',
  blockNumber: 1n,
  contractAddress: null,
  cumulativeGasUsed: 0n,
  effectiveGasPrice: 0n,
  from: sender,
  gasUsed: 0n,
  logs: [],
  logsBloom: '0x' + '0'.repeat(512),
  status: 'success',
  to: recipient,
  transactionHash: '0xhash',
  transactionIndex: 0,
  type: 'eip1559',
} as any;

const mockBaseCost = 50000000000000n;
const bufferedBaseCost = mockBaseCost + (mockBaseCost * BASE_COST_BUFFER_PERCENT) / 100n;

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return Object.assign({}, actual, {
    createPublicClient: () => ({
      readContract: jest.fn<any>().mockResolvedValue(mockBaseCost),
      getGasPrice: jest.fn<any>().mockResolvedValue(20000000000n),
      request: jest.fn<any>().mockResolvedValue({}),
    }),
    encodeFunctionData: jest.fn(() => '0x' + '0'.repeat(20)),
    pad: jest.fn((value: string) => `0x${'0'.repeat(24)}${value.slice(2).toLowerCase()}`),
  });
});

describe('ZKSyncNativeBridgeAdapter', () => {
  let adapter: ZKSyncNativeBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new ZKSyncNativeBridgeAdapter(mockChains, mockLogger);
  });

  it('returns correct adapter type', () => {
    expect(adapter.type()).toBe(SupportedBridge.Zksync);
  });

  it('builds L1->L2 ETH tx with base-cost buffer', async () => {
    const txs = await adapter.send(sender, recipient, amount, { asset: ethAsset, origin: 1, destination: 324 });
    expect(txs).toHaveLength(1);
    expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
    expect(txs[0].transaction.to).toBe(ZKSYNC_DIAMOND_PROXY);
    expect(txs[0].transaction.value).toBe(BigInt(amount) + bufferedBaseCost);
  });

  it('builds L2->L1 ETH withdraw on ETH token contract', async () => {
    const txs = await adapter.send(sender, recipient, amount, { asset: ethAsset, origin: 324, destination: 1 });
    expect(txs).toHaveLength(1);
    expect(txs[0].transaction.to).toBe(ETH_TOKEN_L2);
  });

  it('rejects unsupported routes in send', async () => {
    await expect(adapter.send(sender, recipient, amount, { asset: ethAsset, origin: 10, destination: 324 })).rejects.toThrow(
      'Unsupported zkSync route',
    );
  });

  it('returns true for readyOnDestination on L1->L2', async () => {
    const ready = await adapter.readyOnDestination(amount, { asset: ethAsset, origin: 1, destination: 324 }, mockReceipt);
    expect(ready).toBe(true);
  });

  it('returns false when L2 receipt has no batch number yet', async () => {
    jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({});
    const ready = await adapter.readyOnDestination(amount, { asset: ethAsset, origin: 324, destination: 1 }, mockReceipt);
    expect(ready).toBe(false);
  });

  it('treats batch number 0 as valid and compares against executed batches', async () => {
    jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({ l1BatchNumber: 0 });
    jest.spyOn(adapter as any, 'getClient').mockImplementation(async (chainId) => {
      if (chainId === 1) {
        return {
          readContract: jest.fn<any>().mockResolvedValue(0n),
        };
      }

      return { request: jest.fn<any>() };
    });

    const ready = await adapter.readyOnDestination(amount, { asset: ethAsset, origin: 324, destination: 1 }, mockReceipt);
    expect(ready).toBe(true);
  });

  it('builds L2->L1 callback when l1BatchTxIndex is zero', async () => {
    jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({
      l1BatchNumber: 1,
      l1BatchTxIndex: 0,
      l2ToL1Logs: [{ sender: L1_MESSENGER, key: `0x${ETH_TOKEN_L2.slice(2).padStart(64, '0')}` }],
      logs: [
        {
          address: L1_MESSENGER,
          topics: [L1_MESSAGE_SENT_TOPIC, `0x${ETH_TOKEN_L2.slice(2).padStart(64, '0')}`],
          data: `0x${'0'.repeat(64)}${'0'.repeat(63)}4${'ab'.repeat(4)}`,
        },
      ],
    });
    jest.spyOn(adapter as any, 'getL2ToL1LogProof').mockResolvedValue({ proof: ['0xproof'], id: 0 });
    jest.spyOn(adapter as any, 'getClient').mockImplementation(async (chainId) => {
      if (chainId === 1) {
        return {
          readContract: jest.fn<any>().mockResolvedValue(false),
        };
      }

      return { request: jest.fn<any>() };
    });

    const callback = await adapter.destinationCallback(
      { asset: ethAsset, origin: 324, destination: 1 },
      { ...mockReceipt, transactionHash: '0xabc' },
    );

    expect(callback).toBeDefined();
    expect(callback?.memo).toBe(RebalanceTransactionMemo.Rebalance);
    expect(callback?.transaction.to).toBe(ZKSYNC_DIAMOND_PROXY);
  });

  it('builds ERC20 callback on the L1 bridge', async () => {
    const erc20Asset = '0x' + 'a'.repeat(40);
    jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({
      l1BatchNumber: 2,
      l1BatchTxIndex: 1,
      l2ToL1Logs: [{ sender: L1_MESSENGER, key: `0x${ZKSYNC_L2_BRIDGE.slice(2).padStart(64, '0')}` }],
      logs: [
        {
          address: L1_MESSENGER,
          topics: [L1_MESSAGE_SENT_TOPIC, `0x${ZKSYNC_L2_BRIDGE.slice(2).padStart(64, '0')}`],
          data: `0x${'0'.repeat(64)}${'0'.repeat(63)}4${'cd'.repeat(4)}`,
        },
      ],
    });
    jest.spyOn(adapter as any, 'getL2ToL1LogProof').mockResolvedValue({ proof: ['0xproof'], id: 1 });
    jest.spyOn(adapter as any, 'getClient').mockImplementation(async (chainId) => {
      if (chainId === 1) {
        return {
          readContract: jest.fn<any>().mockResolvedValue(false),
        };
      }

      return { request: jest.fn<any>() };
    });

    const callback = await adapter.destinationCallback({ asset: erc20Asset, origin: 324, destination: 1 }, mockReceipt);
    expect(callback?.transaction.to).toBe(ZKSYNC_L1_BRIDGE);
  });

  it('rejects unsupported routes in destinationCallback', async () => {
    await expect(adapter.destinationCallback({ asset: ethAsset, origin: 10, destination: 324 }, mockReceipt)).rejects.toThrow(
      'Unsupported zkSync route',
    );
  });
});
