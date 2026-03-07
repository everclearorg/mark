import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { LineaNativeBridgeAdapter } from '../../../src/adapters/linea/linea';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../../src/types';
import { SupportedBridge } from '@mark/core';
import {
  LINEA_L1_MESSAGE_SERVICE,
  LINEA_L2_MESSAGE_SERVICE,
  LINEA_L1_TOKEN_BRIDGE,
  LINEA_L2_TOKEN_BRIDGE,
  L2_TO_L1_FEE,
} from '../../../src/adapters/linea/constants';

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
  '59144': {
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

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return Object.assign({}, actual, {
    createPublicClient: () => ({
      readContract: jest.fn<any>().mockResolvedValue(BigInt(amount)),
      getBlock: jest.fn<any>().mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 100000) }), // 100k seconds ago
      getLogs: jest.fn<any>().mockResolvedValue([]),
    }),
    encodeFunctionData: jest.fn(() => '0x' + '0'.repeat(20)), // Valid hex for transaction data
    parseEventLogs: jest.fn(() => []),
  });
});

jest.mock('@consensys/linea-sdk', () => ({
  LineaSDK: jest.fn<any>().mockImplementation(() => ({
    getL1ClaimingService: jest.fn<any>().mockReturnValue({
      getMessageProof: jest.fn<any>().mockResolvedValue(null),
    }),
  })),
  OnChainMessageStatus: {},
}));

describe('LineaNativeBridgeAdapter', () => {
  let adapter: LineaNativeBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new LineaNativeBridgeAdapter(mockChains, mockLogger);
  });

  describe('type()', () => {
    it('returns correct type', () => {
      expect(adapter.type()).toBe(SupportedBridge.Linea);
    });
  });

  describe('getReceivedAmount()', () => {
    it('returns input amount for L1->L2', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 59144 };
      expect(await adapter.getReceivedAmount(amount, route)).toBe(amount);
    });

    it('deducts fee for L2->L1 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };
      const received = await adapter.getReceivedAmount(amount, route);
      expect(BigInt(received)).toBe(BigInt(amount) - L2_TO_L1_FEE);
    });

    it('returns full amount for L2->L1 ERC20 transfer', async () => {
      const route = { asset: erc20Asset, origin: 59144, destination: 1 };
      const received = await adapter.getReceivedAmount(amount, route);
      expect(received).toBe(amount);
    });
  });

  describe('send()', () => {
    it('returns sendMessage tx for L1->L2 ETH transfer', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 59144 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe(LINEA_L1_MESSAGE_SERVICE);
      expect(txs[0].transaction.value).toBe(BigInt(amount));
    });

    it('returns approval + bridgeToken txs for L1->L2 ERC20 transfer', async () => {
      const route = { asset: erc20Asset, origin: 1, destination: 59144 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(0)), // allowance = 0
      });

      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(2);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[1].transaction.to).toBe(LINEA_L1_TOKEN_BRIDGE);
    });

    it('returns sendMessage tx for L2->L1 ETH transfer with fee', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };
      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(1);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[0].transaction.to).toBe(LINEA_L2_MESSAGE_SERVICE);
      expect(txs[0].transaction.value).toBe(BigInt(amount));
    });

    it('returns approval + bridgeToken txs for L2->L1 ERC20 transfer', async () => {
      const route = { asset: erc20Asset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(BigInt(0)), // allowance = 0
      });

      const txs = await adapter.send(sender, recipient, amount, route);

      expect(txs.length).toBe(2);
      expect(txs[0].memo).toBe(RebalanceTransactionMemo.Approval);
      expect(txs[1].memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(txs[1].transaction.to).toBe(LINEA_L2_TOKEN_BRIDGE);
      expect(txs[1].transaction.value).toBe(L2_TO_L1_FEE); // Anti-DDoS fee
    });
  });

  describe('readyOnDestination()', () => {
    it('returns true for L1->L2 (auto-claimed)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 59144 };
      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns true when L2 block is anchored on L1 (proof available)', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({});
      jest.spyOn(adapter as any, 'extractMessageInfo').mockReturnValue({
        messageHash: '0xhash',
        messageNumber: BigInt(1),
        from: sender as `0x${string}`,
        to: recipient as `0x${string}`,
        fee: BigInt(0),
        value: BigInt(amount),
        calldata: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'isMessageClaimed').mockResolvedValue(false);
      jest.spyOn(adapter as any, 'fetchProofFromLineaSDK').mockResolvedValue({
        proof: ['0xproof'],
        leafIndex: 0,
        root: '0xroot',
      });

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false when L2 block is not yet anchored (no proof available)', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({});
      jest.spyOn(adapter as any, 'extractMessageInfo').mockReturnValue({
        messageHash: '0xhash',
        messageNumber: BigInt(1),
        from: sender as `0x${string}`,
        to: recipient as `0x${string}`,
        fee: BigInt(0),
        value: BigInt(amount),
        calldata: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'isMessageClaimed').mockResolvedValue(false);
      jest.spyOn(adapter as any, 'fetchProofFromLineaSDK').mockResolvedValue(undefined);

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(false);
    });

    it('returns true immediately when message is already claimed', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({});
      jest.spyOn(adapter as any, 'extractMessageInfo').mockReturnValue({
        messageHash: '0xhash',
        messageNumber: BigInt(1),
        from: sender as `0x${string}`,
        to: recipient as `0x${string}`,
        fee: BigInt(0),
        value: BigInt(amount),
        calldata: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'isMessageClaimed').mockResolvedValue(true);

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false when no MessageSent event in receipt', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({});
      jest.spyOn(adapter as any, 'extractMessageInfo').mockReturnValue(undefined);

      const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
      expect(ready).toBe(false);
    });
  });

  describe('destinationCallback()', () => {
    it('returns undefined for L1->L2 (no callback needed)', async () => {
      const route = { asset: ethAsset, origin: 1, destination: 59144 };
      const tx = await adapter.destinationCallback(route, mockReceipt);
      expect(tx).toBeUndefined();
    });

    it('returns undefined if no MessageSent event found for L2->L1', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({});
      jest.spyOn(adapter as any, 'extractMessageInfo').mockReturnValue(undefined);

      const tx = await adapter.destinationCallback(route, mockReceipt);
      expect(tx).toBeUndefined();
    });

    it('returns undefined if message already claimed', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({});
      jest.spyOn(adapter as any, 'extractMessageInfo').mockReturnValue({
        messageHash: '0xhash',
        messageNumber: BigInt(1),
        from: sender as `0x${string}`,
        to: recipient as `0x${string}`,
        fee: BigInt(0),
        value: BigInt(amount),
        calldata: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'isMessageClaimed').mockResolvedValue(true);

      const tx = await adapter.destinationCallback(route, mockReceipt);
      expect(tx).toBeUndefined();
    });

    it('returns claimMessageWithProof tx when proof is available', async () => {
      const route = { asset: ethAsset, origin: 59144, destination: 1 };

      jest.spyOn(adapter as any, 'getClient').mockResolvedValue({});
      jest.spyOn(adapter as any, 'extractMessageInfo').mockReturnValue({
        messageHash: '0xhash',
        messageNumber: BigInt(1),
        from: sender as `0x${string}`,
        to: recipient as `0x${string}`,
        fee: BigInt(0),
        value: BigInt(amount),
        calldata: '0x' as `0x${string}`,
      });
      jest.spyOn(adapter as any, 'isMessageClaimed').mockResolvedValue(false);
      jest.spyOn(adapter as any, 'fetchProofFromLineaSDK').mockResolvedValue({
        proof: ['0xproof1', '0xproof2'],
        leafIndex: 0,
        root: '0xroot',
      });

      const tx = await adapter.destinationCallback(route, mockReceipt);

      expect(tx).toBeDefined();
      expect(tx?.memo).toBe(RebalanceTransactionMemo.Rebalance);
      expect(tx?.transaction.to).toBe(LINEA_L1_MESSAGE_SERVICE);
    });
  });

  describe('helper methods', () => {
    it('isMessageClaimed returns true when contract returns true', async () => {
      const mockClient = {
        readContract: jest.fn<any>().mockResolvedValue(true),
      };

      const isClaimed = await (adapter as any).isMessageClaimed(mockClient, BigInt(42));
      expect(isClaimed).toBe(true);
    });

    it('isMessageClaimed returns false when contract returns false', async () => {
      const mockClient = {
        readContract: jest.fn<any>().mockResolvedValue(false),
      };

      const isClaimed = await (adapter as any).isMessageClaimed(mockClient, BigInt(42));
      expect(isClaimed).toBe(false);
    });
  });

  describe('route validation', () => {
    it('throws for unsupported routes in send', async () => {
      await expect(adapter.send(sender, recipient, amount, { asset: ethAsset, origin: 10, destination: 59144 })).rejects.toThrow(
        'Unsupported Linea route',
      );
    });

    it('throws for unsupported routes in destinationCallback', async () => {
      await expect(
        adapter.destinationCallback({ asset: ethAsset, origin: 10, destination: 59144 }, mockReceipt),
      ).rejects.toThrow('Unsupported Linea route');
    });
  });
});
