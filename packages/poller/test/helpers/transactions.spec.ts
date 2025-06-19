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
        });
    });
}); 