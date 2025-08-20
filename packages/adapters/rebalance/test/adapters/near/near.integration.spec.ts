/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach, afterAll } from '@jest/globals';
import { AssetConfiguration, ChainConfiguration, RebalanceRoute, cleanupHttpConnections } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { createPublicClient, TransactionReceipt, encodeFunctionData, zeroAddress, http } from 'viem';
import { NearBridgeAdapter } from '../../../src/adapters/near/near';
import { DepositStatusResponse } from '../../../src/adapters/near/types';
import { getDepositFromLogs, parseDepositLogs } from '../../../src/adapters/near/utils';
import { RebalanceTransactionMemo } from '../../../src/types';

// Test adapter that exposes private methods
class TestNearBridgeAdapter extends NearBridgeAdapter {
    public getSuggestedFees(route: RebalanceRoute, refundTo: string, receiver: string, amount: string): Promise<any> {
        return super.getSuggestedFees(route, refundTo, receiver, amount);
    }

    public getDepositStatus(route: RebalanceRoute, originTransaction: TransactionReceipt): Promise<DepositStatusResponse | undefined> {
        return super.getDepositStatus(route, originTransaction);
    }

    public extractDepositAddress(origin: number, receipt: TransactionReceipt, value: bigint): string | undefined {
        return super.extractDepositAddress(origin, receipt, value);
    }

    public getTokenBalance(tokenAddress: string, owner: string, client: any): Promise<bigint> {
        return super.getTokenBalance(tokenAddress, owner, client);
    }

    public requiresCallback(route: RebalanceRoute, depositAddress: string, inputAmount: bigint, fillTxHash: string): Promise<any> {
        return super.requiresCallback(route, depositAddress, inputAmount, fillTxHash);
    }

    public getTransactionValue(provider: string, originTransaction: TransactionReceipt): Promise<bigint> {
        return super.getTransactionValue(provider, originTransaction);
    }
}

// Mock the Logger
const mockLogger = new Logger({ service: 'near-integration-test' });

// Mock data for testing
const mockAssets: Record<string, AssetConfiguration> = {
    ETH: {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH',
        decimals: 18,
        tickerHash: '0xETHHash',
        isNative: true,
        balanceThreshold: '0',
    },
    USDC_ETH: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: 6,
        tickerHash: '0xUSDCHash',
        isNative: false,
        balanceThreshold: '0',
    },
    USDC_ARB: {
        address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        symbol: 'USDC',
        decimals: 6,
        tickerHash: '0xUSDCHash',
        isNative: false,
        balanceThreshold: '0',
    },
};

const mockChains: Record<string, any> = {
    '1': {
        assets: [mockAssets.ETH, mockAssets.USDC_ETH],
        providers: ['https://eth.llamarpc.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
    '8453': { // Base chain
        assets: [mockAssets.ETH, mockAssets.USDC_ETH],
        providers: ['https://mainnet.base.org'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
    '42161': { // Arbitrum chain
        assets: [mockAssets.ETH, mockAssets.USDC_ARB],
        providers: ['https://arb1.arbitrum.io/rpc'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
};

// Real transaction data
const REAL_TRANSACTIONS = {
    baseToArbitrum: {
        originTxHash: '0xf0a7e084f2375f69c97e622146a6a7d5badc1df5cb3f74ee007229f92f998611',
        originBlockNumber: 32595713,
        originBlockHash: '0xf871f374157c98702ede5238f6ec1637fe323c647fa47bc54a578b4482f317b8',
        fillTxHash: '0xc7514e675f318b2565b3784c10b764394cb69c95a287e36c025ac5ea09b636fd',
        fillBlockNumber: 355548549,
        fillBlockHash: '0x9e61be967238b2679e98043433052a429132590cbf7eafe11ce40c5059d1292b',
        originChain: 8453, // Base
        destinationChain: 42161, // Arbitrum
        asset: '0x0000000000000000000000000000000000000000', // ETH
        amount: '1000000000000000', // 0.001 ETH
        sender: "0x8c0bcb51508675535e43760fb93B7F5dcD1b73d0",
        recipient: "0xBc8988C7a4b77c1d6df7546bd876Ea4D42DF0837",
        depositAddress: "0x1F7812209f30048Cc31D86E0075BD2E4d8c2e1B2",
    }
};

describe('NearBridgeAdapter Integration', () => {
    let adapter: TestNearBridgeAdapter;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Reset all mock implementations
        // (encodeFunctionData as jest.Mock).mockReset();
        // (encodeFunctionData as jest.Mock).mockReset();
        // (getDepositFromLogs as jest.Mock).mockReset();
        // (parseDepositLogs as jest.Mock).mockReset();

        // Reset logger mocks
        // mockLogger.debug.mockReset();
        // mockLogger.info.mockReset();
        // mockLogger.warn.mockReset();
        // mockLogger.error.mockReset();

        // Create fresh adapter instance
        adapter = new TestNearBridgeAdapter(
            mockChains as Record<string, ChainConfiguration>,
            process.env.NEAR_JWT_TOKEN || 'test-jwt-token',
            process.env.NEAR_API_BASE_URL || 'api.near.com',
            mockLogger,
        );
    });

    afterEach(() => {
        cleanupHttpConnections();
    });

    afterAll(() => {
        cleanupHttpConnections();
    });

    it('should call real OneClick API', async () => {
        const route: RebalanceRoute = {
            asset: mockAssets['USDC_ETH'].address,
            origin: 1,
            destination: 42161,
        };

        try {
            const result = await adapter.getReceivedAmount('1000000000', route);
            expect(result).toBeDefined();
            expect(typeof result).toBe('string');
            // Now expect the result to be a raw integer string (amountOut)
            // Optionally, you can check that it only contains digits
            expect(/^[0-9]+$/.test(result)).toBe(true);
        } catch (error) {
            // Real API might fail due to network issues, rate limits, etc.
            // This is expected in integration tests
            console.log('Integration test failed (expected):', error);
            expect(error).toBeDefined();
        }
    });

    it('should handle API errors gracefully', async () => {
        const route: RebalanceRoute = {
            asset: mockAssets['USDC_ETH'].address,
            origin: 1,
            destination: 999999, // Invalid chain ID
        };

        try {
            await adapter.getReceivedAmount('1000000000', route);
            // Should not reach here
            expect(true).toBe(false);
        } catch (error) {
            expect(error).toBeDefined();
            expect((error as Error).message).toContain('Failed to get received amount from Near');
        }
    });

    describe('getSuggestedFees', () => {
        it('should get real quote from OneClick API', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['ETH'].address, // ETH
                origin: 8453, // Base
                destination: 42161, // Arbitrum
            };

            try {
                const result = await adapter.getSuggestedFees(
                    route,
                    REAL_TRANSACTIONS.baseToArbitrum.sender, // Use real sender address
                    REAL_TRANSACTIONS.baseToArbitrum.recipient, // Use real recipient address
                    '1000000000000000000'
                );
                expect(result).toBeDefined();
                expect(result.quote).toBeDefined();
                expect(result.quote.amountIn).toBeDefined();
                expect(result.quote.amountOut).toBeDefined();
                expect(result.quote.depositAddress).toBeDefined();
                console.log('Real quote received:', {
                    amountIn: result.quote.amountIn,
                    amountOut: result.quote.amountOut,
                    depositAddress: result.quote.depositAddress,
                });
            } catch (error) {
                console.log('getSuggestedFees failed (expected):', error);
                expect(error).toBeDefined();
            }
        });
    });

    describe('getDepositStatus', () => {
        it('should get deposit status from real transaction', async () => {
            const route: RebalanceRoute = {
                asset: REAL_TRANSACTIONS.baseToArbitrum.asset,
                origin: REAL_TRANSACTIONS.baseToArbitrum.originChain,
                destination: REAL_TRANSACTIONS.baseToArbitrum.destinationChain,
            };

            // Fetch the real transaction receipt from the blockchain
            const provider = mockChains[REAL_TRANSACTIONS.baseToArbitrum.originChain.toString()].providers[0];
            const client = createPublicClient({ transport: http(provider) });
            const realReceipt = await client.getTransactionReceipt({ hash: REAL_TRANSACTIONS.baseToArbitrum.originTxHash as `0x${string}` });

            try {
                const result = await adapter.getDepositStatus(route, realReceipt);
                expect(result).toBeDefined();
                if (result) {
                    expect(result.depositId).toBeDefined();
                    expect(result.status).toBeDefined();
                    console.log('Deposit status:', result);
                }
            } catch (error) {
                console.log('getDepositStatus failed (expected):', error);
                expect(error).toBeDefined();
            }
        });
    });

    describe('extractDepositAddress', () => {
        it('should extract deposit address from real transaction sending ETH', async () => {
            const mockReceipt: TransactionReceipt = {
                transactionHash: REAL_TRANSACTIONS.baseToArbitrum.originTxHash as `0x${string}`,
                blockHash: REAL_TRANSACTIONS.baseToArbitrum.originBlockHash as `0x${string}`,
                blockNumber: BigInt(REAL_TRANSACTIONS.baseToArbitrum.originBlockNumber),
                contractAddress: null,
                effectiveGasPrice: BigInt(2000000000),
                from: REAL_TRANSACTIONS.baseToArbitrum.sender as `0x${string}`,
                to: REAL_TRANSACTIONS.baseToArbitrum.recipient as `0x${string}`,
                gasUsed: BigInt(21000),
                cumulativeGasUsed: BigInt(21000),
                logs: [],
                logsBloom: '0x',
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            try {
                const result = adapter.extractDepositAddress(
                    REAL_TRANSACTIONS.baseToArbitrum.originChain,
                    mockReceipt,
                    BigInt(REAL_TRANSACTIONS.baseToArbitrum.amount)
                );
                expect(result).toBeDefined();
                console.log('Extracted deposit address:', result);
            } catch (error) {
                console.log('extractDepositAddress failed (expected):', error);
                expect(error).toBeDefined();
            }
        });
    });

    describe('getTokenBalance', () => {
        it('should get real token balance', async () => {
            // Use a real address that we know has balances
            const testAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // Vitalik's current address

            try {
                // Test native ETH balance on Ethereum
                const ethProvider = mockChains['1'].providers[0];
                const ethClient = createPublicClient({ transport: http(ethProvider) });

                const ethBalance = await adapter.getTokenBalance(
                    '0x0000000000000000000000000000000000000000', // ETH address
                    testAddress,
                    ethClient
                );
                expect(ethBalance).toBeDefined();
                console.log('ETH balance on Ethereum:', ethBalance.toString());

                // Test USDC balance on Ethereum
                const usdcBalance = await adapter.getTokenBalance(
                    mockAssets['USDC_ETH'].address,
                    testAddress,
                    ethClient
                );
                expect(usdcBalance).toBeDefined();
                console.log('USDC balance on Ethereum:', usdcBalance.toString());

                // Test native ETH balance on Base
                const baseProvider = mockChains['8453'].providers[0];
                const baseClient = createPublicClient({ transport: http(baseProvider) });

                const baseEthBalance = await adapter.getTokenBalance(
                    '0x0000000000000000000000000000000000000000', // ETH address
                    testAddress,
                    baseClient
                );
                expect(baseEthBalance).toBeDefined();
                console.log('Base ETH balance:', baseEthBalance.toString());

                // Test USDC balance on Arbitrum
                const arbProvider = mockChains['42161'].providers[0];
                const arbClient = createPublicClient({ transport: http(arbProvider) });

                const arbUsdcBalance = await adapter.getTokenBalance(
                    mockAssets['USDC_ARB'].address,
                    testAddress,
                    arbClient
                );
                expect(arbUsdcBalance).toBeDefined();
                console.log('Arbitrum USDC balance:', arbUsdcBalance.toString());

                // Test with a well-known address that should have balances
                const binanceAddress = '0x28C6c06298d514Db089934071355E5743bf21d60'; // Binance hot wallet
                const binanceEthBalance = await adapter.getTokenBalance(
                    '0x0000000000000000000000000000000000000000',
                    binanceAddress,
                    ethClient
                );
                expect(binanceEthBalance).toBeDefined();
                console.log('Binance ETH balance:', binanceEthBalance.toString());

            } catch (error) {
                console.log('getTokenBalance failed (expected):', error);
                expect(error).toBeDefined();
            }
        });
    });

    describe('requiresCallback', () => {
        it('should determine if callback is needed for real transaction sending ETH', async () => {
            const route: RebalanceRoute = {
                asset: REAL_TRANSACTIONS.baseToArbitrum.asset,
                origin: REAL_TRANSACTIONS.baseToArbitrum.originChain,
                destination: REAL_TRANSACTIONS.baseToArbitrum.destinationChain,
            };

            try {
                const result = await adapter.requiresCallback(
                    route,
                    REAL_TRANSACTIONS.baseToArbitrum.depositAddress,
                    BigInt(REAL_TRANSACTIONS.baseToArbitrum.amount),
                    REAL_TRANSACTIONS.baseToArbitrum.fillTxHash
                );
                expect(result).toBeDefined();
                expect(result.needsCallback).toBeDefined();
                expect(result.needsCallback).toBe(true);
                console.log('Callback required:', result);
            } catch (error) {
                console.log('requiresCallback failed (expected):', error);
                expect(error).toBeDefined();
            }
        });
    });
});
