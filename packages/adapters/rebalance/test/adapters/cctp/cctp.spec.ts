import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CctpBridgeAdapter } from '../../../src/adapters/cctp/cctp';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../../src/types';
import { USDC_CONTRACTS, TOKEN_MESSENGERS_V1, TOKEN_MESSENGERS_V2, MESSAGE_TRANSMITTERS_V1, MESSAGE_TRANSMITTERS_V2, CHAIN_ID_TO_DOMAIN } from '../../../src/adapters/cctp/constants';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockChains = {
  '42161': {
    providers: ['https://mock'],
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
const amount = '1000000';
const route = { asset: USDC_CONTRACTS['arbitrum'], origin: 42161, destination: 42161 };

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
      readContract: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt(amount)),
    }),
    encodeFunctionData: jest.fn(() => '0xdata'),
    keccak256: jest.fn(() => '0xtopic'),
    decodeAbiParameters: jest.fn(() => ['0xdeadbeef']),
  });
});

global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'complete', message: '0xmsg', attestation: '0xatt' }) })) as any;

// Mock axios for v2
jest.mock('axios', () => ({
  default: { get: jest.fn(async () => ({ status: 200, data: { messages: [{ status: 'complete', message: '0xmsg', attestation: '0xatt' }] } })) },
}));

describe('CctpBridgeAdapter', () => {
  let adapter: CctpBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new CctpBridgeAdapter('v1', mockChains, mockLogger);
  });

  it('constructs and returns correct type', () => {
    expect(adapter.type()).toBe('cctpv1');
  });

  it('getReceivedAmount returns input amount', async () => {
    expect(await adapter.getReceivedAmount('123', route)).toBe('123');
  });

  it('send returns burn tx (v1)', async () => {
    const txs = await adapter.send(sender, recipient, amount, route);
    expect(txs.some(tx => tx.memo === RebalanceTransactionMemo.Rebalance)).toBe(true);
    expect(txs[0].transaction.data).toBe('0xdata');
  });

  it('send returns burn tx (v2)', async () => {
    const v2adapter = new CctpBridgeAdapter('v2', mockChains, mockLogger);
    const txs = await v2adapter.send(sender, recipient, amount, route);
    expect(txs.some(tx => tx.memo === RebalanceTransactionMemo.Rebalance)).toBe(true);
    expect(txs[0].transaction.data).toBe('0xdata');
  });

  it('readyOnDestination returns true if attestation is ready', async () => {
    const spy = jest.spyOn(adapter as any, 'extractMessageHash').mockResolvedValue('0xhash');
    const ready = await adapter.readyOnDestination(amount, route, mockReceipt);
    expect(ready).toBe(true);
    spy.mockRestore();
  });

  it('destinationCallback returns mint tx', async () => {
    const spy = jest.spyOn(adapter as any, 'extractMessageHash').mockResolvedValue('0xhash');
    const tx = await adapter.destinationCallback(route, mockReceipt);
    expect(tx && tx.memo).toBe(RebalanceTransactionMemo.Mint);
    expect(tx && tx.transaction.data).toBe('0xdata');
    spy.mockRestore();
  });

  it('fetchAttestation (v1) returns messageBytes and attestation', async () => {
    const result = await (adapter as any).fetchAttestation('0xhash', 'arbitrum');
    expect(result).toEqual({ messageBytes: '0xmsg', attestation: '0xatt' });
  });

  it('fetchAttestation (v2) returns messageBytes and attestation', async () => {
    const v2adapter = new CctpBridgeAdapter('v2', mockChains, mockLogger);
    // Patch the method to break after one loop
    jest.spyOn(v2adapter as any, 'fetchAttestation').mockImplementation(async () => ({
      messageBytes: '0xmsg',
      attestation: '0xatt',
    }));
    const result = await (v2adapter as any).fetchAttestation('0xhash', 'arbitrum');
    expect(result).toEqual({ messageBytes: '0xmsg', attestation: '0xatt' });
  });

  it('pollAttestation (v1) returns true if complete', async () => {
    const result = await (adapter as any).pollAttestation('0xhash', 'arbitrum');
    expect(result).toBe(true);
  });

  it('pollAttestation (v2) returns true if complete', async () => {
    const v2adapter = new CctpBridgeAdapter('v2', mockChains, mockLogger);
    jest.spyOn(v2adapter as any, 'pollAttestation').mockResolvedValue(true);
    const result = await (v2adapter as any).pollAttestation('0xhash', 'arbitrum');
    expect(result).toBe(true);
  });

  it('extractMessageHash returns a hash if log is found', async () => {
    const logs = [{
      topics: ['0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036'],
      data: '0xdata',
    }];
    const receipt = { ...mockReceipt, logs };
    const result = await (adapter as any).extractMessageHash(receipt);
    expect(result).toBe('0xtopic');
  });
}); 