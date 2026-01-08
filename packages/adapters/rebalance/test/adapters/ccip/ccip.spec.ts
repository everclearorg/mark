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
    it('encodes EVM address with 32-byte padding', () => {
      const encoded = (adapter as any).encodeRecipientAddress(recipient, 1);
      // Should be 0x + 24 zeros + 40 char address (without 0x prefix)
      expect(encoded.length).toBe(66); // 0x + 64 hex chars
      expect(encoded.startsWith('0x000000000000000000000000')).toBe(true);
    });

    it('throws for invalid EVM address format', () => {
      expect(() => (adapter as any).encodeRecipientAddress('invalid', 1)).toThrow(
        'Invalid EVM address format: invalid'
      );
    });

    it('encodes Solana address using bs58 decode', () => {
      const solanaAddress = 'PTSg1sXMujX5bgTM88C2PMksHG5w2bqvXJrG9uUdzpA';
      const encoded = (adapter as any).encodeSolanaAddress(solanaAddress);
      expect(encoded.startsWith('0x')).toBe(true);
      expect(encoded.length).toBe(66); // 0x + 64 hex chars (32 bytes)
    });
  });

  describe('send', () => {
    it('returns approval and send transactions for EVM to EVM', async () => {
      const txs = await adapter.send(sender, recipient, amount, evmToEvmRoute);
      
      // Should have at least one transaction (approval if needed + send)
      expect(txs.length).toBeGreaterThanOrEqual(1);
      
      // Last transaction should be the CCIP send
      const sendTx = txs.find(tx => tx.memo === RebalanceTransactionMemo.Rebalance);
      expect(sendTx).toBeDefined();
      expect(sendTx?.transaction.to).toBe(CCIP_ROUTER_ADDRESSES[1]);
    });

    it('throws for unsupported origin chain', async () => {
      const invalidRoute = { asset: usdcAddress, origin: 999, destination: 42161 };
      await expect(adapter.send(sender, recipient, amount, invalidRoute)).rejects.toThrow(
        'Origin chain 999 not supported by CCIP'
      );
    });

    it('includes effectiveAmount on send transaction', async () => {
      const txs = await adapter.send(sender, recipient, amount, evmToEvmRoute);
      const sendTx = txs.find(tx => tx.memo === RebalanceTransactionMemo.Rebalance);
      expect(sendTx?.effectiveAmount).toBe(amount);
    });
  });

  describe('readyOnDestination', () => {
    it('returns false if origin transaction is not successful', async () => {
      const failedReceipt = { ...mockReceipt, status: 'reverted' };
      const ready = await adapter.readyOnDestination(amount, evmToEvmRoute, failedReceipt);
      expect(ready).toBe(false);
    });

    it('returns true when CCIP status is SUCCESS', async () => {
      mockCcipClient.getTransferStatus.mockResolvedValue(2); // Success
      const ready = await adapter.readyOnDestination(amount, evmToEvmRoute, mockReceipt);
      expect(ready).toBe(true);
    });

    it('returns false when CCIP status is PENDING', async () => {
      mockCcipClient.getTransferStatus.mockResolvedValue(1); // InProgress
      const ready = await adapter.readyOnDestination(amount, evmToEvmRoute, mockReceipt);
      expect(ready).toBe(false);
    });

    it('returns false when CCIP status is null', async () => {
      mockCcipClient.getTransferStatus.mockResolvedValue(null);
      const ready = await adapter.readyOnDestination(amount, evmToEvmRoute, mockReceipt);
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
    it('returns PENDING when status is null', async () => {
      mockCcipClient.getTransferStatus.mockResolvedValue(null);
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('PENDING');
    });

    it('returns SUCCESS when status is 2', async () => {
      mockCcipClient.getTransferStatus.mockResolvedValue(2);
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('SUCCESS');
    });

    it('returns FAILURE when status is 3', async () => {
      mockCcipClient.getTransferStatus.mockResolvedValue(3);
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('FAILURE');
    });

    it('returns PENDING on SDK error', async () => {
      mockCcipClient.getTransferStatus.mockRejectedValue(new Error('Network error'));
      const status = await adapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('PENDING');
      expect(status.message).toContain('Error checking status');
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

