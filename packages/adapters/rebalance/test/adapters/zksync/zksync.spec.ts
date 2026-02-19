import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ZKSyncNativeBridgeAdapter } from '../../../src/adapters/zksync/zksync';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../../src/types';
import { SupportedBridge } from '@mark/core';
import {
  ZKSYNC_DIAMOND_PROXY,
  ZKSYNC_L1_BRIDGE,
  ZKSYNC_L2_BRIDGE,
  ETH_TOKEN_L2,
  L1_MESSENGER,
  L1_MESSAGE_SENT_TOPIC,
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
const amount = '1000000000000000000'; // 1 ETH
const ethAsset = '0x0000000000000000000000000000000000000000';
const erc20Asset = '0x' + 'a'.repeat(40);

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

const mockBaseCost = BigInt(50000000000000); // 0.00005 ETH
const mockBaseCostWithBuffer = mockBaseCost + (mockBaseCost * BigInt(20)) / BigInt(100); // +20% buffer

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return Object.assign({}, actual, {
    createPublicClient: () => ({
      readContract: jest.fn<any>().mockResolvedValue(BigInt(50000000000000)), // baseCost
      getGasPrice: jest.fn<any>().mockResolvedValue(BigInt(20000000000)), // 20 gwei
      request: jest.fn<any>().mockResolvedValue({
        l1BatchNumber: 100,
        ethExecuteTxHash: '0xexecuted',
      }),
    }),
    encodeFunctionData: jest.fn(() => '0x' + '0'.repeat(20)),
  });
});

describe('ZKSyncNativeBridgeAdapter', () => {
  let adapter: ZKSyncNativeBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new ZKSyncNativeBridgeAdapter(mockChains, mockLogger);
  });

  describe('type()', () => {
    it('returns correct type', () => {
      expect(adapter.type()).toBe(SupportedBridge.Zksync);
    });
  });

  describe('getReceivedAmount()', () => {
    it('returns input amount (no fees)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 324 };
      expect(await adapter.getReceivedAmount('123456', route)).toBe('123456');
    });
  });

  describe('getMinimumAmount()', () => {
    it('returns null', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 324 };
      expect(await adapter.getMinimumAmount(route)).toBeNull();
    });
  });

  describe('send()', () => {
    it('returns requestL2Transaction tx on Diamond Proxy for L1->L2 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 324 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe(ZKSYNC_DIAMOND_PROXY);
      // msg.value = deposit amount + L2 baseCost (with 20% buffer)
      expect(txs[0].transaction.value).toBe(BigInt(amount) + mockBaseCostWithBuffer);
    });

    it('returns approval + deposit txs on L1 Bridge for L1->L2 ERC20 transfer', async () => {
      const route = { asset: erc20Asset, origin: 1, destination: 324 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        getGasPrice: jest.fn<any>().mockResolvedValue(BigInt(20000000000)),
        readContract: jest.fn<any>()
          .mockResolvedValueOnce(mockBaseCost) // l2TransactionBaseCost
          .mockResolvedValueOnce(BigInt(0)),   // allowance = 0
      });

      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(2);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[1].transaction.to).toBe(ZKSYNC_L1_BRIDGE);
      expect(txs[1].transaction.value).toBe(mockBaseCostWithBuffer);
    });

    it('returns withdraw tx on ETH_TOKEN_L2 for L2->L1 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe(ETH_TOKEN_L2);
      expect(txs[0].transaction.value).toBe(BigInt(amount));
    });

    it('returns withdraw tx on L2 Bridge for L2->L1 ERC20 transfer', async () => {
      const route = { asset: erc20Asset, origin: 324, destination: 1 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe(ZKSYNC_L2_BRIDGE);
      expect(txs[0].transaction.value).toBe(BigInt(0));
    });
  });

  describe('readyOnDestination()', () => {
    it('returns true for L1->L2 (auto-relayed)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 324 };
      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns true when batch is executed for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({
        l1BatchNumber: '0x64', // 100
      });
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(200)), // totalBatchesExecuted
      });

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false if batch not yet executed for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({
        l1BatchNumber: '0x64', // 100
      });
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(50)), // totalBatchesExecuted < 100
      });

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(false);
    });

    it('returns false if batch number not yet available for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({
        l1BatchNumber: null,
      });
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>(),
      });

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(false);
    });
  });

  describe('destinationCallback()', () => {
    it('returns undefined for L1->L2 (no callback needed)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 324 };
      const tx = await adapter.destinationCallback(route, mockReceipt);
      expect(tx).toBeUndefined();
    });

    it('returns ETH finalization tx via Diamond Proxy for L2->L1 ETH withdrawal', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      const mockRawReceipt = {
        l1BatchNumber: '0x64',
        l1BatchTxIndex: '0x05',
        l2ToL1Logs: [
          {
            sender: L1_MESSENGER.toLowerCase(),
            key: '0x000000000000000000000000' + ETH_TOKEN_L2.slice(2).toLowerCase(),
          },
        ],
        logs: [
          {
            address: L1_MESSENGER,
            topics: [
              L1_MESSAGE_SENT_TOPIC,
              '0x000000000000000000000000' + ETH_TOKEN_L2.slice(2).toLowerCase(),
            ],
            data: '0x' + '0'.repeat(64) + '0'.repeat(62) + '20' + '0'.repeat(60) + 'aabb',
          },
        ],
      };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue(mockRawReceipt);
      jest.spyOn(adapter as any, 'getL2ToL1LogProof').mockResolvedValue({
        proof: ['0xproof1' as `0x${string}`],
        id: 0,
      });
      jest.spyOn(adapter as any, 'extractL1Message').mockReturnValue('0xmessage' as `0x${string}`);
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(false), // isEthWithdrawalFinalized = false
      });

      const tx = await adapter.destinationCallback(route, mockReceipt);

      expect(tx).toBeDefined();
      expect(tx?.memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(tx?.transaction.to).toBe(ZKSYNC_DIAMOND_PROXY);
    });

    it('returns ERC20 finalization tx via L1 Bridge for L2->L1 ERC20 withdrawal', async () => {
      const route = { asset: erc20Asset, origin: 324, destination: 1 };

      const mockRawReceipt = {
        l1BatchNumber: '0x64',
        l1BatchTxIndex: '0x05',
        l2ToL1Logs: [
          {
            sender: L1_MESSENGER.toLowerCase(),
            key: '0x000000000000000000000000' + ZKSYNC_L2_BRIDGE.slice(2).toLowerCase(),
          },
        ],
        logs: [],
      };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue(mockRawReceipt);
      jest.spyOn(adapter as any, 'getL2ToL1LogProof').mockResolvedValue({
        proof: ['0xproof1' as `0x${string}`],
        id: 0,
      });
      jest.spyOn(adapter as any, 'extractL1Message').mockReturnValue('0xmessage' as `0x${string}`);
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(false), // isWithdrawalFinalized = false
      });

      const tx = await adapter.destinationCallback(route, mockReceipt);

      expect(tx).toBeDefined();
      expect(tx?.memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(tx?.transaction.to).toBe(ZKSYNC_L1_BRIDGE);
    });

    it('returns undefined if ETH withdrawal already finalized', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      const mockRawReceipt = {
        l1BatchNumber: '0x64',
        l1BatchTxIndex: '0x05',
        l2ToL1Logs: [
          {
            sender: L1_MESSENGER.toLowerCase(),
            key: '0x000000000000000000000000' + ETH_TOKEN_L2.slice(2).toLowerCase(),
          },
        ],
        logs: [],
      };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue(mockRawReceipt);
      jest.spyOn(adapter as any, 'getL2ToL1LogProof').mockResolvedValue({
        proof: ['0xproof1' as `0x${string}`],
        id: 0,
      });
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(true), // isEthWithdrawalFinalized = true
      });

      const tx = await adapter.destinationCallback(route, mockReceipt);
      expect(tx).toBeUndefined();
    });

    it('throws if batch number not available', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue({
        l1BatchNumber: null,
        l1BatchTxIndex: null,
      });
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>(),
      });

      await expect(adapter.destinationCallback(route, mockReceipt)).rejects.toThrow(
        'Batch number not available',
      );
    });

    it('throws if proof data is unavailable', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      const mockRawReceipt = {
        l1BatchNumber: '0x64',
        l1BatchTxIndex: '0x05',
        l2ToL1Logs: [
          {
            sender: L1_MESSENGER.toLowerCase(),
            key: '0x000000000000000000000000' + ETH_TOKEN_L2.slice(2).toLowerCase(),
          },
        ],
        logs: [],
      };

      jest.spyOn(adapter as any, 'getRawReceipt').mockResolvedValue(mockRawReceipt);
      jest.spyOn(adapter as any, 'getL2ToL1LogProof').mockResolvedValue(undefined);
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>(),
      });

      await expect(adapter.destinationCallback(route, mockReceipt)).rejects.toThrow(
        'Failed to get L2 to L1 log proof',
      );
    });
  });

  describe('helper methods', () => {
    it('getRawReceipt returns receipt from RPC', async () => {
      const mockClient = {
        request: jest.fn<any>().mockResolvedValue({
          l1BatchNumber: '0x64',
          l1BatchTxIndex: '0x05',
        }),
      };

      const receipt = await (adapter as any).getRawReceipt(mockClient, '0xhash');
      expect(receipt).toBeDefined();
      expect(receipt.l1BatchNumber).toBe('0x64');
    });

    it('getRawReceipt returns undefined on error', async () => {
      const mockClient = {
        request: jest.fn<any>().mockRejectedValue(new Error('RPC error')),
      };

      const receipt = await (adapter as any).getRawReceipt(mockClient, '0xhash');
      expect(receipt).toBeUndefined();
    });

    it('getL2ToL1LogProof returns proof data from RPC', async () => {
      const mockClient = {
        request: jest.fn<any>().mockResolvedValue({
          proof: ['0xproof1', '0xproof2'],
          id: 5,
        }),
      };

      const proof = await (adapter as any).getL2ToL1LogProof(mockClient, '0xhash', 0);
      expect(proof).toBeDefined();
      expect(proof!.proof).toEqual(['0xproof1', '0xproof2']);
      expect(proof!.id).toBe(5);
    });

    it('getL2ToL1LogProof returns undefined when proof is not available', async () => {
      const mockClient = {
        request: jest.fn<any>().mockResolvedValue(null),
      };

      const proof = await (adapter as any).getL2ToL1LogProof(mockClient, '0xhash', 0);
      expect(proof).toBeUndefined();
    });

    it('getL2ToL1LogProof returns undefined on error', async () => {
      const mockClient = {
        request: jest.fn<any>().mockRejectedValue(new Error('RPC error')),
      };

      const proof = await (adapter as any).getL2ToL1LogProof(mockClient, '0xhash', 0);
      expect(proof).toBeUndefined();
    });

    it('extractL1Message extracts message from L1MessageSent log', () => {
      const senderKey = ETH_TOKEN_L2.toLowerCase();
      const paddedKey = '0x000000000000000000000000' + senderKey.slice(2);
      // Data: offset (32 bytes) + length (32 bytes) + message bytes
      // offset = 0x20, length = 2 (2 bytes = 4 hex chars), message = 'aabb'
      const data =
        '0x' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000002' +
        'aabb000000000000000000000000000000000000000000000000000000000000';

      const rawReceipt = {
        logs: [
          {
            address: '0x0000000000000000000000000000000000008008', // L1_MESSENGER
            topics: [L1_MESSAGE_SENT_TOPIC, paddedKey.toLowerCase()],
            data,
          },
        ],
      };

      const message = (adapter as any).extractL1Message(rawReceipt, senderKey);
      expect(message).toBe('0xaabb');
    });

    it('extractL1Message throws if event not found', () => {
      const rawReceipt = { logs: [] };
      expect(() => (adapter as any).extractL1Message(rawReceipt, ETH_TOKEN_L2.toLowerCase())).toThrow(
        'L1MessageSent event not found',
      );
    });
  });
});
