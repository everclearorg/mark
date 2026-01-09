import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Logger } from '@mark/logger';
import { RebalanceTransactionMemo } from '../../../src/types';
import { 
  CHAIN_SELECTORS, 
  CCIP_ROUTER_ADDRESSES, 
  SOLANA_CHAIN_ID_NUMBER 
} from '../../../src/adapters/ccip/types';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockChains = {
  '1': {
    providers: ['https://mock-eth-rpc'],
    assets: [],
    invoiceAge: 0,
    gasThreshold: '0',
    deployments: {
      everclear: '0x0000000000000000000000000000000000000001',
      permit2: '0x0000000000000000000000000000000000000002',
      multicall3: '0x0000000000000000000000000000000000000003',
    },
  },
  [SOLANA_CHAIN_ID_NUMBER.toString()]: {
    providers: ['https://mock-sol-rpc'],
    assets: [],
    invoiceAge: 0,
    gasThreshold: '0',
    deployments: {
      everclear: 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C',
      permit2: '0x' + '0'.repeat(40),
      multicall3: '0x' + '0'.repeat(40),
    },
  },
  '42161': {
    providers: ['https://mock-arb-rpc'],
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
const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const evmToEvmRoute = { asset: usdcAddress, origin: 1, destination: 42161 };
const evmToSolanaRoute = { asset: usdcAddress, origin: 1, destination: SOLANA_CHAIN_ID_NUMBER };

const mockExecutionReceipt = { receipt: { state: 2 } };
const mockGetExecutionReceipts: any = jest.fn<any>().mockImplementation(async function* () {
  yield mockExecutionReceipt;
});
const mockGetMessagesInTx: any = jest.fn<any>();

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

// Mock CCIP SDK - must be before import of adapter
const mockCcipClient = {
  getTransferStatus: jest.fn<() => Promise<number | null>>(),
};

// Mock CCIP SDK before importing adapter
jest.mock('@chainlink/ccip-sdk', () => {
  type UnsignedTx = {
    transactions: Array<{ to: `0x${string}`; from: `0x${string}`; data: `0x${string}`; value: bigint; nonce: number }>;
  };
  const mockGetFee = jest.fn<() => Promise<bigint>>().mockResolvedValue(0n);
  const mockGenerateUnsignedSendMessage = jest.fn<() => Promise<UnsignedTx>>().mockResolvedValue({
    transactions: [
      {
        to: CCIP_ROUTER_ADDRESSES[1] as `0x${string}`,
        from: sender as `0x${string}`,
        data: '0x' as `0x${string}`,
        value: 0n,
        nonce: 0,
      },
    ],
  });
  const mockSendMessage = jest
    .fn<() => Promise<{ tx: { hash: string; logs: unknown[]; blockNumber: number; timestamp: number; from: string } }>>()
    .mockResolvedValue({
      tx: {
        hash: '0xsolanatx',
        logs: [],
        blockNumber: 1,
        timestamp: 0,
        from: sender,
      },
    });

  const mockEvmChain = {
    getFee: mockGetFee,
    generateUnsignedSendMessage: mockGenerateUnsignedSendMessage,
  };

  const mockSolanaChain = {
    getFee: mockGetFee,
    generateUnsignedSendMessage: mockGenerateUnsignedSendMessage,
  };

  const mockSolanaConnChain = {
    getFee: mockGetFee,
    sendMessage: mockSendMessage,
  };

  mockGetMessagesInTx.mockResolvedValue([
    {
      message: {
        messageId: '0xmsgid',
        sourceChainSelector: BigInt(CHAIN_SELECTORS.ETHEREUM),
      },
      tx: { timestamp: 0 },
      lane: { onRamp: '0xonramp' },
    },
  ]);

  return {
    EVMChain: {
      fromUrl: jest.fn((): Promise<any> =>
        Promise.resolve({
          ...mockEvmChain,
          getMessagesInTx: mockGetMessagesInTx,
          getExecutionReceipts: mockGetExecutionReceipts,
        }),
      ),
    },
    SolanaChain: {
      fromUrl: jest.fn((): Promise<any> =>
        Promise.resolve({
          ...mockSolanaChain,
          getMessagesInTx: mockGetMessagesInTx,
          getExecutionReceipts: mockGetExecutionReceipts,
        }),
      ),
      fromConnection: jest.fn((): Promise<any> => Promise.resolve(mockSolanaConnChain)),
    },
    ExecutionState: { Success: 2, Failed: 3 } as any,
    MessageStatus: { Success: 'SUCCESS', Failed: 'FAILED' } as any,
    CHAIN_FAMILY: { EVM: 'EVM', SOLANA: 'SOLANA' },
    discoverOffRamp: jest.fn((): Promise<any> => Promise.resolve('0xofframp')),
  } as any;
});

// Import adapter after mocks are set up
import { CCIPBridgeAdapter } from '../../../src/adapters/ccip/ccip';

// Create a testable subclass that overrides the protected importCcipModule method
class TestableCCIPBridgeAdapter extends CCIPBridgeAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async importCcipModule(): Promise<any> {
    return { createClient: () => mockCcipClient };
  }
}

// Mock viem
jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return Object.assign({}, actual, {
    createPublicClient: () => ({
      readContract: jest.fn<() => Promise<bigint>>().mockResolvedValue(BigInt(amount)),
      getTransactionReceipt: jest.fn<() => Promise<any>>().mockResolvedValue({
        logs: [
          {
            topics: ['0xevent', '0xmessageid123456789012345678901234567890123456789012345678901234'],
            data: '0x',
            address: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D',
          },
        ],
      }),
    }),
    encodeFunctionData: jest.fn(() => '0xdata'),
    http: jest.fn(() => ({})),
    fallback: jest.fn(() => ({})),
  });
});

// Mock bs58 for Solana address encoding - bs58 is imported as default export
jest.mock('bs58', () => {
  const mockDecode = jest.fn((str: string) => {
    // Return a 32-byte Uint8Array for valid Solana addresses
    if (str.length >= 32) {
      return new Uint8Array(32).fill(1);
    }
    throw new Error('Invalid base58 string');
  });
  return {
    __esModule: true,
    default: {
      decode: mockDecode,
    },
    decode: mockDecode,
  };
});

describe('CCIPBridgeAdapter', () => {
  let adapter: TestableCCIPBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCcipClient.getTransferStatus.mockResolvedValue(null);
    adapter = new TestableCCIPBridgeAdapter(mockChains, mockLogger);
  });

  describe('constructor and type', () => {
    it('constructs and returns correct type', () => {
      expect(adapter.type()).toBe('chainlink-ccip');
    });
  });

  describe('getMinimumAmount', () => {
    it('returns null (no fixed minimum for CCIP)', async () => {
      expect(await adapter.getMinimumAmount(evmToEvmRoute)).toBeNull();
    });
  });

  describe('getReceivedAmount', () => {
    it('returns 1:1 for CCIP transfers (no price impact)', async () => {
      const receivedAmount = await adapter.getReceivedAmount('1000000', evmToEvmRoute);
      expect(receivedAmount).toBe('1000000');
    });

    it('throws for unsupported origin chain', async () => {
      const invalidRoute = { asset: usdcAddress, origin: 999, destination: 42161 };
      await expect(adapter.getReceivedAmount('1000000', invalidRoute)).rejects.toThrow(
        'Origin chain 999 not supported by CCIP'
      );
    });
  });

  describe('chain selector mapping', () => {
    it('correctly maps Ethereum chain ID to CCIP selector', () => {
      const selector = (adapter as any).getDestinationChainSelector(1);
      expect(selector).toBe(CHAIN_SELECTORS.ETHEREUM);
    });

    it('correctly maps Arbitrum chain ID to CCIP selector', () => {
      const selector = (adapter as any).getDestinationChainSelector(42161);
      expect(selector).toBe(CHAIN_SELECTORS.ARBITRUM);
    });

    it('correctly identifies Solana chain', () => {
      const isSolana = (adapter as any).isSolanaChain(SOLANA_CHAIN_ID_NUMBER);
      expect(isSolana).toBe(true);
    });

    it('correctly identifies non-Solana chain', () => {
      const isSolana = (adapter as any).isSolanaChain(1);
      expect(isSolana).toBe(false);
    });

    it('maps Solana chain to CCIP selector', () => {
      const selector = (adapter as any).getDestinationChainSelector(SOLANA_CHAIN_ID_NUMBER);
      expect(selector).toBe(CHAIN_SELECTORS.SOLANA);
    });

    it('throws for unsupported chain ID', () => {
      expect(() => (adapter as any).getDestinationChainSelector(999)).toThrow(
        'Unsupported destination chain ID: 999'
      );
    });
  });

  describe('address encoding', () => {
    it('encodes EVM address with 32-byte padding', async () => {
      const encoded = await (adapter as any).encodeRecipientAddress(recipient, 1);
      // Should be 0x + 24 zeros + 40 char address (without 0x prefix)
      expect(encoded.length).toBe(66); // 0x + 64 hex chars
      expect(encoded.startsWith('0x000000000000000000000000')).toBe(true);
    });

    it('throws for invalid EVM address format', async () => {
      await expect((adapter as any).encodeRecipientAddress('0x1234', 1)).rejects.toThrow(
        'Invalid EVM address format: 0x1234',
      );
    });

    it('encodes Solana address through encodeRecipientAddress', async () => {
      const solanaAddress = 'PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA';
      const encoded = await (adapter as any).encodeRecipientAddress(solanaAddress, SOLANA_CHAIN_ID_NUMBER);
      expect(encoded.startsWith('0x')).toBe(true);
      expect(encoded.length).toBe(66);
    });

    it('encodes Solana address using bs58 decode', async () => {
      const solanaAddress = 'PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA';
      const encoded = await (adapter as any).encodeSolanaAddress(solanaAddress);
      expect(encoded.startsWith('0x')).toBe(true);
      expect(encoded.length).toBe(66); // 0x + 64 hex chars (32 bytes)
    });

    it('throws when Solana address is invalid', async () => {
      await expect((adapter as any).encodeSolanaAddress('short')).rejects.toThrow(
        /Failed to encode Solana address 'short'/,
      );
    });
  });

  describe('SVM extra args encoding', () => {
    it('returns hex-encoded tokenReceiver and accounts', async () => {
      const solanaAddress = 'PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA';
      const extra = await (adapter as any).encodeSVMExtraArgsV1(0, 0n, true, solanaAddress, [solanaAddress]);
      expect(extra.tokenReceiver.startsWith('0x')).toBe(true);
      expect(extra.tokenReceiver.length).toBe(66);
      expect(extra.accounts[0]?.startsWith('0x')).toBe(true);
      expect(extra.accounts[0]?.length).toBe(66);
      expect(extra.allowOutOfOrderExecution).toBe(true);
    });

    it('throws when accounts are not 32 bytes', async () => {
      const solanaAddress = 'PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA';
      await expect(
        (adapter as any).encodeSVMExtraArgsV1(0, 0n, true, solanaAddress, ['0x1234']),
      ).rejects.toThrow(/Invalid account length/);
    });
  });

  describe('send', () => {
    it('throws for non-Solana destination', async () => {
      await expect(adapter.send(sender, recipient, amount, evmToEvmRoute)).rejects.toThrow(
        'Destination chain must be an Solana chain',
      );
    });

    it('throws for unsupported origin chain', async () => {
      const invalidRoute = { asset: usdcAddress, origin: 999, destination: 42161 };
      await expect(adapter.send(sender, recipient, amount, invalidRoute)).rejects.toThrow(
        'Origin chain 999 not supported by CCIP'
      );
    });

    it('returns send transaction for EVM to Solana route', async () => {
      const solanaRecipient = 'PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA';
      const txs = await adapter.send(sender, solanaRecipient, amount, evmToSolanaRoute);
      const sendTx = txs.find(tx => tx.memo === RebalanceTransactionMemo.Rebalance);
      expect(sendTx).toBeDefined();
      expect(sendTx?.transaction.to).toBe(CCIP_ROUTER_ADDRESSES[1]);
      expect(sendTx?.effectiveAmount).toBe(amount);
    });

    it('throws when no providers exist for origin chain', async () => {
      const adapterNoProviders = new TestableCCIPBridgeAdapter(
        { ...mockChains, '1': { ...mockChains['1'], providers: [] } },
        mockLogger,
      );
      await expect(adapterNoProviders.send(sender, recipient, amount, evmToSolanaRoute)).rejects.toThrow(
        'No providers found for origin chain 1',
      );
    });
  });

  describe('readyOnDestination', () => {
    it('returns false if origin transaction is not successful', async () => {
      const failedReceipt = { ...mockReceipt, status: 'reverted' };
      const ready = await adapter.readyOnDestination(amount, evmToSolanaRoute, failedReceipt);
      expect(ready).toBe(false);
    });

    it('treats numeric status 1 as successful', async () => {
      jest.spyOn(adapter as any, 'getTransferStatus').mockResolvedValue({
        status: 'SUCCESS',
        message: 'ok',
      });
      const ready = await adapter.readyOnDestination(amount, evmToSolanaRoute, { ...mockReceipt, status: 1 } as any);
      expect(ready).toBe(true);
    });

    it('returns true when CCIP status is SUCCESS', async () => {
      jest.spyOn(adapter as any, 'getTransferStatus').mockResolvedValue({
        status: 'SUCCESS',
        message: 'ok',
      });
      const ready = await adapter.readyOnDestination(amount, evmToSolanaRoute, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false when CCIP status is PENDING', async () => {
      jest.spyOn(adapter as any, 'getTransferStatus').mockResolvedValue({
        status: 'PENDING',
        message: 'pending',
      });
      const ready = await adapter.readyOnDestination(amount, evmToSolanaRoute, mockReceipt);
      expect(ready).toBe(false);
    });

    it('returns false when CCIP status is null', async () => {
      jest.spyOn(adapter as any, 'getTransferStatus').mockResolvedValue({
        status: 'PENDING',
        message: 'pending',
      });
      const ready = await adapter.readyOnDestination(amount, evmToSolanaRoute, mockReceipt);
      expect(ready).toBe(false);
    });

    it('returns false when getTransferStatus throws', async () => {
      jest.spyOn(adapter as any, 'getTransferStatus').mockRejectedValue(new Error('boom'));
      const ready = await adapter.readyOnDestination(amount, evmToSolanaRoute, mockReceipt);
      expect(ready).toBe(false);
    });
  });

  describe('destinationCallback', () => {
    it('returns void (CCIP handles delivery automatically)', async () => {
      const result = await adapter.destinationCallback(evmToEvmRoute, mockReceipt);
      expect(result).toBeUndefined();
    });
  });

  describe('getTransferStatus', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetMessagesInTx.mockResolvedValue([
        {
          message: {
            messageId: '0xmsgid',
            sourceChainSelector: BigInt(CHAIN_SELECTORS.ETHEREUM),
          },
          tx: { timestamp: 0 },
          lane: { onRamp: '0xonramp' },
        },
      ]);
      mockGetExecutionReceipts.mockImplementation(async function* () {
        yield mockExecutionReceipt;
      });
    });

    it('returns SUCCESS when execution receipt shows success', async () => {
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('SUCCESS');
      expect(status.messageId).toBe('0xmsgid');
    });

    it('returns FAILURE when execution receipt shows failure', async () => {
      mockGetExecutionReceipts.mockImplementation(async function* () {
        yield { receipt: { state: 3 } };
      });
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('FAILURE');
    });

    it('returns PENDING when no execution receipts found', async () => {
      mockGetExecutionReceipts.mockImplementation(async function* () {
        // Empty generator - no receipts
      });
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('CCIP transfer pending or not yet started');
    });

    it('returns PENDING on SDK error', async () => {
      mockGetExecutionReceipts.mockImplementation(async function* () {
        throw new Error('Network error');
      });
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('Error checking status');
    });

    it('returns PENDING when no message is found', async () => {
      mockGetMessagesInTx.mockResolvedValueOnce([]);
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('Could not extract CCIP message ID');
    });

    it('returns SUCCESS on Solana destination branch', async () => {
      const status = await adapter.getTransferStatus('0xhash', 1, SOLANA_CHAIN_ID_NUMBER);
      expect(status.status).toBe('SUCCESS');
    });

    it('retries on rate limit error for Solana and eventually succeeds', async () => {
      let callCount = 0;
      mockGetExecutionReceipts.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new Error('Too Many Requests');
        }
        yield mockExecutionReceipt;
      });

      const status = await adapter.getTransferStatus('0xhash', 1, SOLANA_CHAIN_ID_NUMBER);
      expect(status.status).toBe('SUCCESS');
      expect(callCount).toBe(2); // Should retry once
    });

    it('retries on 429 error for Solana', async () => {
      let callCount = 0;
      mockGetExecutionReceipts.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new Error('429 Too Many Requests');
        }
        yield mockExecutionReceipt;
      });

      const status = await adapter.getTransferStatus('0xhash', 1, SOLANA_CHAIN_ID_NUMBER);
      expect(status.status).toBe('SUCCESS');
      expect(callCount).toBe(2);
    });

    it('retries on rate limit error (case insensitive) for Solana', async () => {
      let callCount = 0;
      mockGetExecutionReceipts.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new Error('Rate Limit Exceeded');
        }
        yield mockExecutionReceipt;
      });

      const status = await adapter.getTransferStatus('0xhash', 1, SOLANA_CHAIN_ID_NUMBER);
      expect(status.status).toBe('SUCCESS');
      expect(callCount).toBe(2);
    });

    it('returns PENDING after max retries exceeded for Solana', async () => {
      mockGetExecutionReceipts.mockImplementation(async function* () {
        throw new Error('Too Many Requests');
      });

      const status = await adapter.getTransferStatus('0xhash', 1, SOLANA_CHAIN_ID_NUMBER);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('Rate limit error after 3 retries');
    });

    it('does not retry non-rate-limit errors', async () => {
      mockGetExecutionReceipts.mockImplementation(async function* () {
        throw new Error('Network timeout');
      });

      const status = await adapter.getTransferStatus('0xhash', 1, SOLANA_CHAIN_ID_NUMBER);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('Error checking status');
      expect(mockGetExecutionReceipts).toHaveBeenCalledTimes(1); // No retries
    });

    it('returns PENDING when no destination providers', async () => {
      const adapterNoDest = new TestableCCIPBridgeAdapter(
        {
          ...mockChains,
          [SOLANA_CHAIN_ID_NUMBER]: {
            ...mockChains[SOLANA_CHAIN_ID_NUMBER],
            providers: [],
          } as any,
        },
        mockLogger,
      );
      const status = await adapterNoDest.getTransferStatus('0xhash', 1, SOLANA_CHAIN_ID_NUMBER);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('No providers found for destination chain');
    });

    it('returns PENDING when no origin providers', async () => {
      const adapterNoOrigin = new TestableCCIPBridgeAdapter(
        { ...mockChains, '1': { ...(mockChains as any)['1'], providers: [] } },
        mockLogger,
      );
      const status = await adapterNoOrigin.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('No providers found for origin chain');
    });
  });

  describe('CCIP constants', () => {
    it('has correct Ethereum router address', () => {
      expect(CCIP_ROUTER_ADDRESSES[1]).toBe('0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D');
    });

    it('has correct Arbitrum router address', () => {
      expect(CCIP_ROUTER_ADDRESSES[42161]).toBe('0x141fa059441E0ca23ce184B6A78bafD2A517DdE8');
    });

    it('has Solana chain selector', () => {
      expect(CHAIN_SELECTORS.SOLANA).toBe('124615329519749607');
    });
  });
});

