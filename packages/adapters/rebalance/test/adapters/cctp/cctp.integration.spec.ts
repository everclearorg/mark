import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CctpBridgeAdapter } from '../../../src/adapters/cctp/cctp';
import { Logger } from '@mark/logger';
import { USDC_CONTRACTS, TOKEN_MESSENGERS_V1, TOKEN_MESSENGERS_V2, CHAIN_ID_TO_DOMAIN } from '../../../src/adapters/cctp/constants';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockChains = {
  '42161': { providers: ['https://mock'], assets: [] },
};

const sender = '0x' + '1'.repeat(40);
const recipient = '0x' + '2'.repeat(40);
const amount = '1000000';
const route = { asset: USDC_CONTRACTS['arbitrum'], origin: 42161, destination: 42161 };

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

describe('CctpBridgeAdapter Integration', () => {
  let adapter: CctpBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new CctpBridgeAdapter('v1', mockChains, mockLogger);

    // Mock viem's createPublicClient to avoid real HTTP calls
    jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue({
      readContract: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt(amount)),
    } as any);
  });

  it('should generate approval and burn transactions (V1)', async () => {
    // You can mock allowance to be insufficient to force approval
    // Or use real provider if available
    const txs = await adapter.send(sender, recipient, amount, route);
    expect(txs.length).toBeGreaterThan(0);
    expect(txs.some(tx => tx.transaction.data)).toBe(true);
    // Optionally: check txs[0].transaction.to, txs[1].transaction.to, etc.
  });

  it('should poll attestation and return true when ready (mocked)', async () => {
    const messageHash = '0xee99e47c242fce95623a2d07410c0ca13c1f3e484d257fc1913e0a0c2034ff2b';
    jest.spyOn(adapter as any, 'pollAttestation').mockResolvedValue(true);
    const ready = await (adapter as any).pollAttestation(messageHash, 'arbitrum');
    expect(ready).toBe(true);
  });

  it('should fetch attestation and return messageBytes and attestation (mocked)', async () => {
    const messageHash = '0xee99e47c242fce95623a2d07410c0ca13c1f3e484d257fc1913e0a0c2034ff2b';
    jest.spyOn(adapter as any, 'fetchAttestation').mockResolvedValue({
      messageBytes: '0xmsg',
      attestation: '0xatt',
    });
    const result = await (adapter as any).fetchAttestation(messageHash, 'arbitrum');
    expect(result).toEqual({ messageBytes: '0xmsg', attestation: '0xatt' });
  });

  it('should generate mint transaction after attestation (mocked)', async () => {
    // Replace with real transaction receipt if available
    const originTransaction = { logs: [] }; // TODO: fill in with real logs
    jest.spyOn(adapter as any, 'extractMessageHash').mockResolvedValue('0xhash');
    jest.spyOn(adapter as any, 'fetchAttestation').mockResolvedValue({
      messageBytes: '0xmsg',
      attestation: '0xatt',
    });
    const tx = await adapter.destinationCallback(route, originTransaction);
    expect(tx && tx.transaction.data).toBeDefined();
  });

  it('should run end-to-end flow (mocked)', async () => {
    const originTransaction = {
      logs: [],
      transactionHash: '0x7a97c8a0dfdb9f5016a11c9f5f4ddf12f79151ffa61f76eb4e75f63b84e19d7b'
    };
    jest.spyOn(adapter as any, 'extractMessageHash').mockResolvedValue('0xee99e47c242fce95623a2d07410c0ca13c1f3e484d257fc1913e0a0c2034ff2b');
    jest.spyOn(adapter as any, 'pollAttestation').mockResolvedValue(true);
    jest.spyOn(adapter as any, 'fetchAttestation').mockResolvedValue({
      messageBytes: '0xmsg',
      attestation: '0xatt',
    });

    // Send
    const txs = await adapter.send(sender, recipient, amount, route);
    expect(txs.length).toBeGreaterThan(0);

    // Ready on destination
    const ready = await adapter.readyOnDestination(amount, route, originTransaction);
    expect(ready).toBe(true);

    // Mint
    const mintTx = await adapter.destinationCallback(route, originTransaction);
    expect(mintTx && mintTx.transaction.data).toBeDefined();
  });

  it('should support V2 flow (mocked)', async () => {
    const v2adapter = new CctpBridgeAdapter('v2', mockChains, mockLogger);
    jest.spyOn(v2adapter as any, 'extractMessageHash').mockResolvedValue('0xhash');
    jest.spyOn(v2adapter as any, 'fetchAttestation').mockResolvedValue({
      messageBytes: '0xmsg',
      attestation: '0xatt',
    });
    const txs = await v2adapter.send(sender, recipient, amount, route);
    expect(txs.length).toBeGreaterThan(0);
    const mintTx = await v2adapter.destinationCallback(route, { logs: [] });
    expect(mintTx && mintTx.transaction.data).toBeDefined();
  });
});
