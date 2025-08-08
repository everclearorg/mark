import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance } from 'sinon';
import {
    checkTokenAllowance,
    isUSDTToken,
    checkAndApproveERC20,
    ApprovalParams,
} from '../../src/helpers/erc20';
import { MarkConfiguration, WalletConfig, WalletType } from '@mark/core';
import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { PrometheusAdapter, TransactionReason } from '@mark/prometheus';
import * as transactionsModule from '../../src/helpers/transactions';
import { providers } from 'ethers';

describe('ERC20 Helper Functions', () => {
    let mockConfig: MarkConfiguration;
    let mockChainService: SinonStubbedInstance<ChainService>;
    let mockLogger: SinonStubbedInstance<Logger>;
    let mockPrometheus: SinonStubbedInstance<PrometheusAdapter>;
    let submitTransactionStub: sinon.SinonStub;

    const CHAIN_ID = '1';
    const TOKEN_ADDRESS = '0x1234567890123456789012345678901234567890';
    const SPENDER_ADDRESS = '0x9876543210987654321098765432109876543210';
    const OWNER_ADDRESS = '0x1111111111111111111111111111111111111111';
    const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

    const mockZodiacConfig: WalletConfig = {
        walletType: WalletType.EOA,
    };

    const mockReceipt = {
        transactionHash: '0xtxhash123',
        blockNumber: 123,
        status: 1,
        cumulativeGasUsed: { mul: (price: any) => ({ toString: () => '420000000000000' }) },
        effectiveGasPrice: { toString: () => '20000000000' },
    } as providers.TransactionReceipt;

    beforeEach(() => {
        mockConfig = {
            chains: {
                [CHAIN_ID]: {
                    providers: ['http://localhost:8545'],
                    assets: [
                        {
                            symbol: 'TEST',
                            address: TOKEN_ADDRESS,
                            decimals: 18,
                            tickerHash: '0xtest',
                            isNative: false,
                        },
                        {
                            symbol: 'USDT',
                            address: USDT_ADDRESS,
                            decimals: 6,
                            tickerHash: '0xusdt',
                            isNative: false,
                        },
                    ],
                    deployments: {
                        everclear: '0x1234',
                        permit2: '0x5678',
                        multicall3: '0x9abc',
                    },
                },
            },
            ownAddress: OWNER_ADDRESS,
        } as unknown as MarkConfiguration;

        mockChainService = createStubInstance(ChainService);
        mockLogger = createStubInstance(Logger);
        mockPrometheus = createStubInstance(PrometheusAdapter);

        submitTransactionStub = stub(transactionsModule, 'submitTransactionWithLogging');

        // Default transaction submission behavior
        submitTransactionStub.resolves({
            hash: mockReceipt.transactionHash,
            receipt: mockReceipt,
        });
    });

    afterEach(() => {
        submitTransactionStub.restore();
    });

    describe('checkTokenAllowance', () => {
        it('should return current allowance from token contract', async () => {
            const expectedAllowance = 1000n;
            
            // Mock the encoded allowance data that will decode to 1000n
            const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000003e8'; // 1000n in hex
            
            mockChainService.readTx.resolves(encodedAllowance);

            const result = await checkTokenAllowance(
                mockChainService,
                CHAIN_ID,
                TOKEN_ADDRESS,
                OWNER_ADDRESS,
                SPENDER_ADDRESS
            );

            expect(result).to.equal(expectedAllowance);
            expect(mockChainService.readTx.calledOnce).to.be.true;
            const readTxCall = mockChainService.readTx.firstCall;
            expect(readTxCall.args[0].to).to.equal(TOKEN_ADDRESS);
            expect(readTxCall.args[0].domain).to.equal(+CHAIN_ID);
            expect(readTxCall.args[0].funcSig).to.equal('allowance(address,address)');
        });
    });

    describe('isUSDTToken', () => {
        it('should return true for USDT token address (exact case)', () => {
            const result = isUSDTToken(mockConfig, CHAIN_ID, USDT_ADDRESS);
            expect(result).to.be.true;
        });

        it('should return true for USDT token address (case insensitive)', () => {
            const result = isUSDTToken(mockConfig, CHAIN_ID, USDT_ADDRESS.toUpperCase());
            expect(result).to.be.true;
        });

        it('should return false for non-USDT token address', () => {
            const result = isUSDTToken(mockConfig, CHAIN_ID, TOKEN_ADDRESS);
            expect(result).to.be.false;
        });

        it('should return false when chain has no assets configured', () => {
            const configWithoutAssets = {
                ...mockConfig,
                chains: {
                    [CHAIN_ID]: {
                        providers: ['http://localhost:8545'],
                    },
                },
            } as unknown as MarkConfiguration;

            const result = isUSDTToken(configWithoutAssets, CHAIN_ID, USDT_ADDRESS);
            expect(result).to.be.false;
        });

        it('should return false when chain is not configured', () => {
            const result = isUSDTToken(mockConfig, '999', USDT_ADDRESS);
            expect(result).to.be.false;
        });
    });

    describe('checkAndApproveERC20', () => {
        let baseParams: ApprovalParams;

        beforeEach(() => {
            baseParams = {
                config: mockConfig,
                chainService: mockChainService,
                logger: mockLogger,
                chainId: CHAIN_ID,
                tokenAddress: TOKEN_ADDRESS,
                spenderAddress: SPENDER_ADDRESS,
                amount: 1000n,
                owner: OWNER_ADDRESS,
                zodiacConfig: mockZodiacConfig,
            };
        });

        describe('sufficient allowance scenarios', () => {
            it('should return early when allowance is greater than required amount', async () => {
                // Mock the encoded allowance data for 2000n allowance
                const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000007d0'; // 2000n in hex
                mockChainService.readTx.resolves(encodedAllowance);

                const result = await checkAndApproveERC20(baseParams);

                expect(result).to.deep.equal({ wasRequired: false });
                expect(submitTransactionStub.called).to.be.false;
                expect(mockLogger.info.calledWith('Sufficient allowance already available')).to.be.true;
            });

            it('should return early when allowance equals required amount', async () => {
                // Mock the encoded allowance data for 1000n allowance
                const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000003e8'; // 1000n in hex
                mockChainService.readTx.resolves(encodedAllowance);

                const result = await checkAndApproveERC20(baseParams);

                expect(result).to.deep.equal({ wasRequired: false });
                expect(submitTransactionStub.called).to.be.false;
            });
        });

        describe('insufficient allowance - non-USDT token', () => {
            beforeEach(() => {
                // Mock the encoded allowance data for 500n allowance
                const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000001f4'; // 500n in hex
                mockChainService.readTx.resolves(encodedAllowance);
            });

            it('should set approval when allowance is insufficient', async () => {
                const result = await checkAndApproveERC20(baseParams);

                expect(result).to.deep.equal({
                    wasRequired: true,
                    transactionHash: mockReceipt.transactionHash,
                });
                expect(submitTransactionStub.calledOnce).to.be.true;
                expect(mockLogger.info.calledWith('Setting ERC20 approval')).to.be.true;
            });

            it('should include context in logs when provided', async () => {
                const context = { requestId: 'test-123', invoiceId: 'inv-456' };
                const paramsWithContext = { ...baseParams, context };

                await checkAndApproveERC20(paramsWithContext);

                expect(mockLogger.info.called).to.be.true;
                // Check that context was included in log calls
                const logCalls = mockLogger.info.getCalls();
                const hasContextInLogs = logCalls.some(call =>
                    call.args[1] && call.args[1].requestId === 'test-123'
                );
                expect(hasContextInLogs).to.be.true;
            });

            it('should update gas metrics when prometheus is provided', async () => {
                const paramsWithPrometheus = { ...baseParams, prometheus: mockPrometheus };

                await checkAndApproveERC20(paramsWithPrometheus);

                expect(mockPrometheus.updateGasSpent.calledOnce).to.be.true;
                expect(mockPrometheus.updateGasSpent.calledWith(
                    CHAIN_ID,
                    TransactionReason.Approval,
                    420000000000000n
                )).to.be.true;
            });

            it('should not update gas metrics when prometheus is not provided', async () => {
                await checkAndApproveERC20(baseParams);

                expect(mockPrometheus.updateGasSpent.called).to.be.false;
            });
        });

        describe('insufficient allowance - USDT token with zero current allowance', () => {
            beforeEach(() => {
                // Mock the encoded allowance data for 0n allowance
                const encodedAllowance = '0x0000000000000000000000000000000000000000000000000000000000000000'; // 0n in hex
                mockChainService.readTx.resolves(encodedAllowance);
            });

            it('should set approval directly when USDT has zero allowance', async () => {
                const usdtParams = {
                    ...baseParams,
                    tokenAddress: USDT_ADDRESS,
                };

                const result = await checkAndApproveERC20(usdtParams);

                expect(result).to.deep.equal({
                    wasRequired: true,
                    transactionHash: mockReceipt.transactionHash,
                });
                expect(submitTransactionStub.calledOnce).to.be.true; // Only one approval call, no zero approval needed
            });
        });

        describe('insufficient allowance - USDT token with non-zero current allowance', () => {
            beforeEach(() => {
                // Mock the encoded allowance data for 500n allowance
                const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000001f4'; // 500n in hex
                mockChainService.readTx.resolves(encodedAllowance);
            });

            it('should set zero allowance first when USDT has non-zero allowance', async () => {
                const usdtParams = {
                    ...baseParams,
                    tokenAddress: USDT_ADDRESS,
                };

                const result = await checkAndApproveERC20(usdtParams);

                expect(result).to.deep.equal({
                    wasRequired: true,
                    transactionHash: mockReceipt.transactionHash,
                    hadZeroApproval: true,
                    zeroApprovalTxHash: mockReceipt.transactionHash,
                });
                expect(submitTransactionStub.calledTwice).to.be.true; // Zero approval + actual approval
                expect(mockLogger.info.calledWith('USDT allowance is greater than zero, setting allowance to zero first')).to.be.true;
                expect(mockLogger.info.calledWith('Zero allowance transaction for USDT sent successfully')).to.be.true;
            });

            it('should update gas metrics for both transactions when USDT and prometheus provided', async () => {
                const usdtParams = {
                    ...baseParams,
                    tokenAddress: USDT_ADDRESS,
                    prometheus: mockPrometheus,
                };

                await checkAndApproveERC20(usdtParams);

                expect(mockPrometheus.updateGasSpent.calledTwice).to.be.true;
                // Both calls should be for approval transactions
                expect(mockPrometheus.updateGasSpent.alwaysCalledWith(
                    CHAIN_ID,
                    TransactionReason.Approval,
                    420000000000000n
                )).to.be.true;
            });

            it('should not update gas metrics when prometheus not provided even for USDT', async () => {
                const usdtParams = {
                    ...baseParams,
                    tokenAddress: USDT_ADDRESS,
                };

                await checkAndApproveERC20(usdtParams);

                expect(mockPrometheus.updateGasSpent.called).to.be.false;
            });
        });

        describe('error handling', () => {
            it('should propagate allowance check errors', async () => {
                const error = new Error('Allowance check failed');
                mockChainService.readTx.rejects(error);

                await expect(checkAndApproveERC20(baseParams)).to.be.rejectedWith('Allowance check failed');
            });

            it('should propagate transaction submission errors', async () => {
                // Mock the encoded allowance data for 0n allowance
                const encodedAllowance = '0x0000000000000000000000000000000000000000000000000000000000000000'; // 0n in hex
                mockChainService.readTx.resolves(encodedAllowance);

                const error = new Error('Transaction submission failed');
                submitTransactionStub.rejects(error);

                await expect(checkAndApproveERC20(baseParams)).to.be.rejectedWith('Transaction submission failed');
            });

            it('should propagate contract creation errors', async () => {
                const error = new Error('Contract creation failed');
                mockChainService.readTx.rejects(error);

                await expect(checkAndApproveERC20(baseParams)).to.be.rejectedWith('Contract creation failed');
            });
        });
    });
}); 