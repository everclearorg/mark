/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach, afterAll } from '@jest/globals';
import { AssetConfiguration, ChainConfiguration, RebalanceRoute, cleanupHttpConnections } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { createPublicClient, TransactionReceipt, encodeFunctionData, zeroAddress, erc20Abi } from 'viem';
import { NearBridgeAdapter } from '../../../src/adapters/near/near';
import { DepositStatusResponse } from '../../../src/adapters/near/types';
import { getDepositFromLogs, parseDepositLogs } from '../../../src/adapters/near/utils';
import { RebalanceTransactionMemo } from '../../../src/types';
import { GetExecutionStatusResponse, OneClickService } from '@defuse-protocol/one-click-sdk-typescript';
import { mock } from 'node:test';

// Mock the external dependencies
jest.mock('viem');
jest.mock('@mark/logger');
(jsonifyError as jest.Mock).mockImplementation((err) => {
    const error = err as { name?: string; message?: string; stack?: string };
    return {
        name: error?.name ?? 'unknown',
        message: error?.message ?? 'unknown',
        stack: error?.stack ?? 'unknown',
        context: {},
    };
});
jest.mock('@mark/core', () => {
    const actual = jest.requireActual('@mark/core') as any;
    return {
        ...actual,
        cleanupHttpConnections: jest.fn(),
    };
});
jest.mock('../../../src/adapters/near/utils', () => ({
    getDepositFromLogs: jest.fn(),
    parseDepositLogs: jest.fn(),
}));
jest.mock('@defuse-protocol/one-click-sdk-typescript', () => ({
    OneClickService: {
        getQuote: jest.fn(),
        getExecutionStatus: jest.fn(),
    },
    QuoteRequest: {
        swapType: {
            EXACT_INPUT: 'EXACT_INPUT',
        },
        depositType: {
            ORIGIN_CHAIN: 'ORIGIN_CHAIN',
        },
        refundType: {
            ORIGIN_CHAIN: 'ORIGIN_CHAIN',
        },
        recipientType: {
            DESTINATION_CHAIN: 'DESTINATION_CHAIN',
        },
    },
}));

// Test adapter that exposes private methods
class TestNearBridgeAdapter extends NearBridgeAdapter {
    public getSuggestedFees(route: RebalanceRoute, refundTo: string, receiver: string, amount: string): Promise<any> {
        return super.getSuggestedFees(route, refundTo, receiver, amount);
    }

    public getDepositStatusFromApi(depositAddress: string): Promise<GetExecutionStatusResponse | undefined> {
        return super.getDepositStatusFromApi(depositAddress);
    }

    public handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
        return super.handleError(error, context, metadata);
    }

    public validateAsset(asset: AssetConfiguration | undefined, expectedSymbol: string, context: string): void {
        return super.validateAsset(asset, expectedSymbol, context);
    }

    public findMatchingDestinationAsset(
        asset: string,
        origin: number,
        destination: number,
    ): AssetConfiguration | undefined {
        return super.findMatchingDestinationAsset(asset, origin, destination);
    }

    public extractDepositAddress(origin: number, receipt: TransactionReceipt, value: bigint): string | undefined {
        return super.extractDepositAddress(origin, receipt, value);
    }

    public requiresCallback(
        route: RebalanceRoute,
        depositAddress: string,
        inputAmount: bigint,
        fillTxHash: string,
    ): Promise<{
        needsCallback: boolean;
        amount?: bigint;
        recipient?: string;
        asset?: AssetConfiguration;
    }> {
        return super.requiresCallback(route, depositAddress, inputAmount, fillTxHash);
    }

    public getTransactionValue(provider: string, originTransaction: TransactionReceipt): Promise<bigint> {
        return super.getTransactionValue(provider, originTransaction);
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
const mockAssets: Record<string, AssetConfiguration> = {
    ETH: {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH',
        decimals: 18,
        tickerHash: '0xETHHash',
        isNative: true,
        balanceThreshold: '0',
    },
    WETH: {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        symbol: 'WETH',
        decimals: 18,
        tickerHash: '0xWETHHash',
        isNative: false,
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
        assets: [mockAssets.ETH, mockAssets.WETH, mockAssets.USDC_ETH],
        providers: ['https://base-mainnet.example.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
    '42161': {
        assets: [mockAssets.ETH, mockAssets.WETH, mockAssets.USDC_ARB],
        providers: ['https://arb-mainnet.example.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
};

// Mock API response
const mockQuoteResponse = {
    timestamp: new Date().toISOString(),
    signature: 'ed25519:2GLh7ij4XBHPurchoTsYvbmjhtdZdSWgXNWgiGXVvw4VjJGei8eHPW4NTxWHxR6yXVRpApmTzcvv7NEngPotkgbr',
    quote: {
        amountIn: '1000000000000000000',
        amountInFormatted: '1.0',
        amountInUsd: '2000',
        minAmountIn: '1000000000000000000',
        amountOut: '998000000000000000',
        amountOutFormatted: '0.998',
        amountOutUsd: '1996',
        minAmountOut: '997000000000000000',
        depositAddress: '0x1F7812209f30048Cc31D86E0075BD2E4d8c2e1B2',
        deadline: new Date(Date.now() + 3600000).toISOString(),
        timeEstimate: 30,
    },
    quoteRequest: {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 10,
        depositType: 'ORIGIN_CHAIN',
        originAsset: 'nep141:base.omft.near',
        destinationAsset: 'nep141:arb.omft.near',
        amount: '1000000000000000000',
        refundTo: '0x8c0bcb51508675535e43760fb93B7F5dcD1b73d0',
        refundType: 'ORIGIN_CHAIN',
        recipient: '0x8c0bcb51508675535e43760fb93B7F5dcD1b73d0',
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 3600000).toISOString(),
    },
};

// Mock deposit status response
const mockStatusResponse = {
    status: 'SUCCESS',
    updatedAt: '2025-07-08T13:20:20.000Z',
    swapDetails: {
        intentHashes: ['J2YPmTVbwy5P3utkoVuWSdDKe1gsBnBspjRbUZrgeeZ5'],
        nearTxHashes: ['ApUFFFaPowmb336XLuacGpjFF1QXo8WGjHxhqhuvDXWR'],
        amountIn: '1000000000000000000',
        amountInFormatted: '1.0',
        amountInUsd: '2000',
        amountOut: '998000000000000000',
        amountOutFormatted: '0.998',
        amountOutUsd: '1996',
        slippage: 0,
        refundedAmount: '0',
        refundedAmountFormatted: '0',
        refundedAmountUsd: '0',
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: '0xfilltxhash', explorerUrl: 'https://explorer.example.com' }],
    },
    quoteResponse: {
        timestamp: '2025-07-08T13:19:27.710Z',
        signature: 'ed25519:2GLh7ij4XBHPurchoTsYvbmjhtdZdSWgXNWgiGXVvw4VjJGei8eHPW4NTxWHxR6yXVRpApmTzcvv7NEngPotkgbr',
        quoteRequest: {
            dry: false,
            swapType: 'EXACT_INPUT',
            slippageTolerance: 10,
            originAsset: 'nep141:base.omft.near',
            depositType: 'ORIGIN_CHAIN',
            destinationAsset: 'nep141:arb.omft.near',
            amount: '1000000000000000000',
            refundTo: '0x8c0bcb51508675535e43760fb93B7F5dcD1b73d0',
            refundType: 'ORIGIN_CHAIN',
            recipient: '0x8c0bcb51508675535e43760fb93B7F5dcD1b73d0',
            recipientType: 'DESTINATION_CHAIN',
            deadline: '2025-07-08T13:24:27.592Z',
            appFees: [],
        },
        quote: {
            amountIn: '1000000000000000000',
            amountInFormatted: '1.0',
            amountInUsd: '2000',
            minAmountIn: '1000000000000000000',
            amountOut: '998000000000000000',
            amountOutFormatted: '0.998',
            amountOutUsd: '1996',
            minAmountOut: '997000000000000000',
            timeWhenInactive: '2025-07-09T13:19:30.862Z',
            depositAddress: '0x1F7812209f30048Cc31D86E0075BD2E4d8c2e1B2',
            deadline: '2025-07-09T13:19:30.862Z',
            timeEstimate: 34,
        },
    },
};

describe('NearBridgeAdapter', () => {
    let adapter: TestNearBridgeAdapter;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Reset all mock implementations
        (createPublicClient as jest.Mock).mockImplementation(() => ({
            getBalance: jest.fn<() => Promise<bigint>>(),
            readContract: jest.fn<() => Promise<unknown>>(),
            getTransactionReceipt: jest.fn(),
            getTransaction: jest.fn(),
        }));
        (encodeFunctionData as jest.Mock).mockReset();
        (getDepositFromLogs as jest.Mock).mockReset();
        (parseDepositLogs as jest.Mock).mockReset();

        // Reset OneClickService mocks
        (OneClickService.getQuote as jest.Mock).mockReset();
        (OneClickService.getExecutionStatus as jest.Mock).mockReset();

        // Reset logger mocks
        mockLogger.debug.mockReset();
        mockLogger.info.mockReset();
        mockLogger.warn.mockReset();
        mockLogger.error.mockReset();

        // Create fresh adapter instance
        adapter = new TestNearBridgeAdapter(mockChains as Record<string, ChainConfiguration>, mockLogger);
    });

    afterEach(() => {
        cleanupHttpConnections();
    });

    afterAll(() => {
        cleanupHttpConnections();
    });

    describe('constructor', () => {
        it('should initialize correctly', () => {
            expect(adapter).toBeDefined();
            expect(mockLogger.debug).toHaveBeenCalledWith('Initializing NearBridgeAdapter');
        });
    });

    describe('type', () => {
        it('should return the correct type', () => {
            expect(adapter.type()).toBe('near');
        });
    });

    describe('getReceivedAmount', () => {
        it('should return the output amount from quote', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC_ETH'].address,
                origin: 1,
                destination: 42161,
            };

            // Mock OneClickService.getQuote
            (OneClickService.getQuote as jest.MockedFunction<any>).mockResolvedValueOnce(mockQuoteResponse);

            // Execute
            const amount = '1000000000'; // 1000 USDC
            const result = await adapter.getReceivedAmount(amount, route);

            // Expected: amountOutFormatted from quote
            expect(result).toBe(mockQuoteResponse.quote.amountOutFormatted);
            expect(OneClickService.getQuote).toHaveBeenCalledWith({
                dry: false,
                swapType: 'EXACT_INPUT',
                slippageTolerance: 10,
                depositType: 'ORIGIN_CHAIN',
                originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
                destinationAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
                amount,
                refundTo: '0xBc8988C7a4b77c1d6df7546bd876Ea4D42DF0837',
                refundType: 'ORIGIN_CHAIN',
                recipient: '0xBc8988C7a4b77c1d6df7546bd876Ea4D42DF0837',
                recipientType: 'DESTINATION_CHAIN',
                deadline: expect.any(String),
            });
        });

        it('should throw an error if the API request fails', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC_ETH'].address,
                origin: 1,
                destination: 10,
            };

            // Mock OneClickService.getQuote to reject with an error
            (OneClickService.getQuote as jest.Mock).mockRejectedValueOnce(new Error('API error') as never);

            // Execute and expect error
            await expect(adapter.getReceivedAmount('1000000000', route)).rejects.toThrow(
                "Failed to get received amount from Near:",
            );
        });
    });

    describe('send', () => {
        it('should prepare transaction request correctly for ERC20', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC_ETH'].address,
                origin: 1,
                destination: 42161,
            };

            // Mock OneClickService.getQuote
            (OneClickService.getQuote as jest.Mock).mockResolvedValueOnce(mockQuoteResponse as never);
            (encodeFunctionData as jest.Mock).mockReturnValueOnce('0x');
            
            // TODO: Need to investigate why the amounts differ 

            // Execute
            const senderAddress = '0x' + 'sender'.padStart(40, '0');
            const recipientAddress = '0x' + 'recipient'.padStart(40, '0');
            const amountIn = mockQuoteResponse.quote.amountIn;
            const result = await adapter.send(senderAddress, recipientAddress, amountIn, route);

            // Assert
            expect(result.length).toBe(1);
            expect(result[0].memo).toEqual(RebalanceTransactionMemo.Rebalance);
            expect(result[0].transaction.to).toBe(mockQuoteResponse.quote.depositAddress);
            expect(result[0].transaction.value).toBe(BigInt(0)); // ERC20 transfer, not native ETH
            expect(result[0].transaction.data).toEqual('0x');

            // Verify encodeFunctionData was called with correct args
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [mockQuoteResponse.quote.depositAddress, BigInt(amountIn)],
            });
        });

        it('should prepare transaction request correctly for native ETH', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: zeroAddress,
                origin: 1,
                destination: 42161, // Use Arbitrum instead of chain 10
            };

            // Mock OneClickService.getQuote
            (OneClickService.getQuote as jest.Mock).mockResolvedValueOnce(mockQuoteResponse as never);

            const amount = '1000000000000000000'; // 1 ETH

            // Execute
            const senderAddress = '0x' + 'sender'.padStart(40, '0');
            const recipientAddress = '0x' + 'recipient'.padStart(40, '0');
            const result = await adapter.send(senderAddress, recipientAddress, amount, route);

            // Assert
            expect(result.length).toBe(1);
            expect(result[0].memo).toEqual(RebalanceTransactionMemo.Rebalance);
            expect(result[0].transaction.to).toBe(mockQuoteResponse.quote.depositAddress);
            expect(result[0].transaction.value).toBe(BigInt(mockQuoteResponse.quote.amountIn)); // Use quote amount, not original amount
            expect(result[0].transaction.data).toEqual('0x');
        });
    });

    // describe('readyOnDestination', () => {
    //     it('should return true if deposit is filled', async () => {
    //         // Mock route
    //         const route: RebalanceRoute = {
    //             asset: mockAssets['USDC'].address,
    //             origin: 1,
    //             destination: 10,
    //         };

    //         // Mock transaction receipt
    //         const mockReceipt: Partial<TransactionReceipt> = {
    //             transactionHash: '0xmocktxhash',
    //             blockHash: '0xmockblockhash',
    //             logs: [],
    //             logsBloom: '0x',
    //             blockNumber: BigInt(1234),
    //             contractAddress: null,
    //             effectiveGasPrice: BigInt(0),
    //             from: '0xsender',
    //             to: '0xDepositAddress',
    //             gasUsed: BigInt(0),
    //             cumulativeGasUsed: BigInt(0),
    //             status: 'success',
    //             type: 'eip1559',
    //             transactionIndex: 1,
    //         };

    //         // Mock getTransactionValue
    //         jest.spyOn(adapter, 'getTransactionValue').mockResolvedValue(BigInt('1000000000000000000'));

    //         // Mock the extractDepositAddress method
    //         jest.spyOn(adapter, 'extractDepositAddress').mockReturnValue('0xDepositAddress');

    //         // Mock OneClickService.getExecutionStatus
    //         (OneClickService.getExecutionStatus as jest.Mock).mockResolvedValueOnce(mockStatusResponse as never);

    //         // Execute
    //         const result = await adapter.readyOnDestination('1000000000', route, mockReceipt as TransactionReceipt);

    //         // Assert
    //         expect(result).toBe(true);
    //     });

    //     it('should return false if deposit is not yet filled', async () => {
    //         // Mock route
    //         const route: RebalanceRoute = {
    //             asset: mockAssets['USDC'].address,
    //             origin: 1,
    //             destination: 10,
    //         };

    //         // Mock transaction receipt
    //         const mockReceipt: Partial<TransactionReceipt> = {
    //             transactionHash: '0xmocktxhash',
    //             blockHash: '0xmockblockhash',
    //             logs: [],
    //             logsBloom: '0x',
    //             blockNumber: BigInt(1234),
    //             contractAddress: null,
    //             effectiveGasPrice: BigInt(0),
    //             from: '0xsender',
    //             to: '0xDepositAddress',
    //             gasUsed: BigInt(0),
    //             cumulativeGasUsed: BigInt(0),
    //             status: 'success',
    //             type: 'eip1559',
    //             transactionIndex: 1,
    //         };

    //         // Mock getTransactionValue
    //         jest.spyOn(adapter, 'getTransactionValue').mockResolvedValue(BigInt('1000000000000000000'));

    //         // Mock the extractDepositAddress method
    //         jest.spyOn(adapter, 'extractDepositAddress').mockReturnValue('0xDepositAddress');

    //         // Mock OneClickService.getExecutionStatus to return pending status
    //         (OneClickService.getExecutionStatus as jest.Mock).mockResolvedValueOnce({
    //             ...mockStatusResponse,
    //             status: 'PENDING',
    //         } as never);

    //         // Execute
    //         const result = await adapter.readyOnDestination('1000000000', route, mockReceipt as TransactionReceipt);

    //         // Assert
    //         expect(result).toBe(false);
    //     });
    // });

    describe('getSuggestedFees', () => {
        it('should fetch and return suggested fees', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC_ETH'].address,
                origin: 1,
                destination: 42161,
            };

            // Mock OneClickService.getQuote
            (OneClickService.getQuote as jest.Mock).mockResolvedValueOnce(mockQuoteResponse as never);

            // Execute
            const result = await adapter.getSuggestedFees(route, '0xBc8988C7a4b77c1d6df7546bd876Ea4D42DF0837', '0xBc8988C7a4b77c1d6df7546bd876Ea4D42DF0837', '1000000000');

            // Assert
            expect(result).toEqual(mockQuoteResponse);
            expect(OneClickService.getQuote).toHaveBeenCalledWith({
                dry: false,
                swapType: 'EXACT_INPUT',
                slippageTolerance: 10,
                depositType: 'ORIGIN_CHAIN',
                originAsset: expect.any(String),
                destinationAsset: expect.any(String),
                amount: '1000000000',
                refundTo: expect.any(String),
                refundType: 'ORIGIN_CHAIN',
                recipient: expect.any(String),
                recipientType: 'DESTINATION_CHAIN',
                deadline: expect.any(String),
            });
        });
    });

    describe('handleError', () => {
        it('should log and throw error with context', () => {
            const error = new Error('Test error');
            const context = 'test operation';
            const metadata = { test: 'data' };

            // Execute and expect error
            expect(() => adapter.handleError(error, context, metadata)).toThrow('Failed to test operation: Test error');

            // Assert logging
            expect(mockLogger.error).toHaveBeenCalledWith('Failed to test operation', {
                error: jsonifyError(error),
                test: 'data',
            });
        });
    });

    describe('validateAsset', () => {
        it('should throw error if asset is undefined', () => {
            expect(() => adapter.validateAsset(undefined, 'WETH', 'test')).toThrow('Missing asset configs for test');
        });

        it('should throw error if asset symbol does not match', () => {
            const asset = mockAssets['USDC_ETH'];
            expect(() => adapter.validateAsset(asset, 'WETH', 'test')).toThrow('Expected WETH, but found USDC');
        });

        it('should not throw error if asset symbol matches', () => {
            const asset = mockAssets['WETH'];
            expect(() => adapter.validateAsset(asset, 'WETH', 'test')).not.toThrow();
        });
    });

    describe('findMatchingDestinationAsset', () => {
        it('should find matching asset in destination chain', () => {
            const result = adapter.findMatchingDestinationAsset(mockAssets['USDC_ETH'].address, 1, 42161);

            expect(result).toEqual(mockAssets['USDC_ARB']);
        });

        it('should return undefined if origin chain not found', () => {
            const result = adapter.findMatchingDestinationAsset(mockAssets['USDC_ETH'].address, 999, 10);

            expect(result).toBeUndefined();
        });

        it('should return undefined if destination chain not found', () => {
            const result = adapter.findMatchingDestinationAsset(mockAssets['USDC_ETH'].address, 1, 999);

            expect(result).toBeUndefined();
        });

        it('should return undefined if asset not found in origin chain', () => {
            const result = adapter.findMatchingDestinationAsset('0xInvalidAddress', 1, 10);

            expect(result).toBeUndefined();
        });
    });

    describe('extractDepositAddress', () => {
        it('should extract deposit address from transaction receipt with logs', () => {
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [
                    {
                        address: '0xDepositAddress',
                        topics: ['0xTransfer'],
                        data: '0x',
                        blockNumber: BigInt(1234),
                        transactionHash: '0xmocktxhash',
                        transactionIndex: 1,
                        blockHash: '0xmockblockhash',
                        logIndex: 0,
                        removed: false,
                    },
                ],
                logsBloom: '0x',
                blockNumber: BigInt(1234),
                contractAddress: null,
                effectiveGasPrice: BigInt(0),
                from: '0xsender',
                to: '0xDepositAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            // Mock getDepositFromLogs to return a deposit
            (getDepositFromLogs as jest.Mock).mockReturnValue({
                receiverAddress: '0xReceiverAddress',
                amount: BigInt(1000),
                tokenAddress: '0xTokenAddress',
            });

            const result = adapter.extractDepositAddress(1, mockReceipt as TransactionReceipt, BigInt(1000));

            expect(result).toBe('0xReceiverAddress');
            expect(getDepositFromLogs).toHaveBeenCalledWith({
                originChainId: 1,
                receipt: mockReceipt,
                value: BigInt(1000),
            });
        });

        it('should return to address if no logs', () => {
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [],
                logsBloom: '0x',
                blockNumber: BigInt(1234),
                contractAddress: null,
                effectiveGasPrice: BigInt(0),
                from: '0xsender',
                to: '0xDepositAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            const result = adapter.extractDepositAddress(1, mockReceipt as TransactionReceipt, BigInt(1000));

            expect(result).toBe('0xDepositAddress');
        });

        it('should return undefined if getDepositFromLogs throws error', () => {
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [
                    {
                        address: '0xDepositAddress',
                        topics: ['0xTransfer'],
                        data: '0x',
                        blockNumber: BigInt(1234),
                        transactionHash: '0xmocktxhash',
                        transactionIndex: 1,
                        blockHash: '0xmockblockhash',
                        logIndex: 0,
                        removed: false,
                    },
                ],
                logsBloom: '0x',
                blockNumber: BigInt(1234),
                contractAddress: null,
                effectiveGasPrice: BigInt(0),
                from: '0xsender',
                to: '0xDepositAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            // Mock getDepositFromLogs to throw error
            (getDepositFromLogs as jest.Mock).mockImplementation(() => {
                throw new Error('No deposit log found.');
            });

            const result = adapter.extractDepositAddress(1, mockReceipt as TransactionReceipt, BigInt(1000));

            expect(result).toBeUndefined();
            expect(mockLogger.error).toHaveBeenCalledWith('Error extracting deposit ID from receipt', {
                error: {
                    name: 'Error',
                    message: 'No deposit log found.',
                    stack: expect.any(String),
                    context: {},
                },
                transactionHash: '0xmocktxhash',
            });
        });
    });

    describe('requiresCallback', () => {
        it('should throw error if origin asset is not found', async () => {
            const route: RebalanceRoute = {
                asset: '0xInvalidAddress',
                origin: 1,
                destination: 10,
            };

            await expect(adapter.requiresCallback(route, '0xDepositAddress', BigInt(1000), '0xfilltxhash')).rejects.toThrow(
                'Could not find origin asset',
            );
        });

        it('should return needsCallback=false if destination native asset is not ETH', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValueOnce({ ...mockAssets['ETH'], symbol: 'MATIC' });

            const result = await adapter.requiresCallback(route, '0xDepositAddress', BigInt(1000), '0xfilltxhash');

            expect(result).toEqual({ needsCallback: false });
        });

        it('should return needsCallback=false if provider is not available', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 42161,
            };

            // Mock chains without provider for 42161
            const mockChainsWithoutProvider = {
                ...mockChains,
                '42161': { ...mockChains['42161'], providers: [] },
            };
            adapter = new TestNearBridgeAdapter(
                mockChainsWithoutProvider as Record<string, ChainConfiguration>,
                mockLogger,
            );

            jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValueOnce(mockAssets['ETH']);

            const result = await adapter.requiresCallback(route, '0xDepositAddress', BigInt(1000), '0xfilltxhash');

            expect(result).toEqual({ needsCallback: false });
        });

        it('should return needsCallback=true when output token is zero hash (native ETH)', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 42161,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValueOnce(mockAssets['ETH']);

            const mockReceipt = {
                logs: [],
                transactionHash: '0xfilltxhash',
                blockHash: '0xblockhash',
                blockNumber: BigInt(1234),
                contractAddress: null,
                effectiveGasPrice: BigInt(0),
                from: '0xsender',
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
                logsBloom: '0x',
            } as TransactionReceipt;

            const mockTransaction = {
                value: BigInt('1000000000000000000'),
            };

            const mockGetReceipt = jest.fn().mockResolvedValue(mockReceipt as never);
            const mockGetTransaction = jest.fn().mockResolvedValue(mockTransaction as never);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt,
                getTransaction: mockGetTransaction,
                getBalance: jest.fn().mockResolvedValue(BigInt('1000000000000000000') as never),
            });

            // Mock parseDepositLogs to return ETH output
            (parseDepositLogs as jest.Mock).mockReturnValue({
                tokenAddress: zeroAddress,
                receiverAddress: '0xRecipient',
                amount: BigInt('1000000000000000000'),
            });

            const result = await adapter.requiresCallback(route, '0xDepositAddress', BigInt(1000), '0xfilltxhash');

            expect(result).toEqual({
                needsCallback: true,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient',
            });
        });

        it('should return needsCallback=true when output token is WETH and balance is sufficient', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 42161,
            };

            jest
                .spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['ETH'])
                .mockReturnValueOnce(mockAssets['WETH']);

            const mockReceipt = {
                logs: [],
                transactionHash: '0xfilltxhash',
                blockHash: '0xblockhash',
                blockNumber: BigInt(1234),
                contractAddress: null,
                effectiveGasPrice: BigInt(0),
                from: '0xsender',
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
                logsBloom: '0x',
            } as TransactionReceipt;

            const mockTransaction = {
                value: BigInt('1000000000000000000'),
            };

            const mockGetReceipt = jest.fn().mockResolvedValue(mockReceipt as never);
            const mockGetTransaction = jest.fn().mockResolvedValue(mockTransaction as never);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt,
                getTransaction: mockGetTransaction,
                getBalance: jest.fn().mockResolvedValue(BigInt('1000000000000000000') as never),
            });

            // Mock parseDepositLogs to return WETH output
            (parseDepositLogs as jest.Mock).mockReturnValue({
                tokenAddress: mockAssets['WETH'].address,
                receiverAddress: '0xRecipient',
                amount: BigInt('1000000000000000000'),
            });

            const result = await adapter.requiresCallback(route, '0xDepositAddress', BigInt(1000), '0xfilltxhash');

            expect(result).toEqual({
                needsCallback: true,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient',
                asset: mockAssets['WETH'],
            });
        });

        it('should return needsCallback=false when output token is not WETH', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 42161,
            };

            jest
                .spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['ETH'])
                .mockReturnValueOnce(mockAssets['USDC_ARB']);

            const mockReceipt = {
                logs: [],
                transactionHash: '0xfilltxhash',
                blockHash: '0xblockhash',
                blockNumber: BigInt(1234),
                contractAddress: null,
                effectiveGasPrice: BigInt(0),
                from: '0xsender',
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
                logsBloom: '0x',
            } as TransactionReceipt;

            const mockTransaction = {
                value: BigInt('1000000000000000000'),
            };

            const mockGetReceipt = jest.fn().mockResolvedValue(mockReceipt as never);
            const mockGetTransaction = jest.fn().mockResolvedValue(mockTransaction as never);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt,
                getTransaction: mockGetTransaction,
                getBalance: jest.fn().mockResolvedValue(BigInt('1000000000000000000') as never),
            });

            // Mock parseDepositLogs to return USDC output
            (parseDepositLogs as jest.Mock).mockReturnValue({
                tokenAddress: '0xDifferentTokenAddress', // Use a different address than USDC_ARB
                receiverAddress: '0xRecipient',
                amount: BigInt('1000000000000000000'),
            });

            const result = await adapter.requiresCallback(route, '0xDepositAddress', BigInt(1000), '0xfilltxhash');

            expect(result).toEqual({
                needsCallback: false,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient',
            });
        });
    });
});
