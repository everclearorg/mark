/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import { ChainConfiguration, RebalanceRoute, fromEnv } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import {
  createPublicClient,
  createWalletClient,
  http,
  Address,
  TransactionReceipt,
  defineChain,
  erc20Abi,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CowSwapBridgeAdapter } from '../../../src/adapters/cowswap/cowswap';
import { USDC_USDT_PAIRS, COWSWAP_VAULT_RELAYER_ADDRESSES, SUPPORTED_NETWORKS } from '../../../src/adapters/cowswap/types';
import { OrderBookApi, SupportedChainId, COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS } from '@cowprotocol/cow-sdk';

// Mock the external dependencies
jest.mock('viem');
jest.mock('viem/accounts');
jest.mock('@mark/logger');
jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core') as any;
  return {
    ...actual,
    fromEnv: jest.fn(),
  };
});
jest.mock('@cowprotocol/cow-sdk', () => ({
  OrderBookApi: jest.fn(),
  SupportedChainId: {
    MAINNET: 1,
    GNOSIS_CHAIN: 100,
    POLYGON: 137,
    ARBITRUM_ONE: 42161,
    BASE: 8453,
    SEPOLIA: 11155111,
  },
  SigningScheme: {
    EIP712: 'eip712',
  },
  OrderKind: {
    SELL: 'sell',
    BUY: 'buy',
  },
  OrderQuoteSideKindSell: {
    SELL: 'sell',
  },
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS: {
    1: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    100: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    137: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    42161: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    8453: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    11155111: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  },
}));

// Test adapter that exposes private methods for testing
class TestCowSwapBridgeAdapter extends CowSwapBridgeAdapter {
  // Access private methods through any cast
  public testValidateSameChainSwap(route: RebalanceRoute): void {
    return (this as any).validateSameChainSwap(route);
  }

  public testDetermineSwapDirection(route: RebalanceRoute): { sellToken: string; buyToken: string } {
    return (this as any).determineSwapDirection(route);
  }

  public testGetOrderBookApi(chainId: number): OrderBookApi {
    return (this as any).getOrderBookApi(chainId);
  }

  public testMapChainIdToSupportedChainId(chainId: number): SupportedChainId | null {
    return (this as any).mapChainIdToSupportedChainId(chainId);
  }

  public async testGetWalletContext(chainId: number): Promise<any> {
    return (this as any).getWalletContext(chainId);
  }

  public async testEnsureTokenApproval(
    chainId: number,
    tokenAddress: Address,
    ownerAddress: Address,
    requiredAmount: bigint,
  ): Promise<void> {
    return (this as any).ensureTokenApproval(chainId, tokenAddress, ownerAddress, requiredAmount);
  }

  public async testWaitForOrderFulfillment(orderBookApi: OrderBookApi, orderUid: string): Promise<any> {
    return (this as any).waitForOrderFulfillment(orderBookApi, orderUid);
  }

  public testHandleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    (this as any).handleError(error, context, metadata);
    throw new Error('Should not reach here');
  }

  public testNormalizePrivateKey(key: string): `0x${string}` {
    return (this as any).normalizePrivateKey(key);
  }

  public async testResolvePrivateKey(chainId: number): Promise<`0x${string}`> {
    return (this as any).resolvePrivateKey(chainId);
  }
}

// Mock the Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

// Mock data for testing
const mockPrivateKey = '0x' + '1'.repeat(64);
const mockAccount = {
  address: '0x' + 'a'.repeat(40) as Address,
} as any;

const mockChains: Record<string, ChainConfiguration> = {
  '1': {
    providers: ['https://eth-mainnet.example.com'],
    assets: [],
    invoiceAge: 3600,
    gasThreshold: '100000000000',
    privateKey: mockPrivateKey,
    deployments: {
      everclear: '0xEverclearAddress',
      permit2: '0xPermit2Address',
      multicall3: '0xMulticall3Address',
    },
  },
  '42161': {
    providers: ['https://arb-mainnet.example.com'],
    assets: [],
    invoiceAge: 3600,
    gasThreshold: '100000000000',
    privateKey: mockPrivateKey,
    deployments: {
      everclear: '0xEverclearAddress',
      permit2: '0xPermit2Address',
      multicall3: '0xMulticall3Address',
    },
  },
  '8453': {
    providers: ['https://base-mainnet.example.com'],
    assets: [],
    invoiceAge: 3600,
    gasThreshold: '100000000000',
    privateKey: mockPrivateKey,
    deployments: {
      everclear: '0xEverclearAddress',
      permit2: '0xPermit2Address',
      multicall3: '0xMulticall3Address',
    },
  },
};

const mockOrderBookApi = {
  getQuote: jest.fn(),
  sendOrder: jest.fn(),
  getOrder: jest.fn(),
} as unknown as jest.Mocked<OrderBookApi>;

const mockPublicClient = {
  readContract: jest.fn(),
  waitForTransactionReceipt: jest.fn(),
  getTransactionReceipt: jest.fn(),
} as any;

const mockWalletClient = {
  signTypedData: jest.fn(),
  writeContract: jest.fn(),
} as any;

const mockChain = defineChain({
  id: 1,
  name: 'chain-1',
  network: 'chain-1',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://eth-mainnet.example.com'] },
    public: { http: ['https://eth-mainnet.example.com'] },
  },
});

describe('CowSwapBridgeAdapter', () => {
  let adapter: TestCowSwapBridgeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock viem functions
    (createPublicClient as jest.Mock).mockReturnValue(mockPublicClient);
    (createWalletClient as jest.Mock).mockReturnValue(mockWalletClient);
    (http as jest.Mock).mockReturnValue({});
    (privateKeyToAccount as jest.Mock).mockReturnValue(mockAccount);
    (defineChain as jest.Mock).mockReturnValue(mockChain);

    // Mock OrderBookApi
    (OrderBookApi as jest.Mock).mockImplementation(() => mockOrderBookApi);

    // Mock fromEnv
    (fromEnv as jest.Mock<any>).mockResolvedValue(null);

    // Reset process.env
    delete process.env.PRIVATE_KEY;
    delete process.env.WEB3_SIGNER_PRIVATE_KEY;

    adapter = new TestCowSwapBridgeAdapter(mockChains, mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with chains and logger', () => {
      expect(adapter).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith('Initializing CowSwapBridgeAdapter with production setup');
    });
  });

  describe('type', () => {
    it('should return cowswap as the bridge type', () => {
      expect(adapter.type()).toBe('cowswap');
    });
  });

  describe('normalizePrivateKey', () => {
    it('should add 0x prefix if missing', () => {
      const result = adapter.testNormalizePrivateKey('1'.repeat(64));
      expect(result).toBe('0x' + '1'.repeat(64));
    });

    it('should keep 0x prefix if present', () => {
      const result = adapter.testNormalizePrivateKey('0x' + '1'.repeat(64));
      expect(result).toBe('0x' + '1'.repeat(64));
    });
  });

  describe('resolvePrivateKey', () => {
    it('should resolve from chain config', async () => {
      const result = await adapter.testResolvePrivateKey(1);
      expect(result).toBe(mockPrivateKey);
    });

    it('should resolve from PRIVATE_KEY env var', async () => {
      process.env.PRIVATE_KEY = '0x' + '2'.repeat(64);
      const newAdapter = new TestCowSwapBridgeAdapter(
        {
          '1': {
            ...mockChains['1'],
            privateKey: undefined,
          },
        },
        mockLogger,
      );
      const result = await newAdapter.testResolvePrivateKey(1);
      expect(result).toBe('0x' + '2'.repeat(64));
    });

    it('should resolve from WEB3_SIGNER_PRIVATE_KEY env var', async () => {
      process.env.WEB3_SIGNER_PRIVATE_KEY = '0x' + '3'.repeat(64);
      const newAdapter = new TestCowSwapBridgeAdapter(
        {
          '1': {
            ...mockChains['1'],
            privateKey: undefined,
          },
        },
        mockLogger,
      );
      const result = await newAdapter.testResolvePrivateKey(1);
      expect(result).toBe('0x' + '3'.repeat(64));
    });

    it('should resolve from SSM via fromEnv', async () => {
      (fromEnv as jest.Mock<any>).mockResolvedValue('0x' + '4'.repeat(64));
      const newAdapter = new TestCowSwapBridgeAdapter(
        {
          '1': {
            ...mockChains['1'],
            privateKey: undefined,
          },
        },
        mockLogger,
      );
      const result = await newAdapter.testResolvePrivateKey(1);
      expect(result).toBe('0x' + '4'.repeat(64));
    });

    it('should throw error if no private key found', async () => {
      (fromEnv as jest.Mock<any>).mockResolvedValue(null);
      const newAdapter = new TestCowSwapBridgeAdapter(
        {
          '1': {
            ...mockChains['1'],
            privateKey: undefined,
          },
        },
        mockLogger,
      );
      await expect(newAdapter.testResolvePrivateKey(1)).rejects.toThrow('CowSwap adapter requires a private key');
    });
  });

  describe('mapChainIdToSupportedChainId', () => {
    it('should map mainnet chain ID', () => {
      expect(adapter.testMapChainIdToSupportedChainId(1)).toBe(SupportedChainId.MAINNET);
    });

    it('should map gnosis chain ID', () => {
      expect(adapter.testMapChainIdToSupportedChainId(100)).toBe(SupportedChainId.GNOSIS_CHAIN);
    });

    it('should map polygon chain ID', () => {
      expect(adapter.testMapChainIdToSupportedChainId(137)).toBe(SupportedChainId.POLYGON);
    });

    it('should map arbitrum chain ID', () => {
      expect(adapter.testMapChainIdToSupportedChainId(42161)).toBe(SupportedChainId.ARBITRUM_ONE);
    });

    it('should map base chain ID', () => {
      expect(adapter.testMapChainIdToSupportedChainId(8453)).toBe(SupportedChainId.BASE);
    });

    it('should map sepolia chain ID', () => {
      expect(adapter.testMapChainIdToSupportedChainId(11155111)).toBe(SupportedChainId.SEPOLIA);
    });

    it('should return null for unsupported chain ID', () => {
      expect(adapter.testMapChainIdToSupportedChainId(999)).toBeNull();
    });
  });

  describe('getOrderBookApi', () => {
    it('should create and cache OrderBookApi for supported chain', () => {
      const api = adapter.testGetOrderBookApi(1);
      expect(OrderBookApi).toHaveBeenCalledWith({ chainId: SupportedChainId.MAINNET });
      expect(api).toBe(mockOrderBookApi);
    });

    it('should return cached OrderBookApi on second call', () => {
      const api1 = adapter.testGetOrderBookApi(1);
      const api2 = adapter.testGetOrderBookApi(1);
      expect(api1).toBe(api2);
      expect(OrderBookApi).toHaveBeenCalledTimes(1);
    });

    it('should throw error for unsupported chain', () => {
      expect(() => adapter.testGetOrderBookApi(999)).toThrow('Chain 999 is not supported');
    });
  });

  describe('validateSameChainSwap', () => {
    it('should validate same-chain swap with USDC', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      expect(() => adapter.testValidateSameChainSwap(route)).not.toThrow();
    });

    it('should validate same-chain swap with USDT', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdt,
      };
      expect(() => adapter.testValidateSameChainSwap(route)).not.toThrow();
    });

    it('should throw error for cross-chain swap', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      expect(() => adapter.testValidateSameChainSwap(route)).toThrow('CowSwap adapter only supports same-chain swaps');
    });

    it('should throw error for unsupported chain', () => {
      const route: RebalanceRoute = {
        origin: 999,
        destination: 999,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      expect(() => adapter.testValidateSameChainSwap(route)).toThrow('Chain 999 is not supported');
    });

    it('should throw error for invalid asset', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: '0xInvalidAsset',
      };
      expect(() => adapter.testValidateSameChainSwap(route)).toThrow('CowSwap adapter only supports USDC/USDT swaps');
    });

    it('should validate swapOutputAsset when provided', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
        swapOutputAsset: USDC_USDT_PAIRS[1].usdt,
      };
      expect(() => adapter.testValidateSameChainSwap(route)).not.toThrow();
    });

    it('should throw error for invalid swapOutputAsset', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
        swapOutputAsset: '0xInvalidAsset',
      };
      expect(() => adapter.testValidateSameChainSwap(route)).toThrow('CowSwap adapter only supports USDC/USDT swaps');
    });

    it('should throw error if asset and swapOutputAsset are the same', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
        swapOutputAsset: USDC_USDT_PAIRS[1].usdc,
      };
      expect(() => adapter.testValidateSameChainSwap(route)).toThrow('CowSwap adapter requires different assets');
    });
  });

  describe('determineSwapDirection', () => {
    it('should determine USDC to USDT swap', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const result = adapter.testDetermineSwapDirection(route);
      expect(result.sellToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdc.toLowerCase());
      expect(result.buyToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdt.toLowerCase());
    });

    it('should determine USDT to USDC swap', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdt,
      };
      const result = adapter.testDetermineSwapDirection(route);
      expect(result.sellToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdt.toLowerCase());
      expect(result.buyToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdc.toLowerCase());
    });

    it('should use swapOutputAsset when provided', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
        swapOutputAsset: USDC_USDT_PAIRS[1].usdt,
      };
      const result = adapter.testDetermineSwapDirection(route);
      expect(result.sellToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdc.toLowerCase());
      expect(result.buyToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdt.toLowerCase());
    });

    it('should throw error for invalid asset', () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: '0xInvalidAsset',
      };
      expect(() => adapter.testDetermineSwapDirection(route)).toThrow('Invalid asset for USDC/USDT swap');
    });
  });

  describe('getReceivedAmount', () => {
    it('should get received amount from quote', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const amount = '1000000';

      (mockOrderBookApi.getQuote as jest.Mock<any>).mockResolvedValue({
        quote: {
          sellAmount: amount,
          buyAmount: '999000',
          feeAmount: '1000',
        },
      });

      const result = await adapter.getReceivedAmount(amount, route);
      expect(result).toBe('999000');
      expect(mockOrderBookApi.getQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          sellToken: USDC_USDT_PAIRS[1].usdc,
          buyToken: USDC_USDT_PAIRS[1].usdt,
          from: zeroAddress,
          receiver: zeroAddress,
          sellAmountBeforeFee: amount,
        }),
      );
    });

    it('should handle errors', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const error = new Error('Quote failed');
      (mockOrderBookApi.getQuote as jest.Mock<any>).mockRejectedValue(error);

      await expect(adapter.getReceivedAmount('1000000', route)).rejects.toThrow('Failed to get received amount');
    });
  });

  describe('ensureTokenApproval', () => {
    const chainId = 1;
    const tokenAddress = USDC_USDT_PAIRS[1].usdc as Address;
    const ownerAddress = mockAccount.address as Address;
    const vaultRelayerAddress = COWSWAP_VAULT_RELAYER_ADDRESSES[chainId] as Address;
    const requiredAmount = BigInt('1000000');

    beforeEach(() => {
      (mockPublicClient.readContract as jest.Mock<any>).mockResolvedValue(0n);
      (mockWalletClient.writeContract as jest.Mock<any>).mockResolvedValue('0xtxhash');
      (mockPublicClient.waitForTransactionReceipt as jest.Mock<any>).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
      });
    });

    it('should skip approval if allowance is sufficient', async () => {
      (mockPublicClient.readContract as jest.Mock<any>).mockResolvedValue(requiredAmount * 2n);

      await adapter.testEnsureTokenApproval(chainId, tokenAddress, ownerAddress, requiredAmount);

      expect(mockPublicClient.readContract).toHaveBeenCalledWith({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [ownerAddress, vaultRelayerAddress],
      });
      expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
    });

    it('should approve token if allowance is insufficient', async () => {
      (mockPublicClient.readContract as jest.Mock<any>)
        .mockResolvedValueOnce(0n) // Initial check
        .mockResolvedValueOnce(requiredAmount); // Verification

      await adapter.testEnsureTokenApproval(chainId, tokenAddress, ownerAddress, requiredAmount);

      expect(mockWalletClient.writeContract).toHaveBeenCalledWith({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vaultRelayerAddress, requiredAmount],
        account: null,
        chain: null,
      });
    });

    it('should handle USDT zero approval requirement', async () => {
      const usdtAddress = USDC_USDT_PAIRS[1].usdt as Address;
      (mockPublicClient.readContract as jest.Mock<any>)
        .mockResolvedValueOnce(1000n) // Initial check - non-zero current allowance
        .mockResolvedValueOnce(requiredAmount); // Final verification after both approvals

      (mockPublicClient.waitForTransactionReceipt as jest.Mock<any>)
        .mockResolvedValueOnce({
          status: 'success',
          blockNumber: 1n,
        }) // Zero approval receipt
        .mockResolvedValueOnce({
          status: 'success',
          blockNumber: 2n,
        }); // Final approval receipt

      await adapter.testEnsureTokenApproval(chainId, usdtAddress, ownerAddress, requiredAmount);

      // Should call writeContract twice: once for zero, once for required amount
      expect(mockWalletClient.writeContract).toHaveBeenCalledTimes(2);
      expect(mockWalletClient.writeContract).toHaveBeenNthCalledWith(1, {
        address: usdtAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vaultRelayerAddress, 0n],
        account: null,
        chain: null,
      });
    });

    it('should throw error if approval transaction fails', async () => {
      (mockPublicClient.readContract as jest.Mock<any>).mockResolvedValue(0n);
      (mockPublicClient.waitForTransactionReceipt as jest.Mock<any>).mockResolvedValue({
        status: 'reverted',
        blockNumber: 1n,
      });

      await expect(adapter.testEnsureTokenApproval(chainId, tokenAddress, ownerAddress, requiredAmount)).rejects.toThrow(
        'Approval transaction failed',
      );
    });

    it('should throw error if verification fails', async () => {
      (mockPublicClient.readContract as jest.Mock<any>)
        .mockResolvedValueOnce(0n) // Initial check
        .mockResolvedValueOnce(0n); // Verification after approval (should be requiredAmount but is 0n)

      (mockPublicClient.waitForTransactionReceipt as jest.Mock<any>).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
      });

      await expect(adapter.testEnsureTokenApproval(chainId, tokenAddress, ownerAddress, requiredAmount)).rejects.toThrow(
        'Approval verification failed',
      );
    });

    it('should throw error if vault relayer address not found', async () => {
      await expect(adapter.testEnsureTokenApproval(999, tokenAddress, ownerAddress, requiredAmount)).rejects.toThrow(
        'VaultRelayer address not found',
      );
    });
  });

  describe('waitForOrderFulfillment', () => {
    it('should return fulfilled order', async () => {
      const orderUid = '0xorder123';
      (mockOrderBookApi.getOrder as jest.Mock<any>).mockResolvedValue({
        uid: orderUid,
        status: 'fulfilled',
        executedSellAmount: '1000000',
        executedBuyAmount: '999000',
      });

      const result = await adapter.testWaitForOrderFulfillment(mockOrderBookApi, orderUid);
      expect(result.status).toBe('fulfilled');
    });

    it('should return expired order', async () => {
      const orderUid = '0xorder123';
      (mockOrderBookApi.getOrder as jest.Mock<any>).mockResolvedValue({
        uid: orderUid,
        status: 'expired',
      });

      const result = await adapter.testWaitForOrderFulfillment(mockOrderBookApi, orderUid);
      expect(result.status).toBe('expired');
    });
  });

  describe('executeSwap', () => {
    const route: RebalanceRoute = {
      origin: 1,
      destination: 1,
      asset: USDC_USDT_PAIRS[1].usdc,
    };
    const sender = mockAccount.address;
    const recipient = '0x' + 'b'.repeat(40);
    const amount = '1000000';

    beforeEach(() => {
      (mockOrderBookApi.getQuote as jest.Mock<any>).mockResolvedValue({
        quote: {
          sellToken: USDC_USDT_PAIRS[1].usdc,
          buyToken: USDC_USDT_PAIRS[1].usdt,
          sellAmount: amount,
          buyAmount: '999000',
          feeAmount: '1000',
          validTo: Math.floor(Date.now() / 1000) + 3600,
          appData: '0x' + '0'.repeat(64),
          partiallyFillable: false,
          sellTokenBalance: 'erc20',
          buyTokenBalance: 'erc20',
          kind: 'sell',
        },
      });
      (mockOrderBookApi.sendOrder as jest.Mock<any>).mockResolvedValue('0xorder123');
      (mockOrderBookApi.getOrder as jest.Mock<any>).mockResolvedValue({
        uid: '0xorder123',
        status: 'fulfilled',
        executedSellAmount: amount,
        executedBuyAmount: '999000',
        buyAmount: '999000',
      });
      (mockWalletClient.signTypedData as jest.Mock<any>).mockResolvedValue('0xsig');
      
      const totalAmount = BigInt(amount) + BigInt('1000');
      (mockPublicClient.readContract as jest.Mock<any>)
        .mockResolvedValueOnce(totalAmount) // Initial allowance check in ensureTokenApproval
        .mockResolvedValueOnce(totalAmount) // Verification after approval in ensureTokenApproval
        .mockResolvedValueOnce(totalAmount); // Final allowance check before order submission in executeSwap
      
      (mockPublicClient.waitForTransactionReceipt as jest.Mock<any>).mockResolvedValue({
        status: 'success',
        blockNumber: 1n,
      });
    });

    it('should execute swap successfully', async () => {
      const result = await adapter.executeSwap(sender, recipient, amount, route);

      expect(result.orderUid).toBe('0xorder123');
      expect(result.sellToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdc.toLowerCase());
      expect(result.buyToken.toLowerCase()).toBe(USDC_USDT_PAIRS[1].usdt.toLowerCase());
      expect(mockOrderBookApi.sendOrder).toHaveBeenCalled();
    });

    it('should throw error for cross-chain swap', async () => {
      const crossChainRoute: RebalanceRoute = {
        origin: 1,
        destination: 42161,
        asset: USDC_USDT_PAIRS[1].usdc,
      };

      await expect(adapter.executeSwap(sender, recipient, amount, crossChainRoute)).rejects.toThrow(
        'CowSwap executeSwap is only supported for same-chain routes',
      );
    });

    it('should warn if sender does not match account', async () => {
      const differentSender = '0x' + 'c'.repeat(40);
      await adapter.executeSwap(differentSender, recipient, amount, route);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'CowSwap adapter sender does not match configured account, proceeding with configured account',
        expect.objectContaining({
          expectedSender: differentSender,
          accountAddress: mockAccount.address,
        }),
      );
      expect(mockOrderBookApi.sendOrder).toHaveBeenCalled();
    });

    it('should handle order submission error', async () => {
      const error = new Error('Order submission failed');
      (mockOrderBookApi.sendOrder as jest.Mock<any>).mockRejectedValue(error);

      await expect(adapter.executeSwap(sender, recipient, amount, route)).rejects.toThrow();
      // The error gets wrapped in handleError, so check for the wrapped error message
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to execute CowSwap swap',
        expect.objectContaining({
          sender,
          recipient,
          amount,
        }),
      );
    });
  });

  describe('send', () => {
    it('should return empty array and log warning', async () => {
      const result = await adapter.send();
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'CowSwap send() invoked; synchronous swaps do not require pre-signed transactions',
      );
    });
  });

  describe('readyOnDestination', () => {
    it('should return true if transaction is successful', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const receipt: TransactionReceipt = {
        transactionHash: '0xhash',
        status: 'success',
        blockHash: '0xblock',
        blockNumber: 1n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: '0xfrom',
        gasUsed: 0n,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        to: '0xto',
        transactionIndex: 0,
        type: 'eip1559',
      } as TransactionReceipt;

      (mockPublicClient.getTransactionReceipt as jest.Mock<any>).mockResolvedValue({
        status: 'success',
      });

      const result = await adapter.readyOnDestination('1000000', route, receipt);
      expect(result).toBe(true);
    });

    it('should return false if transaction is not successful', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const receipt: TransactionReceipt = {
        transactionHash: '0xhash',
        status: 'success',
        blockHash: '0xblock',
        blockNumber: 1n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: '0xfrom',
        gasUsed: 0n,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        to: '0xto',
        transactionIndex: 0,
        type: 'eip1559',
      } as TransactionReceipt;

      (mockPublicClient.getTransactionReceipt as jest.Mock<any>).mockResolvedValue({
        status: 'reverted',
      });

      const result = await adapter.readyOnDestination('1000000', route, receipt);
      expect(result).toBe(false);
    });

    it('should return false if no providers configured', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 999,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const receipt: TransactionReceipt = {
        transactionHash: '0xhash',
        status: 'success',
        blockHash: '0xblock',
        blockNumber: 1n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: '0xfrom',
        gasUsed: 0n,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        to: '0xto',
        transactionIndex: 0,
        type: 'eip1559',
      } as TransactionReceipt;

      const result = await adapter.readyOnDestination('1000000', route, receipt);
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to check if ready on destination',
        expect.objectContaining({
          route: expect.objectContaining({
            destination: 999,
          }),
        }),
      );
    });

    it('should handle errors gracefully', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const receipt: TransactionReceipt = {
        transactionHash: '0xhash',
        status: 'success',
        blockHash: '0xblock',
        blockNumber: 1n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: '0xfrom',
        gasUsed: 0n,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        to: '0xto',
        transactionIndex: 0,
        type: 'eip1559',
      } as TransactionReceipt;

      (mockPublicClient.getTransactionReceipt as jest.Mock<any>).mockRejectedValue(new Error('Network error'));

      const result = await adapter.readyOnDestination('1000000', route, receipt);
      expect(result).toBe(false);
    });
  });

  describe('destinationCallback', () => {
    it('should return void and log debug', async () => {
      const route: RebalanceRoute = {
        origin: 1,
        destination: 1,
        asset: USDC_USDT_PAIRS[1].usdc,
      };
      const receipt: TransactionReceipt = {
        transactionHash: '0xhash',
        status: 'success',
        blockHash: '0xblock',
        blockNumber: 1n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: '0xfrom',
        gasUsed: 0n,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        to: '0xto',
        transactionIndex: 0,
        type: 'eip1559',
      } as TransactionReceipt;

      const result = await adapter.destinationCallback(route, receipt);
      expect(result).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'CowSwap destinationCallback invoked - no action required for synchronous swaps',
        expect.objectContaining({
          transactionHash: '0xhash',
          route,
        }),
      );
    });
  });

  describe('handleError', () => {
    it('should handle error with response', () => {
      const error: any = {
        message: 'Test error',
        response: {
          status: 400,
          statusText: 'Bad Request',
        },
      };

      expect(() => adapter.testHandleError(error, 'test operation', {})).toThrow('Failed to test operation: Test error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to test operation',
        expect.objectContaining({
          cowSwapStatus: 400,
          cowSwapStatusText: 'Bad Request',
        }),
      );
    });

    it('should handle error with body', () => {
      const error: any = {
        message: 'Test error',
        body: 'Error body',
      };

      expect(() => adapter.testHandleError(error, 'test operation', {})).toThrow('Failed to test operation: Test error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to test operation',
        expect.objectContaining({
          cowSwapBody: 'Error body',
        }),
      );
    });

    it('should handle error without message', () => {
      const error = {};

      expect(() => adapter.testHandleError(error, 'test operation', {})).toThrow('Failed to test operation: Unknown error');
    });
  });
});

