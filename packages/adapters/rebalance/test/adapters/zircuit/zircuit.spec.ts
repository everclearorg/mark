import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ZircuitNativeBridgeAdapter } from '../../../src/adapters/zircuit/zircuit';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../../src/types';
import { SupportedBridge } from '@mark/core';
import {
  ZIRCUIT_L1_STANDARD_BRIDGE,
  ZIRCUIT_L2_STANDARD_BRIDGE,
  ZIRCUIT_OPTIMISM_PORTAL,
  CHALLENGE_PERIOD_SECONDS,
} from '../../../src/adapters/zircuit/constants';

const mockLogger = {
  debug: jest.fn<any>(),
  info: jest.fn<any>(),
  warn: jest.fn<any>(),
  error: jest.fn<any>(),
} as unknown as Logger;

const l1Erc20 = '0x' + 'a'.repeat(40);
const l2Erc20 = '0x' + 'b'.repeat(40);
const erc20TickerHash = '0xtickerHash';

const mockChains = {
  '1': {
    providers: ['https://mock-l1'],
    assets: [
      { address: l1Erc20, tickerHash: erc20TickerHash, symbol: 'TEST', decimals: 18, isNative: false, balanceThreshold: '0' },
    ],
    invoiceAge: 0,
    gasThreshold: '0',
    deployments: {
      everclear: '0x0000000000000000000000000000000000000001',
      permit2: '0x0000000000000000000000000000000000000002',
      multicall3: '0x0000000000000000000000000000000000000003',
    },
  },
  '48900': {
    providers: ['https://mock-l2'],
    assets: [
      { address: l2Erc20, tickerHash: erc20TickerHash, symbol: 'TEST', decimals: 18, isNative: false, balanceThreshold: '0' },
    ],
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

const mockReceipt = {
  blockHash: '0xblock',
  blockNumber: 1000n,
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

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return Object.assign({}, actual, {
    createPublicClient: () => ({
      readContract: jest.fn<any>().mockResolvedValue(BigInt(amount)),
      getBlock: jest.fn<any>().mockResolvedValue({
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
        stateRoot: '0x' + 'a'.repeat(64),
        hash: '0x' + 'b'.repeat(64),
      }),
      request: jest.fn<any>().mockResolvedValue({
        storageHash: '0x' + 'c'.repeat(64),
        storageProof: [{ proof: ['0xproof'] }],
      }),
    }),
    encodeFunctionData: jest.fn(() => '0x' + '0'.repeat(20)), // Valid hex for transaction data
    parseEventLogs: jest.fn(() => []),
    keccak256: jest.fn(() => '0x' + 'd'.repeat(64)),
    encodeAbiParameters: jest.fn(() => '0xencoded'),
    parseAbiParameters: jest.fn(() => []),
  });
});

describe('ZircuitNativeBridgeAdapter', () => {
  let adapter: ZircuitNativeBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new ZircuitNativeBridgeAdapter(mockChains, mockLogger);
  });

  describe('type()', () => {
    it('returns correct type', () => {
      expect(adapter.type()).toBe(SupportedBridge.Zircuit);
    });
  });

  describe('getReceivedAmount()', () => {
    it('returns input amount (no fees)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 48900 };
      expect(await adapter.getReceivedAmount('123456', route)).toBe('123456');
    });
  });

  describe('send()', () => {
    it('returns bridgeETHTo tx for L1->L2 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 48900 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe(ZIRCUIT_L1_STANDARD_BRIDGE);
      expect(txs[0].transaction.value).toBe(BigInt(amount));
    });

    it('returns approval + bridgeERC20To txs for L1->L2 ERC20 transfer', async () => {
      const route = { asset: l1Erc20, origin: 1, destination: 48900 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(0)), // allowance = 0
      });

      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(2);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[1].transaction.to).toBe(ZIRCUIT_L1_STANDARD_BRIDGE);
    });

    it('returns bridgeETHTo tx for L2->L1 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe(ZIRCUIT_L2_STANDARD_BRIDGE);
      expect(txs[0].transaction.value).toBe(BigInt(amount));
    });

    it('returns approval + bridgeERC20To txs for L2->L1 ERC20 transfer', async () => {
      const route = { asset: l2Erc20, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(0)), // allowance = 0
      });

      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(2);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[1].transaction.to).toBe(ZIRCUIT_L2_STANDARD_BRIDGE);
    });
  });

  describe('readyOnDestination()', () => {
    it('returns true for L1->L2 (auto-relayed)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 48900 };
      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns true if withdrawal already finalized for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(true), // finalizedWithdrawals = true
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns true if proven and challenge period passed for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      // Proven timestamp more than 7 days ago
      const oldTimestamp = BigInt(Math.floor(Date.now() / 1000) - CHALLENGE_PERIOD_SECONDS - 3600);

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>()
          .mockResolvedValueOnce(false) // finalizedWithdrawals = false
          .mockResolvedValueOnce(['0xroot', oldTimestamp, BigInt(1)]), // provenWithdrawals
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false if proven but challenge period not passed for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      // Proven timestamp less than 7 days ago
      const recentTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>()
          .mockResolvedValueOnce(false) // finalizedWithdrawals = false
          .mockResolvedValueOnce(['0xroot', recentTimestamp, BigInt(1)]), // provenWithdrawals
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(false);
    });

    it('returns true if not proven but L2 output available for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>()
          .mockResolvedValueOnce(false) // finalizedWithdrawals = false
          .mockResolvedValueOnce(['0x0', BigInt(0), BigInt(0)]) // provenWithdrawals (not proven)
          .mockResolvedValueOnce(BigInt(5)), // getL2OutputIndexAfter
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });
  });

  describe('destinationCallback()', () => {
    it('returns undefined for L1->L2 (no callback needed)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 48900 };
      const tx = await adapter.destinationCallback(route, mockReceipt);
      expect(tx).toBeUndefined();
    });

    it('returns undefined if withdrawal already finalized', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(true), // finalizedWithdrawals = true
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const tx = await adapter.destinationCallback(route, mockReceipt);
      expect(tx).toBeUndefined();
    });

    it('returns finalizeWithdrawalTransaction tx if proven and challenge period passed', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      const oldTimestamp = BigInt(Math.floor(Date.now() / 1000) - CHALLENGE_PERIOD_SECONDS - 3600);

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>()
          .mockResolvedValueOnce(false) // finalizedWithdrawals = false
          .mockResolvedValueOnce(['0xroot', oldTimestamp, BigInt(1)]), // provenWithdrawals
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const tx = await adapter.destinationCallback(route, mockReceipt);

      expect(tx).toBeDefined();
      expect(tx?.memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(tx?.transaction.to).toBe(ZIRCUIT_OPTIMISM_PORTAL);
    });

    it('returns proveWithdrawalTransaction tx if not proven', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>()
          .mockResolvedValueOnce(false) // finalizedWithdrawals = false
          .mockResolvedValueOnce(['0x0', BigInt(0), BigInt(0)]), // provenWithdrawals (not proven)
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');
      jest.spyOn(adapter as any, 'buildZircuitProof').mockResolvedValue({
        l2OutputIndex: BigInt(5),
        outputRootProof: {
          version: '0x' + '0'.repeat(64),
          stateRoot: '0x' + 'a'.repeat(64),
          messagePasserStorageRoot: '0x' + 'c'.repeat(64),
          latestBlockhash: '0x' + 'b'.repeat(64),
        },
        withdrawalProof: ['0xproof1', '0xproof2'],
      });

      const tx = await adapter.destinationCallback(route, mockReceipt);

      expect(tx).toBeDefined();
      expect(tx?.memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(tx?.transaction.to).toBe(ZIRCUIT_OPTIMISM_PORTAL);
    });
  });

  describe('isCallbackComplete()', () => {
    it('returns true for L1->L2 (no multi-step)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 48900 };
      const result = await adapter.isCallbackComplete(route, mockReceipt);
      expect(result).toBe(true);
    });

    it('returns true for L2->L1 when withdrawal is finalized', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(true), // finalizedWithdrawals = true
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const result = await adapter.isCallbackComplete(route, mockReceipt);
      expect(result).toBe(true);
    });

    it('returns false for L2->L1 when withdrawal is not finalized', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(false), // finalizedWithdrawals = false
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue({
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'hashWithdrawal').mockReturnValue('0xhash');

      const result = await adapter.isCallbackComplete(route, mockReceipt);
      expect(result).toBe(false);
    });

    it('returns true if withdrawal transaction cannot be extracted (fail-safe)', async () => {
      const route = { asset: ethAsset, origin: 48900, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>(),
      });
      jest.spyOn(adapter as any, 'extractWithdrawalTransaction').mockResolvedValue(undefined);

      const result = await adapter.isCallbackComplete(route, mockReceipt);
      expect(result).toBe(true);
    });
  });

  describe('helper methods', () => {
    it('hashWithdrawal computes withdrawal hash', () => {
      const withdrawalTx = {
        nonce: BigInt(1),
        sender: sender as `0x${string}`,
        target: recipient as `0x${string}`,
        value: BigInt(amount),
        gasLimit: BigInt(100000),
        data: '0x' as `0x${string}`,
      };

      const hash = (adapter as any).hashWithdrawal(withdrawalTx);
      expect(hash).toBeDefined();
      expect(hash.startsWith('0x')).toBe(true);
    });
  });
});
