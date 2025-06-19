<<<<<<< HEAD
import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance } from 'sinon';
import { submitTransactionWithLogging, TransactionSubmissionParams } from '../../src/helpers/transactions';
import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { ZodiacConfig } from '../../src/helpers/zodiac';
import * as zodiacModule from '../../src/helpers/zodiac';
import { providers } from 'ethers';

describe('submitTransactionWithLogging', () => {
    let mockChainService: SinonStubbedInstance<ChainService>;
    let mockLogger: SinonStubbedInstance<Logger>;
    let wrapTransactionStub: sinon.SinonStub;

    const mockTxRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
        value: 100,
        from: '0x9876543210987654321098765432109876543210',
    };

    const mockReceipt = {
        transactionHash: '0xtxhash123',
        blockNumber: 123,
        status: 1,
    } as providers.TransactionReceipt;

    beforeEach(() => {
        mockChainService = createStubInstance(ChainService);
        mockLogger = createStubInstance(Logger);
        wrapTransactionStub = stub(zodiacModule, 'wrapTransactionWithZodiac');

        // Default behavior - return the transaction unchanged
        wrapTransactionStub.returns(mockTxRequest);
        mockChainService.submitAndMonitor.resolves(mockReceipt);
    });

    afterEach(() => {
        wrapTransactionStub.restore();
    });

    describe('successful transaction submission', () => {
        it('should submit transaction successfully with Zodiac disabled', async () => {
            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: mockTxRequest,
                zodiacConfig,
            };

            const result = await submitTransactionWithLogging(params);

            expect(result).to.deep.equal({
                transactionHash: mockReceipt.transactionHash,
                receipt: mockReceipt,
            });

            expect(wrapTransactionStub.calledOnceWith(mockTxRequest, zodiacConfig)).to.be.true;
            expect(mockChainService.submitAndMonitor.calledOnceWith('1', mockTxRequest)).to.be.true;
            expect(mockLogger.info.calledWith('Submitting transaction')).to.be.true;
            expect(mockLogger.info.calledWith('Transaction submitted successfully')).to.be.true;
        });

        it('should submit transaction successfully with Zodiac enabled', async () => {
            const zodiacConfig: ZodiacConfig = {
                isEnabled: true,
                moduleAddress: '0xrole',
                roleKey: '0xkey',
                safeAddress: '0xsafe',
            };

            const wrappedTx = {
                ...mockTxRequest,
                to: '0xrole', // Zodiac changes the target
            };
            wrapTransactionStub.returns(wrappedTx);

            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: mockTxRequest,
                zodiacConfig,
            };

            const result = await submitTransactionWithLogging(params);

            expect(result).to.deep.equal({
                transactionHash: mockReceipt.transactionHash,
                receipt: mockReceipt,
            });

            expect(wrapTransactionStub.calledOnceWith(mockTxRequest, zodiacConfig)).to.be.true;
            expect(mockChainService.submitAndMonitor.calledOnceWith('1', wrappedTx)).to.be.true;

            // Verify logging includes Zodiac information
            const logCalls = mockLogger.info.getCalls();
            const submitLogCall = logCalls.find(call => call.args[0] === 'Submitting transaction');
            expect(submitLogCall?.args[1]).to.include({
                chainId: '1',
                to: wrappedTx.to,
                useZodiac: true,
                originalTo: mockTxRequest.to,
            });
        });

        it('should include context in logs when provided', async () => {
            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const context = { requestId: 'test-123', invoiceId: 'inv-456' };

            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: mockTxRequest,
                zodiacConfig,
                context,
            };

            await submitTransactionWithLogging(params);

            const logCalls = mockLogger.info.getCalls();
            const submitLogCall = logCalls.find(call => call.args[0] === 'Submitting transaction');
            const successLogCall = logCalls.find(call => call.args[0] === 'Transaction submitted successfully');

            expect(submitLogCall?.args[1]).to.include(context);
            expect(successLogCall?.args[1]).to.include(context);
        });

        it('should handle transaction with no value (undefined)', async () => {
            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const txWithoutValue = {
                ...mockTxRequest,
                value: undefined,
            };
            wrapTransactionStub.returns(txWithoutValue);

            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: txWithoutValue,
                zodiacConfig,
            };

            await submitTransactionWithLogging(params);

            const logCalls = mockLogger.info.getCalls();
            const submitLogCall = logCalls.find(call => call.args[0] === 'Submitting transaction');
            expect(submitLogCall?.args[1]).to.include({ value: '0' });
        });

        it('should handle transaction with zero value', async () => {
            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const txWithZeroValue = {
                ...mockTxRequest,
                value: 0,
            };
            wrapTransactionStub.returns(txWithZeroValue);

            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: txWithZeroValue,
                zodiacConfig,
            };

            await submitTransactionWithLogging(params);

            const logCalls = mockLogger.info.getCalls();
            const submitLogCall = logCalls.find(call => call.args[0] === 'Submitting transaction');
            expect(submitLogCall?.args[1]).to.include({ value: '0' });
        });

        it('should handle transaction with non-zero value', async () => {
            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const txWithValue = {
                ...mockTxRequest,
                value: 1000000000000000000n, // 1 ETH in wei
            };
            wrapTransactionStub.returns(txWithValue);

            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: txWithValue,
                zodiacConfig,
            };

            await submitTransactionWithLogging(params);

            const logCalls = mockLogger.info.getCalls();
            const submitLogCall = logCalls.find(call => call.args[0] === 'Submitting transaction');
            expect(submitLogCall?.args[1]).to.include({ value: '1000000000000000000' });
        });
    });

    describe('transaction submission failure', () => {
        it('should handle chain service submission errors without context', async () => {
            const error = new Error('Chain service failed');
            mockChainService.submitAndMonitor.rejects(error);

            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: mockTxRequest,
                zodiacConfig,
            };

            await expect(submitTransactionWithLogging(params)).to.be.rejectedWith('Chain service failed');

            expect(mockLogger.info.calledWith('Submitting transaction')).to.be.true;
            expect(mockLogger.error.calledWith('Transaction submission failed')).to.be.true;

            const errorLogCall = mockLogger.error.getCalls().find(call => call.args[0] === 'Transaction submission failed');
            expect(errorLogCall?.args[1]).to.include({
                chainId: '1',
                error,
                txRequest: mockTxRequest,
                useZodiac: false,
            });
        });

        it('should handle chain service submission errors with context', async () => {
            const error = new Error('Network timeout');
            mockChainService.submitAndMonitor.rejects(error);

            const zodiacConfig: ZodiacConfig = { isEnabled: true };
            const context = { requestId: 'test-456', transactionType: 'approval' };

            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '137',
                txRequest: mockTxRequest,
                zodiacConfig,
                context,
            };

            await expect(submitTransactionWithLogging(params)).to.be.rejectedWith('Network timeout');

            const errorLogCall = mockLogger.error.getCalls().find(call => call.args[0] === 'Transaction submission failed');
            expect(errorLogCall?.args[1]).to.include({
                ...context,
                chainId: '137',
                error,
                useZodiac: true,
            });
        });

        it('should handle wrapped transaction in error logs when Zodiac is enabled', async () => {
            const error = new Error('Execution reverted');
            mockChainService.submitAndMonitor.rejects(error);

            const zodiacConfig: ZodiacConfig = {
                isEnabled: true,
                moduleAddress: '0xrole',
                roleKey: '0xkey',
                safeAddress: '0xsafe',
            };

            const wrappedTx = {
                ...mockTxRequest,
                to: zodiacConfig.moduleAddress,
                data: '0xwrappeddata',
            };
            wrapTransactionStub.returns(wrappedTx);

            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: mockTxRequest,
                zodiacConfig,
            };

            await expect(submitTransactionWithLogging(params)).to.be.rejectedWith('Execution reverted');

            const errorLogCall = mockLogger.error.getCalls().find(call => call.args[0] === 'Transaction submission failed');
            expect(errorLogCall?.args[1]).to.include({
                txRequest: wrappedTx, // Should log the wrapped transaction, not the original
                useZodiac: true,
            });
        });
    });

    describe('edge cases', () => {
        it('should handle empty context object', async () => {
            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '1',
                txRequest: mockTxRequest,
                zodiacConfig,
                context: {}, // Explicitly empty context
            };

            await submitTransactionWithLogging(params);

            expect(mockLogger.info.calledWith('Submitting transaction')).to.be.true;
            expect(mockLogger.info.calledWith('Transaction submitted successfully')).to.be.true;
        });

        it('should handle different chain IDs', async () => {
            const zodiacConfig: ZodiacConfig = { isEnabled: false };
            const params: TransactionSubmissionParams = {
                chainService: mockChainService,
                logger: mockLogger,
                chainId: '42161', // Arbitrum chain ID
                txRequest: mockTxRequest,
                zodiacConfig,
            };

            await submitTransactionWithLogging(params);

            expect(mockChainService.submitAndMonitor.calledOnceWith('42161', mockTxRequest)).to.be.true;

            const logCalls = mockLogger.info.getCalls();
            const submitLogCall = logCalls.find(call => call.args[0] === 'Submitting transaction');
            const successLogCall = logCalls.find(call => call.args[0] === 'Transaction submitted successfully');

            expect(submitLogCall?.args[1]).to.include({ chainId: '42161' });
            expect(successLogCall?.args[1]).to.include({ chainId: '42161' });
=======
import { stub, createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import { BigNumber } from 'ethers';
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
    const MOCK_SAFE_TX_HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

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
        };

        mockZodiacConfig = {
            walletType: WalletType.EOA,
            safeAddress: '0x1234567890123456789012345678901234567890',
        };

        mockContext = {
            invoiceId: 'test-invoice',
            intentId: 'test-intent',
        };

        // Stub wrapTransactionWithZodiac
        wrapTransactionWithZodiacStub = stub(zodiacHelpers, 'wrapTransactionWithZodiac').resolves(mockTxRequest);
    });

    describe('Multisig Transactions', () => {
        beforeEach(() => {
            mockZodiacConfig.walletType = WalletType.Multisig;
        });

        it('should successfully propose a multisig transaction', async () => {
            // Mock successful multisig proposal
            (mockDeps.chainService.proposeMultisigTransaction as SinonStub).resolves(MOCK_SAFE_TX_HASH);

            const result = await submitTransactionWithLogging({
                chainService: mockDeps.chainService,
                logger: mockDeps.logger,
                chainId: MOCK_CHAIN_ID.toString(),
                txRequest: mockTxRequest,
                zodiacConfig: mockZodiacConfig,
                context: mockContext,
            });

            expect(result).to.deep.equal({
                submissionType: TransactionSubmissionType.MultisigProposal,
                hash: MOCK_SAFE_TX_HASH,
            });

            // Verify logging
            expect(mockDeps.logger.info.calledWith('Proposing transaction to multisig')).to.be.true;
            expect(mockDeps.logger.info.calledWith('Transaction proposed to multisig successfully')).to.be.true;
        });

        it('should handle multisig proposal failure', async () => {
            const error = new Error('Multisig proposal failed');
            (mockDeps.chainService.proposeMultisigTransaction as SinonStub).rejects(error);

            await expect(submitTransactionWithLogging({
                chainService: mockDeps.chainService,
                logger: mockDeps.logger,
                chainId: MOCK_CHAIN_ID.toString(),
                txRequest: mockTxRequest,
                zodiacConfig: mockZodiacConfig,
                context: mockContext,
            })).to.be.rejectedWith(error);

            // Verify error logging
            expect(mockDeps.logger.error.calledWith('Multisig transaction proposal failed')).to.be.true;
        });
    });

    describe('Zodiac Transactions', () => {
        beforeEach(() => {
            mockZodiacConfig = {
                walletType: WalletType.Zodiac,
                safeAddress: '0x1234567890123456789012345678901234567890',
                moduleAddress: '0x9876543210987654321098765432109876543210',
                roleKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            };

            wrapTransactionWithZodiacStub.resolves({
                to: mockZodiacConfig.moduleAddress,
                data: '0xabc123',
                value: '0',
                from: mockTxRequest.from,
                chainId: mockTxRequest.chainId,
            })
        });

        it('should successfully submit a zodiac transaction', async () => {
            const mockReceipt = {
                transactionHash: MOCK_TX_HASH,
                blockNumber: 12345,
                gasUsed: BigNumber.from('100000'),
            };

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

            // Verify that the transaction was submitted with the correct parameters
            const submitCall = (mockDeps.chainService.submitAndMonitor as SinonStub).firstCall.args[1];
            expect(submitCall.to).to.equal(mockZodiacConfig.moduleAddress);
            expect(submitCall.data).to.include(mockTxRequest.data);
        });

        it('should handle zodiac transaction failure', async () => {
            const error = new Error('Zodiac transaction failed');
            (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(error);

            await expect(submitTransactionWithLogging({
                chainService: mockDeps.chainService,
                logger: mockDeps.logger,
                chainId: MOCK_CHAIN_ID.toString(),
                txRequest: mockTxRequest,
                zodiacConfig: mockZodiacConfig,
                context: mockContext,
            })).to.be.rejectedWith(error);

            // Verify error logging
            expect(mockDeps.logger.error.calledWith('Transaction submission failed')).to.be.true;
        });

        it('should include zodiac-specific fields in logs', async () => {
            const mockReceipt = {
                transactionHash: MOCK_TX_HASH,
                blockNumber: 12345,
                gasUsed: BigNumber.from('100000'),
            };

            (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(mockReceipt);

            await submitTransactionWithLogging({
                chainService: mockDeps.chainService,
                logger: mockDeps.logger,
                chainId: MOCK_CHAIN_ID.toString(),
                txRequest: mockTxRequest,
                zodiacConfig: mockZodiacConfig,
                context: mockContext,
            });

            // Verify that zodiac-specific fields are included in logs
            const logCalls = mockDeps.logger.info.getCalls();
            logCalls.forEach(call => {
                const logContext = call.args[1];
                expect(logContext).to.include({
                    walletType: WalletType.Zodiac,
                });
            });
        });

        it('should handle wrapTransactionWithZodiac failure', async () => {
            const error = new Error('Failed to wrap transaction with Zodiac');
            wrapTransactionWithZodiacStub.rejects(error);

            await expect(submitTransactionWithLogging({
                chainService: mockDeps.chainService,
                logger: mockDeps.logger,
                chainId: MOCK_CHAIN_ID.toString(),
                txRequest: mockTxRequest,
                zodiacConfig: mockZodiacConfig,
                context: mockContext,
            })).to.be.rejectedWith(error);

            expect(mockDeps.chainService.submitAndMonitor.called).to.be.false;
        });
    });

    describe('Regular Transactions', () => {
        beforeEach(() => {
            mockZodiacConfig.walletType = WalletType.EOA;
        });

        it('should successfully submit a regular transaction', async () => {
            const mockReceipt = {
                transactionHash: MOCK_TX_HASH,
                blockNumber: 12345,
                gasUsed: BigNumber.from('100000'),
            };

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

        it('should handle transaction submission failure', async () => {
            const error = new Error('Transaction failed');
            (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(error);

            await expect(submitTransactionWithLogging({
                chainService: mockDeps.chainService,
                logger: mockDeps.logger,
                chainId: MOCK_CHAIN_ID.toString(),
                txRequest: mockTxRequest,
                zodiacConfig: mockZodiacConfig,
                context: mockContext,
            })).to.be.rejectedWith(error);

            // Verify error logging
            expect(mockDeps.logger.error.calledWith('Transaction submission failed')).to.be.true;
>>>>>>> main
        });
    });
}); 