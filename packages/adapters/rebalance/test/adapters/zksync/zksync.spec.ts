import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ZKSyncNativeBridgeAdapter } from '../../../src/adapters/zksync/zksync';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../../src/types';
import { SupportedBridge } from '@mark/core';

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

// Store reference to actual viem functions for use in tests
const actualViem = jest.requireActual('viem');

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
    // Keep encodeFunctionData as real for helper method tests, mock for transaction building
    encodeFunctionData: jest.fn(() => '0x' + '0'.repeat(20)), // Return valid hex string for slice(10)
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

  describe('send()', () => {
    it('returns requestL2Transaction tx on Diamond Proxy for L1->L2 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 324 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      // ETH deposits go through the Diamond Proxy, not the L1 Bridge
      expect(txs[0].transaction.to).toBe('0x32400084c286cf3e17e7b677ea9583e60a000324');
      // msg.value = deposit amount + L2 baseCost (with 20% buffer)
      expect(txs[0].transaction.value).toBe(BigInt(amount) + mockBaseCostWithBuffer);
    });

    it('returns approval + deposit txs on L1 Bridge for L1->L2 ERC20 transfer', async () => {
      const route = { asset: erc20Asset, origin: 1, destination: 324 };

      // Mock client to return gasPrice, baseCost, and zero allowance
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
      // ERC20 deposits go through the L1 Bridge
      expect(txs[1].transaction.to).toBe('0x57891966931eb4bb6fb81430e6ce0a03aabde063');
      // For ERC20, msg.value = baseCost only with 20% buffer (no deposit amount in value)
      expect(txs[1].transaction.value).toBe(mockBaseCostWithBuffer);
    });

    it('returns withdraw tx for L2->L1 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe('0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102');
    });

    it('returns withdraw tx for L2->L1 ERC20 transfer', async () => {
      const route = { asset: erc20Asset, origin: 324, destination: 1 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe('0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102');
    });
  });

  describe('readyOnDestination()', () => {
    it('returns true for L1->L2 (auto-relayed)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 324 };
      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('checks batch finalization for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      // Mock batch number and executed batches
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(200)), // totalBatchesExecuted
        request: jest.fn<any>().mockResolvedValue({ l1BatchNumber: 100 }),
      });
      jest.spyOn(adapter as any, 'getBatchNumberForTransaction').mockResolvedValue(100);

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false if batch not yet finalized for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(50)), // totalBatchesExecuted < batchNumber
        request: jest.fn<any>().mockResolvedValue({ l1BatchNumber: 100 }),
      });
      jest.spyOn(adapter as any, 'getBatchNumberForTransaction').mockResolvedValue(100);

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

    it('returns finalize tx for L2->L1 when ready', async () => {
      const route = { asset: ethAsset, origin: 324, destination: 1 };

      const mockWithdrawalReceipt = {
        ...mockReceipt,
        logs: [
          {
            address: '0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102',
            topics: ['0xwithdrawal'],
            data: '0x',
          },
        ],
      };

      // Mock parseEventLogs to return a withdrawal event
      const viem = require('viem');
      jest.spyOn(viem, 'parseEventLogs').mockReturnValue([
        {
          eventName: 'WithdrawalInitiated',
          args: {
            l2Sender: sender as `0x${string}`,
            l1Receiver: recipient as `0x${string}`,
            l2Token: '0x000000000000000000000000000000000000800A' as `0x${string}`,
            amount: BigInt(amount),
          },
        },
      ]);

      // Mock all dependencies
      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>()
          .mockResolvedValueOnce(false) // isWithdrawalFinalized = false
          .mockResolvedValueOnce(BigInt(200)), // totalBatchesExecuted
        request: jest.fn<any>().mockResolvedValue({ l1BatchNumber: 100 }),
      });
      jest.spyOn(adapter as any, 'getBatchNumberForTransaction').mockResolvedValue(100);
      jest.spyOn(adapter as any, 'getL2MessageIndex').mockResolvedValue(0);
      jest.spyOn(adapter as any, 'getL2ToL1LogProof').mockResolvedValue({
        proof: ['0xproof1' as `0x${string}`, '0xproof2' as `0x${string}`],
        l2TxNumberInBatch: 5,
      });
      jest.spyOn(adapter as any, 'buildWithdrawalMessage').mockReturnValue('0xmessage' as `0x${string}`);

      const tx = await adapter.destinationCallback(route, mockWithdrawalReceipt);

      expect(tx).toBeDefined();
      expect(tx?.memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(tx?.transaction.to).toBe('0x57891966931eb4bb6fb81430e6ce0a03aabde063');
    });
  });

  describe('helper methods', () => {
    it('getBatchNumberForTransaction returns batch number', async () => {
      const mockClient = {
        request: jest.fn<any>().mockResolvedValue({ l1BatchNumber: 100 }),
      };

      const batchNumber = await (adapter as any).getBatchNumberForTransaction(mockClient, '0xhash');
      expect(batchNumber).toBe(100);
    });

    it('getL2MessageIndex returns correct index', async () => {
      const mockClient = {};
      const receiptWithLogs = {
        ...mockReceipt,
        logs: [
          { address: '0xother' },
          { address: '0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102' },
        ],
      };

      const index = await (adapter as any).getL2MessageIndex(mockClient, receiptWithLogs);
      expect(index).toBe(1);
    });

    it('buildWithdrawalMessage computes correct message format', () => {
      const args = {
        l2Sender: '0x' + '1'.repeat(40) as `0x${string}`,
        l1Receiver: '0x' + '2'.repeat(40) as `0x${string}`,
        l2Token: '0x000000000000000000000000000000000000800A' as `0x${string}`,
        amount: BigInt(1000000),
      };

      const message = (adapter as any).buildWithdrawalMessage(args);
      expect(message).toBeDefined();
      expect(message.startsWith('0x')).toBe(true);
      // Message should be ABI-encoded parameters (without function selector)
      expect(message.length).toBeGreaterThan(2);
    });
  });
});
