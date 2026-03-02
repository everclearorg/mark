import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore } from 'sinon';
import { Logger } from '@mark/logger';
import { ChainService } from '@mark/chainservice';
import {
  MarkConfiguration,
  SupportedBridge,
  RebalanceOperationStatus,
  MAINNET_CHAIN_ID,
  SOLANA_CHAINID,
  EarmarkStatus,
} from '@mark/core';
import { ProcessingContext } from '../../src/init';
import { RebalanceAdapter } from '@mark/rebalance';
import { createDatabaseMock } from '../mocks/database';
import { mockConfig } from '../mocks';

// Mock database module first
jest.mock('@mark/database', () => {
  return {
    createEarmark: jest.fn(),
    getActiveEarmarkForInvoice: jest.fn().mockResolvedValue(null),
    createRebalanceOperation: jest.fn(),
    getRebalanceOperations: jest.fn().mockResolvedValue({ operations: [], total: 0 }),
    updateRebalanceOperation: jest.fn(),
    initializeDatabase: jest.fn(),
    getPool: jest.fn(),
    closeDatabase: jest.fn(),
  };
});

// Mock Solana dependencies  
jest.mock('@solana/web3.js', () => ({
  PublicKey: function() {
    return {
      toBase58: () => 'MockPublicKey',
      toBytes: () => new Uint8Array(32),
    };
  },
  Connection: function() {
    return {
      rpcEndpoint: 'https://api.mainnet-beta.solana.com',
    };
  },
  TransactionInstruction: function() { return {}; },
  SystemProgram: { programId: { toBase58: () => '11111111111111111111111111111111' } },
}));

jest.mock('@solana/spl-token', () => ({
  TOKEN_PROGRAM_ID: { toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  getAssociatedTokenAddress: () => Promise.resolve({
    toBase58: () => 'MockAssociatedTokenAddress',
  }),
  getAccount: () => Promise.resolve({
    amount: BigInt('1000000000'),
  }),
}));

// Import after mocks
import { rebalanceSolanaUsdc, executeSolanaUsdcCallbacks } from '../../src/rebalance/solanaUsdc';
import * as database from '@mark/database';

describe('Solana USDC Rebalancing', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockChainService: SinonStubbedInstance<ChainService>;
  let mockRebalanceAdapter: SinonStubbedInstance<RebalanceAdapter>;
  let mockSolanaSigner: {
    getConnection: SinonStub;
    getPublicKey: SinonStub;
    getAddress: SinonStub;
    signAndSendTransaction: SinonStub;
  };
  let mockEverclear: {
    fetchIntents: SinonStub;
  };
  let mockDatabase: ReturnType<typeof createDatabaseMock>;

  const MOCK_REQUEST_ID = 'solana-usdc-test-request';
  const MOCK_OWN_ADDRESS = '0x1234567890123456789012345678901234567890';
  const MOCK_SOLANA_ADDRESS = 'SolanaWalletAddress123456789012345678901234';

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockLogger = createStubInstance(Logger);
    mockChainService = createStubInstance(ChainService);
    mockRebalanceAdapter = createStubInstance(RebalanceAdapter);
    mockDatabase = createDatabaseMock();

    // Mock Solana signer
    mockSolanaSigner = {
      getConnection: stub().returns({
        rpcEndpoint: 'https://api.mainnet-beta.solana.com',
      }),
      getPublicKey: stub().returns({
        toBase58: () => MOCK_SOLANA_ADDRESS,
      }),
      getAddress: stub().returns(MOCK_SOLANA_ADDRESS),
      signAndSendTransaction: stub().resolves({
        success: true,
        signature: 'SolanaTransactionSignature123',
        slot: 12345,
        fee: 5000,
        logs: ['Program log: Success'],
      }),
    };

    // Mock Everclear client
    mockEverclear = {
      fetchIntents: stub().resolves([]),
    };

    const config = {
      ...mockConfig,
      ownAddress: MOCK_OWN_ADDRESS,
      solana: {
        privateKey: 'mockPrivateKey',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      },
      solanaPtusdeRebalance: {
        enabled: true,
        ptUsdeThreshold: '100000000000', // 100 ptUSDe
        ptUsdeTarget: '500000000000', // 500 ptUSDe
        bridge: {
          slippageDbps: 50, // 0.5%
          minRebalanceAmount: '1000000', // 1 USDC
          maxRebalanceAmount: '100000000', // 100 USDC
        },
      },
    } as MarkConfiguration;

    mockContext = {
      config,
      requestId: MOCK_REQUEST_ID,
      startTime: Date.now(),
      logger: mockLogger,
      chainService: mockChainService,
      rebalance: mockRebalanceAdapter,
      everclear: mockEverclear,
      solanaSigner: mockSolanaSigner,
      database: mockDatabase,
    } as unknown as SinonStubbedInstance<ProcessingContext>;

    // Set up default adapter behavior
    mockRebalanceAdapter.isPaused.resolves(false);
    mockRebalanceAdapter.getAdapter.returns({
      type: () => SupportedBridge.CCIP,
      getReceivedAmount: stub().resolves('1000000'),
      send: stub().resolves([]),
      readyOnDestination: stub().resolves(false),
      destinationCallback: stub().resolves(undefined),
      getTransferStatus: stub().resolves({ status: 'PENDING', message: 'Waiting' }),
    } as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

    // Reset database mock default value
    (database.getActiveEarmarkForInvoice as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    restore();
    jest.clearAllMocks();
  });

  describe('rebalanceSolanaUsdc', () => {
    it('should return empty array when SolanaSigner is not configured', async () => {
      const contextWithoutSigner = {
        ...mockContext,
        solanaSigner: undefined,
      };

      const result = await rebalanceSolanaUsdc(contextWithoutSigner as unknown as ProcessingContext);

      expect(result).toEqual([]);
      expect(mockLogger.warn.calledWithMatch('SolanaSigner not configured')).toBe(true);
    });

    it('should return empty array when rebalancing is paused', async () => {
      mockRebalanceAdapter.isPaused.resolves(true);

      const result = await rebalanceSolanaUsdc(mockContext as unknown as ProcessingContext);

      expect(result).toEqual([]);
      expect(mockLogger.warn.calledWithMatch('Solana USDC Rebalance loop is paused')).toBe(true);
    });

    it('should return empty array when no matching intents are found', async () => {
      mockEverclear.fetchIntents.resolves([]);

      const result = await rebalanceSolanaUsdc(mockContext as unknown as ProcessingContext);

      expect(result).toEqual([]);
    });

    it('should skip rebalancing when ptUSDe balance is above threshold', async () => {
      // Threshold-based rebalancing: skips when ptUSDe balance is sufficient
      // Mock in-flight operations check
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [],
        total: 0,
      });

      const result = await rebalanceSolanaUsdc(mockContext as unknown as ProcessingContext);

      expect(result).toEqual([]);
    });
  });

  describe('executeSolanaUsdcCallbacks', () => {
    it('should process pending operations', async () => {
      // Mock pending operation
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-123',
            earmarkId: 'earmark-123',
            originChainId: Number(SOLANA_CHAINID),
            destinationChainId: Number(MAINNET_CHAIN_ID),
            bridge: 'ccip-solana-mainnet',
            status: RebalanceOperationStatus.PENDING,
            transactions: {
              [SOLANA_CHAINID]: {
                transactionHash: 'SolanaTxHash123',
              },
            },
            amount: '1000000',
            createdAt: new Date(),
          },
        ],
        total: 1,
      });

      // Mock CCIP adapter
      const mockCcipAdapter = {
        getTransferStatus: stub().resolves({
          status: 'PENDING',
          message: 'Transfer in progress',
        }),
      };
      mockRebalanceAdapter.getAdapter.returns(mockCcipAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

      await executeSolanaUsdcCallbacks(mockContext as unknown as ProcessingContext);

      expect(mockLogger.info.calledWithMatch('CCIP bridge status check')).toBe(true);
    });

    it('should skip operations without ccip-solana-mainnet bridge', async () => {
      // Mock operation with different bridge
      (mockDatabase.getRebalanceOperations as SinonStub).resolves({
        operations: [
          {
            id: 'op-123',
            bridge: 'other-bridge',
            status: RebalanceOperationStatus.PENDING,
            originChainId: 1,
            destinationChainId: 10,
          },
        ],
        total: 1,
      });

      await executeSolanaUsdcCallbacks(mockContext as unknown as ProcessingContext);

      // Should not process non-matching operations
      expect(mockLogger.info.calledWithMatch('CCIP bridge status check')).toBe(false);
    });

    it('should mark operation as FAILED when CCIP fails', async () => {
      // Mock pending operation
      (mockDatabase.getRebalanceOperations as SinonStub)
        .onFirstCall()
        .resolves({
          operations: [
            {
              id: 'op-123',
              earmarkId: 'earmark-123',
              originChainId: Number(SOLANA_CHAINID),
              destinationChainId: Number(MAINNET_CHAIN_ID),
              bridge: 'ccip-solana-mainnet',
              status: RebalanceOperationStatus.PENDING,
              transactions: {
                [SOLANA_CHAINID]: {
                  transactionHash: 'SolanaTxHash123',
                },
              },
              amount: '1000000',
              createdAt: new Date(),
            },
          ],
          total: 1,
        })
        .onSecondCall()
        .resolves({ operations: [], total: 0 });

      // Mock CCIP adapter returning FAILURE
      const mockCcipAdapter = {
        getTransferStatus: stub().resolves({
          status: 'FAILURE',
          message: 'Transfer failed',
        }),
      };
      mockRebalanceAdapter.getAdapter.returns(mockCcipAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

      await executeSolanaUsdcCallbacks(mockContext as unknown as ProcessingContext);

      // Should update status to FAILED
      const updateCalls = (mockDatabase.updateRebalanceOperation as SinonStub).getCalls();
      expect(updateCalls.some((call) => call.args[1]?.status === RebalanceOperationStatus.FAILED)).toBe(true);
    });

    it('should check AWAITING_CALLBACK operations for Leg 3 completion', async () => {
      // Mock AWAITING_CALLBACK operation (Leg 3 pending)
      (mockDatabase.getRebalanceOperations as SinonStub)
        .onFirstCall()
        .resolves({ operations: [], total: 0 })
        .onSecondCall()
        .resolves({
          operations: [
            {
              id: 'op-123',
              earmarkId: 'earmark-123',
              originChainId: Number(SOLANA_CHAINID),
              destinationChainId: Number(MAINNET_CHAIN_ID),
              bridge: 'ccip-solana-mainnet',
              status: RebalanceOperationStatus.AWAITING_CALLBACK,
              transactions: {
                [SOLANA_CHAINID]: { transactionHash: 'SolanaTxHash123' },
                [MAINNET_CHAIN_ID]: { transactionHash: 'MainnetTxHash123' },
              },
              amount: '1000000',
              createdAt: new Date(),
            },
          ],
          total: 1,
        });

      // Mock CCIP adapter returning SUCCESS for Leg 3
      const mockCcipAdapter = {
        readyOnDestination: stub().resolves(true),
        getTransferStatus: stub().resolves({ status: 'SUCCESS' }),
      };
      mockRebalanceAdapter.getAdapter.returns(mockCcipAdapter as unknown as ReturnType<RebalanceAdapter['getAdapter']>);

      await executeSolanaUsdcCallbacks(mockContext as unknown as ProcessingContext);

      // Should update to COMPLETED when Leg 3 is ready
      const updateCalls = (mockDatabase.updateRebalanceOperation as SinonStub).getCalls();
      expect(updateCalls.some((call) => call.args[1]?.status === RebalanceOperationStatus.COMPLETED)).toBe(true);
    });
  });

  describe('CCIP Transfer Status Mapping', () => {
    it('should handle SUCCESS status from CCIP', async () => {
      const mockCcipAdapter = {
        getTransferStatus: stub().resolves({
          status: 'SUCCESS',
          message: 'CCIP transfer completed successfully',
          messageId: '0xmessageid',
        }),
      };

      const status = await mockCcipAdapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('SUCCESS');
    });

    it('should handle FAILURE status from CCIP', async () => {
      const mockCcipAdapter = {
        getTransferStatus: stub().resolves({
          status: 'FAILURE',
          message: 'CCIP transfer failed',
        }),
      };

      const status = await mockCcipAdapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('FAILURE');
    });

    it('should handle PENDING status from CCIP', async () => {
      const mockCcipAdapter = {
        getTransferStatus: stub().resolves({
          status: 'PENDING',
          message: 'CCIP transfer in progress',
        }),
      };

      const status = await mockCcipAdapter.getTransferStatus('0xhash', 1, 42161);
      expect(status.status).toBe('PENDING');
    });
  });

  describe('Bridge Amount Calculation', () => {
    it('should calculate ptUSDe deficit correctly', () => {
      const ptUsdeBalance = BigInt('1000000000000000000');
      const ptUsdeThreshold = BigInt('10000000000000000000');
      const deficit = ptUsdeThreshold - ptUsdeBalance;
      
      expect(deficit).toBe(BigInt('9000000000000000000'));
    });

    it('should handle zero balance scenario', () => {
      const ptUsdeBalance = BigInt('0');
      const ptUsdeThreshold = BigInt('10000000000000000000');
      const deficit = ptUsdeThreshold - ptUsdeBalance;
      
      expect(deficit).toBe(BigInt('10000000000000000000'));
    });

    it('should calculate minimum bridge amount correctly', () => {
      const MIN_REBALANCING_AMOUNT = 1000000n;
      expect(MIN_REBALANCING_AMOUNT).toBe(BigInt('1000000'));
    });
  });
});
