import { stub, createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import { BigNumber, providers } from 'ethers';
import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { LoggingContext, TransactionSubmissionType, WalletType, TransactionRequest, WalletConfig } from '@mark/core';
import { submitTransactionWithLogging } from '../../src/helpers/transactions';
import * as zodiacHelpers from '../../src/helpers/zodiac';
import { expect } from '../globalTestHook';

describe('submitTransactionWithLogging', () => {
  let mockDeps: {
    chainService: SinonStubbedInstance<ChainService>;
    logger: SinonStubbedInstance<Logger>;
  };
  let mockTxRequest: TransactionRequest;
  let mockZodiacConfig: WalletConfig;
  let mockContext: LoggingContext;
  let wrapTransactionWithZodiacStub: SinonStub;

  const MOCK_CHAIN_ID = 1;
  const MOCK_TX_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  beforeEach(() => {
    // Initialize shared stubs
    mockDeps = {
      chainService: createStubInstance(ChainService),
      logger: createStubInstance(Logger),
    };

    // Initialize common test data
    mockTxRequest = {
      to: '0xabc4567890123456789012345678901234567890',
      data: '0x',
      value: '0',
      chainId: MOCK_CHAIN_ID,
      from: '0x1234567890123456789012345678901234567890',
    };

    mockZodiacConfig = {
      walletType: WalletType.EOA,
    };

    mockContext = {
      invoiceId: 'test-invoice',
      intentId: 'test-intent',
    };

    // Stub wrapTransactionWithZodiac
    wrapTransactionWithZodiacStub = stub(zodiacHelpers, 'wrapTransactionWithZodiac').resolves(mockTxRequest);
  });

  afterEach(() => {
    wrapTransactionWithZodiacStub.restore();
  });

  describe('EOA Transactions', () => {
    it('should successfully submit an EOA transaction', async () => {
      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      const result = await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: mockTxRequest,
        zodiacConfig: mockZodiacConfig,
        context: mockContext,
      });

      expect(result).to.deep.equal({
        submissionType: TransactionSubmissionType.Onchain,
        hash: MOCK_TX_HASH,
        receipt: mockReceipt,
      });

      // Verify logging
      expect(mockDeps.logger.info.calledWith('Submitting transaction')).to.be.true;
      expect(mockDeps.logger.info.calledWith('Transaction submitted successfully')).to.be.true;
    });

    it('should handle EOA transaction failure', async () => {
      const error = new Error('EOA transaction failed');
      (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(error);

      await expect(
        submitTransactionWithLogging({
          chainService: mockDeps.chainService,
          logger: mockDeps.logger,
          chainId: MOCK_CHAIN_ID.toString(),
          txRequest: mockTxRequest,
          zodiacConfig: mockZodiacConfig,
          context: mockContext,
        }),
      ).to.be.rejectedWith(error);

      // Verify error logging
      expect(mockDeps.logger.error.calledWith('Transaction submission failed')).to.be.true;
    });
  });

  describe('Zodiac Transactions', () => {
    beforeEach(() => {
      mockZodiacConfig = {
        walletType: WalletType.Zodiac,
        safeAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        moduleAddress: '0x9876543210987654321098765432109876543210' as `0x${string}`,
        roleKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`,
      };

      wrapTransactionWithZodiacStub.resolves({
        to: mockZodiacConfig.moduleAddress,
        data: '0xabc123',
        value: '0',
        from: mockTxRequest.from,
        chainId: mockTxRequest.chainId,
      });
    });

    it('should successfully submit a zodiac transaction', async () => {
      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      const result = await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: mockTxRequest,
        zodiacConfig: mockZodiacConfig,
        context: mockContext,
      });

      expect(result).to.deep.equal({
        submissionType: TransactionSubmissionType.Onchain,
        hash: MOCK_TX_HASH,
        receipt: mockReceipt,
      });

      // Verify logging
      expect(mockDeps.logger.info.calledWith('Submitting transaction')).to.be.true;
      expect(mockDeps.logger.info.calledWith('Transaction submitted successfully')).to.be.true;

      // Verify that the transaction was wrapped with Zodiac
      expect(wrapTransactionWithZodiacStub.calledOnce).to.be.true;
      expect(wrapTransactionWithZodiacStub.calledWith({ ...mockTxRequest, chainId: MOCK_CHAIN_ID }, mockZodiacConfig))
        .to.be.true;
    });

    it('should handle zodiac transaction failure', async () => {
      const error = new Error('Zodiac transaction failed');
      (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(error);

      await expect(
        submitTransactionWithLogging({
          chainService: mockDeps.chainService,
          logger: mockDeps.logger,
          chainId: MOCK_CHAIN_ID.toString(),
          txRequest: mockTxRequest,
          zodiacConfig: mockZodiacConfig,
          context: mockContext,
        }),
      ).to.be.rejectedWith(error);

      // Verify error logging
      expect(mockDeps.logger.error.calledWith('Transaction submission failed')).to.be.true;
    });

    it('should include zodiac-specific fields in logs', async () => {
      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: mockTxRequest,
        zodiacConfig: mockZodiacConfig,
        context: mockContext,
      });

      // Check that logging includes zodiac information
      const submitCall = mockDeps.logger.info.getCall(0);
      expect(submitCall).to.exist;
      expect(submitCall?.args[1]).to.deep.include({
        chainId: MOCK_CHAIN_ID.toString(),
        walletType: WalletType.Zodiac,
        originalTo: mockTxRequest.to,
      });

      const successCall = mockDeps.logger.info.getCall(1);
      expect(successCall).to.exist;
      expect(successCall?.args[1]).to.deep.include({
        chainId: MOCK_CHAIN_ID.toString(),
        transactionHash: MOCK_TX_HASH,
        walletType: WalletType.Zodiac,
      });
    });
  });

  describe('Value handling', () => {
    it('should handle transactions with undefined value', async () => {
      const txWithoutValue = {
        ...mockTxRequest,
        value: undefined,
      };

      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: txWithoutValue,
        zodiacConfig: mockZodiacConfig,
        context: mockContext,
      });

      // Verify value is logged as '0'
      const submitCall = mockDeps.logger.info.getCall(0);
      expect(submitCall).to.exist;
      expect(submitCall?.args[1]?.value).to.equal('0');
    });

    it('should handle transactions with string value', async () => {
      const txWithStringValue = {
        ...mockTxRequest,
        value: '1000000000000000000', // 1 ETH in wei
      };

      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      // For this test, make the stub return the input transaction to preserve the value
      wrapTransactionWithZodiacStub.resolves(txWithStringValue);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: txWithStringValue,
        zodiacConfig: mockZodiacConfig,
        context: mockContext,
      });

      // Verify value is logged correctly
      const submitCall = mockDeps.logger.info.getCall(0);
      expect(submitCall).to.exist;
      expect(submitCall?.args[1]?.value).to.equal('1000000000000000000');
    });

    it('should handle transactions with bigint value', async () => {
      const txWithBigIntValue = {
        ...mockTxRequest,
        value: '2000000000000000000', // 2 ETH in wei as string (bigint converted)
      };

      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      // For this test, make the stub return a transaction with value.toString()
      wrapTransactionWithZodiacStub.resolves({
        ...txWithBigIntValue,
        value: '2000000000000000000',
      });

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: txWithBigIntValue,
        zodiacConfig: mockZodiacConfig,
        context: mockContext,
      });

      // Verify value is logged as string
      const submitCall = mockDeps.logger.info.getCall(0);
      expect(submitCall).to.exist;
      expect(submitCall?.args[1]?.value).to.equal('2000000000000000000');
    });
  });

  describe('Context handling', () => {
    it('should include context in all log messages', async () => {
      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      const customContext = {
        requestId: 'req-123',
        invoiceId: 'inv-456',
        customField: 'custom-value',
      };

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: mockTxRequest,
        zodiacConfig: mockZodiacConfig,
        context: customContext,
      });

      // Verify context is included in logs
      const submitCall = mockDeps.logger.info.getCall(0);
      expect(submitCall).to.exist;
      expect(submitCall?.args[1]).to.include(customContext);

      const successCall = mockDeps.logger.info.getCall(1);
      expect(successCall).to.exist;
      expect(successCall?.args[1]).to.include(customContext);
    });

    it('should handle empty context', async () => {
      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: BigNumber.from('100000'),
        status: 1,
      } as providers.TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: mockTxRequest,
        zodiacConfig: mockZodiacConfig,
        // No context provided
      });

      // Should not throw and should still log
      expect(mockDeps.logger.info.calledWith('Submitting transaction')).to.be.true;
      expect(mockDeps.logger.info.calledWith('Transaction submitted successfully')).to.be.true;
    });
  });

  describe('Error handling', () => {
    it('should include error details in logs', async () => {
      const error = new Error('Network error');
      (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(error);

      await expect(
        submitTransactionWithLogging({
          chainService: mockDeps.chainService,
          logger: mockDeps.logger,
          chainId: MOCK_CHAIN_ID.toString(),
          txRequest: mockTxRequest,
          zodiacConfig: mockZodiacConfig,
          context: mockContext,
        }),
      ).to.be.rejectedWith(error);

      // Verify error logging
      const errorCall = mockDeps.logger.error.getCall(0);
      expect(errorCall).to.exist;
      expect(errorCall?.args[0]).to.equal('Transaction submission failed');
      expect(errorCall?.args[1]).to.include({
        ...mockContext,
        chainId: MOCK_CHAIN_ID.toString(),
        error,
        walletType: WalletType.EOA,
      });
    });
  });
});
