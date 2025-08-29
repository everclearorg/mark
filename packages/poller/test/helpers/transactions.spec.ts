import { createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { LoggingContext, TransactionSubmissionType, TransactionRequest } from '@mark/core';
import { submitTransactionWithLogging } from '../../src/helpers/transactions';
import { expect } from '../globalTestHook';
import { TransactionReceipt } from 'viem';

describe('submitTransactionWithLogging', () => {
  let mockDeps: {
    chainService: SinonStubbedInstance<ChainService>;
    logger: SinonStubbedInstance<Logger>;
  };
  let mockTxRequest: TransactionRequest;
  let mockContext: LoggingContext;

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
      funcSig: 'transfer(address,uint256)',
    };

    mockContext = {
      invoiceId: 'test-invoice',
      intentId: 'test-intent',
    };
  });

  describe('EOA Transactions', () => {
    it('should successfully submit an EOA transaction', async () => {
      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: 100000n,
        status: 1,
      } as unknown as TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      const result = await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: mockTxRequest,
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
          context: mockContext,
        }),
      ).to.be.rejectedWith(error);

      // Verify error logging
      expect(mockDeps.logger.error.calledWith('Transaction submission failed')).to.be.true;
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
        gasUsed: 100000n,
        status: 1,
      } as unknown as TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: txWithoutValue,
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
        gasUsed: 100000n,
        status: 1,
      } as unknown as TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: txWithStringValue,
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
        gasUsed: 100000n,
        status: 1,
      } as unknown as TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: txWithBigIntValue,
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
        gasUsed: 100000n,
        status: 1,
      } as unknown as TransactionReceipt;

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
        gasUsed: 100000n,
        status: 1,
      } as unknown as TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: mockTxRequest,
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
      });
    });

    it('should handle transaction with bigint value', async () => {
      const txWithBigIntValue = {
        ...mockTxRequest,
        value: BigInt('1000000000000000000'), // 1 ETH as bigint
      };

      const mockReceipt = {
        transactionHash: MOCK_TX_HASH,
        blockNumber: 12345,
        gasUsed: 100000n,
        status: 1,
      } as unknown as TransactionReceipt;

      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);


      await submitTransactionWithLogging({
        chainService: mockDeps.chainService,
        logger: mockDeps.logger,
        chainId: MOCK_CHAIN_ID.toString(),
        txRequest: txWithBigIntValue as any,
        context: mockContext,
      });

      // Verify value is converted to string in logs
      const submitCall = mockDeps.logger.info.getCall(0);
      expect(submitCall).to.exist;
      expect(submitCall?.args[1]?.value).to.equal('1000000000000000000');
    });
  });
});
