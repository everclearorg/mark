import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import axios from 'axios';
import { jsonifyError, Logger } from '@mark/logger';
import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import { AcrossBridgeAdapter, FILLED_V3_RELAY_TOPIC, WETH_WITHDRAWAL_TOPIC } from '../../../src/adapters/across/across';
import { SuggestedFeesResponse, DepositStatusResponse } from '../../../src/adapters/across/types';
import {
    TransactionReceipt,
    createPublicClient,
    decodeEventLog,
    padHex,
} from 'viem';
import { RebalanceRoute } from '../../../src/types';
import { Transaction } from 'ethers';

// Mock the external dependencies
jest.mock('axios');
jest.mock('viem');
jest.mock('@mark/logger');

// Test adapter that exposes private methods
class TestAcrossBridgeAdapter extends AcrossBridgeAdapter {
    public getSuggestedFees(route: RebalanceRoute, amount: string): Promise<SuggestedFeesResponse> {
        return super.getSuggestedFees(route, amount);
    }

    public getDepositStatusFromApi(route: RebalanceRoute, depositId: number): Promise<DepositStatusResponse> {
        return super.getDepositStatusFromApi(route, depositId);
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

    public extractDepositId(receipt: TransactionReceipt): number | undefined {
        return super.extractDepositId(receipt);
    }

    public requiresCallback(route: RebalanceRoute, fillTxHash: string): Promise<{
        needsCallback: boolean;
        amount?: bigint;
        recipient?: string;
    }> {
        return super.requiresCallback(route, fillTxHash);
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
const mockUrl = 'https://across-api.example.com';

const mockAssets: Record<string, AssetConfiguration> = {
    'ETH': {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH',
        decimals: 18,
        tickerHash: '0xETHHash',
        isNative: true,
        balanceThreshold: '0',
    },
    'WETH': {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        symbol: 'WETH',
        decimals: 18,
        tickerHash: '0xWETHHash',
        isNative: false,
        balanceThreshold: '0',
    },
    'USDC': {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: 18,
        tickerHash: '0xUSDCHash',
        isNative: false,
        balanceThreshold: '0',
    }
};

const mockChains: Record<string, any> = {
    '1': {
        assets: Object.values(mockAssets),
        providers: ['https://base-mainnet.example.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
    '10': {
        assets: Object.values(mockAssets),
        providers: ['https://opt-mainnet.example.com'],
        invoiceAge: 3600,
        gasThreshold: '100000000000',
        deployments: {
            everclear: '0xEverclearAddress',
            permit2: '0xPermit2Address',
            multicall3: '0xMulticall3Address',
        },
    },
};

describe('AcrossBridgeAdapter', () => {
    let adapter: TestAcrossBridgeAdapter;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Reset all mock implementations
        (axios.get as jest.Mock).mockReset();
        (createPublicClient as jest.Mock).mockReset();
        (decodeEventLog as jest.Mock).mockReset();

        // Reset logger mocks
        mockLogger.debug.mockReset();
        mockLogger.info.mockReset();
        mockLogger.warn.mockReset();
        mockLogger.error.mockReset();

        // Create fresh adapter instance
        adapter = new TestAcrossBridgeAdapter(mockUrl, mockChains as Record<string, ChainConfiguration>, mockLogger);
    });

    describe('constructor', () => {
        it('should initialize correctly', () => {
            expect(adapter).toBeDefined();
            expect(mockLogger.debug).toHaveBeenCalledWith('Initializing AcrossBridgeAdapter', { url: mockUrl });
        });
    });

    describe('type', () => {
        it('should return the correct type', () => {
            expect(adapter.type()).toBe('across');
        });
    });

    describe('getReceivedAmount', () => {
        it('should calculate received amount correctly after subtracting fees', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock API response
            const mockFeesResponse: SuggestedFeesResponse = {
                totalRelayFee: {
                    total: '100000', // 0.1 USDC
                    pct: '0.001',
                },
                lpFee: {
                    total: '50000', // 0.05 USDC
                    pct: '0.0005',
                },
                relayerCapitalFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerGasFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                isAmountTooLow: false,
                spokePoolAddress: '0xSpokePoolAddress',
            };

            // Mock the findMatchingDestinationAsset method to return just the address
            jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue({
                ...mockAssets['USDC'],
                address: mockAssets['USDC'].address,
            });

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockFeesResponse });

            // Execute
            const amount = '10000000'; // 10 USDC
            const result = await adapter.getReceivedAmount(amount, route);

            // Expected: 10 USDC - 0.1 USDC - 0.05 USDC = 9.85 USDC
            expect(result).toBe('9850000');
            expect(axios.get).toHaveBeenCalledWith(`${mockUrl}/suggested-fees`, {
                params: {
                    inputToken: route.asset,
                    outputToken: mockAssets['USDC'].address,
                    originChainId: route.origin,
                    destinationChainId: route.destination,
                    amount: '10000000',
                },
            });
        });

        it('should throw an error if the API request fails', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockRejectedValueOnce(new Error('API error'));

            // Execute and expect error
            await expect(adapter.getReceivedAmount('10000000', route)).rejects.toThrow(
                'Failed to get received amount from Across'
            );
        });

        it('should throw an error if amount is too low', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock API response with isAmountTooLow=true
            const mockFeesResponse: SuggestedFeesResponse = {
                totalRelayFee: {
                    total: '100000',
                    pct: '0.001',
                },
                lpFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerCapitalFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerGasFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                isAmountTooLow: true,
                spokePoolAddress: '0xSpokePoolAddress',
            };

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockFeesResponse });

            // Execute and expect error
            await expect(adapter.getReceivedAmount('100', route)).rejects.toThrow(
                'Amount is too low for suggested route via across'
            );
        });
    });

    describe('send', () => {
        it('should prepare transaction request correctly', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock API response
            const mockFeesResponse: SuggestedFeesResponse = {
                totalRelayFee: {
                    total: '100000',
                    pct: '0.001',
                },
                lpFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerCapitalFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerGasFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                isAmountTooLow: false,
                spokePoolAddress: '0xSpokePoolAddress',
            };

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockFeesResponse });

            // Execute
            const amount = '10000000'; // 10 USDC
            const result = await adapter.send(amount, route);

            // Assert
            expect(result).toEqual({
                to: '0xSpokePoolAddress',
                data: '0x',
                value: BigInt(0),
            });
        });

        it('should throw an error if amount is too low', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock API response with isAmountTooLow=true
            const mockFeesResponse: SuggestedFeesResponse = {
                totalRelayFee: {
                    total: '100000',
                    pct: '0.001',
                },
                lpFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerCapitalFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerGasFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                isAmountTooLow: true,
                spokePoolAddress: '0xSpokePoolAddress',
            };

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockFeesResponse });

            // Execute and expect error
            await expect(adapter.send('1000', route)).rejects.toThrow(
                'Amount is too low for bridging via Across'
            );
        });
    });

    describe('destinationCallback', () => {
        it('should return a transaction to wrap ETH to WETH if needed', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            // Mock transaction receipt
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [
                    {
                        address: '0xSpokePoolAddress',
                        topics: [
                            '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
                            '0x0000000000000000000000000000000000000000000000000000000000000123',
                        ],
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
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            // Mock deposit status response
            const mockStatusResponse: DepositStatusResponse = {
                fillStatus: 'filled',
                fillTxHash: '0xfilltxhash',
                destinationChainId: 10,
            };

            // Mock the extractDepositId method
            jest.spyOn(adapter, 'extractDepositId').mockReturnValue(291);

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockStatusResponse });

            // Mock the requiresCallback function
            jest.spyOn(adapter, 'requiresCallback').mockResolvedValue({
                needsCallback: true,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient',
            });

            // Execute
            const result = await adapter.destinationCallback('1000000000000000000', route, mockReceipt as TransactionReceipt);

            // Assert
            expect(result).toEqual({
                to: mockAssets['WETH'].address,
                data: '0xd0e30db0',
                value: BigInt('1000000000000000000'),
            });
        });

        it('should return void if no callback is needed', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock transaction receipt
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [
                    {
                        address: '0xSpokePoolAddress',
                        topics: [
                            '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
                            '0x0000000000000000000000000000000000000000000000000000000000000123',
                        ],
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
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            // Mock deposit status response
            const mockStatusResponse: DepositStatusResponse = {
                fillStatus: 'filled',
                fillTxHash: '0xfilltxhash',
                destinationChainId: 10,
            };

            // Mock the extractDepositId method
            jest.spyOn(adapter, 'extractDepositId').mockReturnValue(291);

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockStatusResponse });

            // Mock the requiresCallback function
            jest.spyOn(adapter, 'requiresCallback').mockResolvedValue({
                needsCallback: false,
            });

            // Execute
            const result = await adapter.destinationCallback('1000000', route, mockReceipt as TransactionReceipt);

            // Assert
            expect(result).toBeUndefined();
        });
    });

    describe('readyOnDestination', () => {
        it('should return true if deposit is filled', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock transaction receipt
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [
                    {
                        address: '0xSpokePoolAddress',
                        topics: [
                            '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
                            '0x0000000000000000000000000000000000000000000000000000000000000123',
                        ],
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
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            // Mock deposit status response
            const mockStatusResponse: DepositStatusResponse = {
                fillStatus: 'filled',
                fillTxHash: '0xfilltxhash',
                destinationChainId: 10,
            };

            // Mock the extractDepositId method
            jest.spyOn(adapter, 'extractDepositId').mockReturnValue(291);

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockStatusResponse });

            // Execute
            const result = await adapter.readyOnDestination('10000000', route, mockReceipt as TransactionReceipt);

            // Assert
            expect(result).toBe(true);
            expect(axios.get).toHaveBeenCalledWith(`${mockUrl}/deposit/status`, {
                params: {
                    originChainId: route.origin,
                    depositId: 291,
                },
            });
        });

        it('should return false if deposit is not yet filled', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock transaction receipt
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [
                    {
                        address: '0xSpokePoolAddress',
                        topics: [
                            '0x97116cf3d0582d2027cf5c8ea33be4b7f9df9b1d9b8de5ddcf7e5b776ab99d31',
                            '0x0000000000000000000000000000000000000000000000000000000000000123',
                        ],
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
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            // Mock deposit status response
            const mockStatusResponse: DepositStatusResponse = {
                fillStatus: 'pending',
                destinationChainId: 10,
            };

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockStatusResponse });

            // Execute
            const result = await adapter.readyOnDestination('10000000', route, mockReceipt as TransactionReceipt);

            // Assert
            expect(result).toBe(false);
        });
    });

    describe('getSuggestedFees', () => {
        it('should fetch and return suggested fees', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock API response
            const mockFeesResponse: SuggestedFeesResponse = {
                totalRelayFee: {
                    total: '100000',
                    pct: '0.001',
                },
                lpFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerCapitalFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                relayerGasFee: {
                    total: '50000',
                    pct: '0.0005',
                },
                isAmountTooLow: false,
                spokePoolAddress: '0xSpokePoolAddress',
            };

            // Mock the findMatchingDestinationAsset method
            jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue({
                ...mockAssets['USDC'],
                address: mockAssets['USDC'].address,
            });

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockFeesResponse });

            // Execute
            const result = await adapter.getSuggestedFees(route, '10000000');

            // Assert
            expect(result).toEqual(mockFeesResponse);
            expect(axios.get).toHaveBeenCalledWith(`${mockUrl}/suggested-fees`, {
                params: {
                    inputToken: route.asset,
                    outputToken: mockAssets['USDC'].address,
                    originChainId: route.origin,
                    destinationChainId: route.destination,
                    amount: '10000000',
                },
            });
        });
    });

    describe('getDepositStatusFromApi', () => {
        it('should fetch and return deposit status', async () => {
            // Mock route
            const route: RebalanceRoute = {
                asset: mockAssets['USDC'].address,
                origin: 1,
                destination: 10,
            };

            // Mock API response
            const mockStatusResponse: DepositStatusResponse = {
                fillStatus: 'filled',
                fillTxHash: '0xfilltxhash',
                destinationChainId: 10,
            };

            // @ts-ignore - ignoring axios type errors for the mock
            (axios.get as jest.Mock).mockResolvedValueOnce({ data: mockStatusResponse });

            // Execute
            const result = await adapter.getDepositStatusFromApi(route, 291);

            // Assert
            expect(result).toEqual(mockStatusResponse);
            expect(axios.get).toHaveBeenCalledWith(`${mockUrl}/deposit/status`, {
                params: {
                    originChainId: route.origin,
                    depositId: 291,
                },
            });
        });
    });

    describe('handleError', () => {
        it('should log and throw error with context', () => {
            const error = new Error('Test error');
            const context = 'test operation';
            const metadata = { test: 'data' };

            // Execute and expect error
            expect(() => adapter.handleError(error, context, metadata)).toThrow(
                'Failed to test operation: Test error'
            );

            // Assert logging
            expect(mockLogger.error).toHaveBeenCalledWith('Failed to test operation', {
                error: jsonifyError(error),
                test: 'data',
            });
        });
    });

    describe('validateAsset', () => {
        it('should throw error if asset is undefined', () => {
            expect(() => adapter.validateAsset(undefined, 'WETH', 'test')).toThrow(
                'Missing asset configs for test'
            );
        });

        it('should throw error if asset symbol does not match', () => {
            const asset = mockAssets['USDC'];
            expect(() => adapter.validateAsset(asset, 'WETH', 'test')).toThrow(
                'Expected WETH, but found USDC'
            );
        });

        it('should not throw error if asset symbol matches', () => {
            const asset = mockAssets['WETH'];
            expect(() => adapter.validateAsset(asset, 'WETH', 'test')).not.toThrow();
        });
    });

    describe('findMatchingDestinationAsset', () => {
        it('should find matching asset in destination chain', () => {
            const result = adapter.findMatchingDestinationAsset(
                mockAssets['USDC'].address,
                1,
                10
            );

            expect(result).toEqual(mockAssets['USDC']);
        });

        it('should return undefined if origin chain not found', () => {
            const result = adapter.findMatchingDestinationAsset(
                mockAssets['USDC'].address,
                999,
                10
            );

            expect(result).toBeUndefined();
        });

        it('should return undefined if destination chain not found', () => {
            const result = adapter.findMatchingDestinationAsset(
                mockAssets['USDC'].address,
                1,
                999
            );

            expect(result).toBeUndefined();
        });

        it('should return undefined if asset not found in origin chain', () => {
            const result = adapter.findMatchingDestinationAsset(
                '0xInvalidAddress',
                1,
                10
            );

            expect(result).toBeUndefined();
        });
    });

    describe('extractDepositId', () => {
        it('should extract deposit ID from transaction receipt', () => {
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [
                    {
                        address: '0xSpokePoolAddress',
                        topics: [
                            undefined,
                            '0x0000000000000000000000000000000000000000000000000000000000000123',
                        ] as any,
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
                to: '0xSpokePoolAddress',
                gasUsed: BigInt(0),
                cumulativeGasUsed: BigInt(0),
                status: 'success',
                type: 'eip1559',
                transactionIndex: 1,
            };

            // Mock decodeEventLog
            (decodeEventLog as jest.Mock).mockReturnValue({
                args: {
                    depositId: BigInt(291),
                },
            });

            const result = adapter.extractDepositId(mockReceipt as TransactionReceipt);

            expect(result).toBe(291);
        });

        it('should return undefined if no deposit event found', () => {
            const mockReceipt: Partial<TransactionReceipt> = {
                transactionHash: '0xmocktxhash',
                blockHash: '0xmockblockhash',
                logs: [],
                logsBloom: '0x',
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
            };

            const result = adapter.extractDepositId(mockReceipt as TransactionReceipt);

            expect(result).toBeUndefined();
        });
    });

    describe('requiresCallback', () => {
        it('should throw error if origin asset is not found', async () => {
            const route: RebalanceRoute = {
                asset: '0xInvalidAddress',
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset').mockReturnValue(undefined);

            await expect(adapter.requiresCallback(route, '0xfilltxhash')).rejects.toThrow(
                'Could not find origin asset'
            );
        });

        it('should return needsCallback=false if destination native asset is not ETH', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce({ ...mockAssets['ETH'], symbol: 'MATIC' });

            const result = await adapter.requiresCallback(route, '0xfilltxhash');

            expect(result).toEqual({ needsCallback: false });
        });

        it('should return needsCallback=false if provider is not available', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce(mockAssets['ETH']);

            // Mock chains without provider
            const mockChainsWithoutProvider = {
                ...mockChains,
                '10': { ...mockChains['10'], providers: [] }
            };
            adapter = new TestAcrossBridgeAdapter(mockUrl, mockChainsWithoutProvider as Record<string, ChainConfiguration>, mockLogger);

            const result = await adapter.requiresCallback(route, '0xfilltxhash');

            expect(result).toEqual({ needsCallback: false });
        });

        it('should throw error if no fill event is found', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce(mockAssets['ETH']);

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
                logsBloom: '0x'
            } as TransactionReceipt;

            const mockGetReceipt = jest.fn<(args: { hash: string }) => Promise<Transaction>>().mockResolvedValue(mockReceipt as any);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt
            });

            await expect(adapter.requiresCallback(route, '0xfilltxhash')).rejects.toThrow(
                'No fill event found for fill tx hash'
            );
        });

        it('should throw error if fill event cannot be parsed', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce(mockAssets['ETH']);

            const mockReceipt = {
                logs: [{
                    topics: [FILLED_V3_RELAY_TOPIC],
                    data: '0x',
                    address: '0xSpokePoolAddress',
                    blockNumber: BigInt(1234),
                    transactionHash: '0xfilltxhash',
                    transactionIndex: 1,
                    blockHash: '0xblockhash',
                    logIndex: 0,
                    removed: false
                }],
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
                logsBloom: '0x'
            } as TransactionReceipt;

            const mockGetReceipt = jest.fn<(args: { hash: string }) => Promise<Transaction>>().mockResolvedValue(mockReceipt as any);
            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt
            });

            // Mock decodeEventLog to return an object missing required fields
            (decodeEventLog as jest.Mock).mockReturnValue({
                args: {
                    // Missing outputToken, recipient, and outputAmount
                    someOtherField: 'value'
                }
            });

            await expect(adapter.requiresCallback(route, '0xfilltxhash')).rejects.toThrow(
                'Failed to parse logs for fill event'
            );
        });

        it('should return needsCallback=true when output token is zero hash (native ETH)', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce(mockAssets['ETH']);

            const mockReceipt = {
                logs: [{
                    topics: [FILLED_V3_RELAY_TOPIC],
                    data: '0x',
                    address: '0xSpokePoolAddress',
                    blockNumber: BigInt(1234),
                    transactionHash: '0xfilltxhash',
                    transactionIndex: 1,
                    blockHash: '0xblockhash',
                    logIndex: 0,
                    removed: false
                }],
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
                logsBloom: '0x'
            } as TransactionReceipt;

            const mockGetReceipt = jest.fn<(args: { hash: string }) => Promise<Transaction>>().mockResolvedValue(mockReceipt as any);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt
            });

            (decodeEventLog as jest.Mock).mockReturnValue({
                args: {
                    outputToken: '0x0000000000000000000000000000000000000000000000000000000000000000',
                    recipient: '0xRecipient',
                    outputAmount: '1000000000000000000'
                }
            });

            const result = await adapter.requiresCallback(route, '0xfilltxhash');

            expect(result).toEqual({
                needsCallback: true,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient'
            });
        });

        it('should return needsCallback=true when output token is WETH and has been withdrawn', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce(mockAssets['ETH'])
                .mockReturnValueOnce(mockAssets['WETH']);

            const mockReceipt = {
                logs: [
                    {
                        topics: [FILLED_V3_RELAY_TOPIC],
                        data: '0x',
                        address: '0xSpokePoolAddress',
                        blockNumber: BigInt(1234),
                        transactionHash: '0xfilltxhash',
                        transactionIndex: 1,
                        blockHash: '0xblockhash',
                        logIndex: 0,
                        removed: false
                    },
                    {
                        topics: [WETH_WITHDRAWAL_TOPIC],
                        data: '0x',
                        address: '0xSpokePoolAddress',
                        blockNumber: BigInt(1234),
                        transactionHash: '0xfilltxhash',
                        transactionIndex: 1,
                        blockHash: '0xblockhash',
                        logIndex: 1,
                        removed: false
                    }
                ],
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
                logsBloom: '0x'
            } as TransactionReceipt;

            const mockGetReceipt = jest.fn<(args: { hash: string }) => Promise<Transaction>>().mockResolvedValue(mockReceipt as any);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt
            });

            (decodeEventLog as jest.Mock).mockReturnValue({
                args: {
                    outputToken: padHex(mockAssets['WETH'].address as `0x${string}`, { size: 32 }),
                    recipient: '0xRecipient',
                    outputAmount: '1000000000000000000'
                }
            });

            const result = await adapter.requiresCallback(route, '0xfilltxhash');

            expect(result).toEqual({
                needsCallback: true,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient'
            });
        });

        it('should return needsCallback=false when output token is WETH but has not been withdrawn', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce(mockAssets['ETH'])
                .mockReturnValueOnce(mockAssets['WETH']);

            const mockReceipt = {
                logs: [{
                    topics: [FILLED_V3_RELAY_TOPIC],
                    data: '0x',
                    address: '0xSpokePoolAddress',
                    blockNumber: BigInt(1234),
                    transactionHash: '0xfilltxhash',
                    transactionIndex: 1,
                    blockHash: '0xblockhash',
                    logIndex: 0,
                    removed: false
                }],
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
                logsBloom: '0x'
            } as TransactionReceipt;

            const mockGetReceipt = jest.fn<(args: { hash: string }) => Promise<Transaction>>().mockResolvedValue(mockReceipt as any);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt
            });

            (decodeEventLog as jest.Mock).mockReturnValue({
                args: {
                    outputToken: padHex(mockAssets['WETH'].address as `0x${string}`, { size: 32 }),
                    recipient: '0xRecipient',
                    outputAmount: '1000000000000000000'
                }
            });

            const result = await adapter.requiresCallback(route, '0xfilltxhash');

            expect(result).toEqual({
                needsCallback: false,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient'
            });
        });

        it('should return needsCallback=false when output token is not WETH', async () => {
            const route: RebalanceRoute = {
                asset: mockAssets['WETH'].address,
                origin: 1,
                destination: 10,
            };

            jest.spyOn(adapter, 'findMatchingDestinationAsset')
                .mockReturnValueOnce(mockAssets['WETH'])
                .mockReturnValueOnce(mockAssets['ETH'])
                .mockReturnValueOnce(mockAssets['USDC']);

            const mockReceipt = {
                logs: [{
                    topics: [FILLED_V3_RELAY_TOPIC],
                    data: '0x',
                    address: '0xSpokePoolAddress',
                    blockNumber: BigInt(1234),
                    transactionHash: '0xfilltxhash',
                    transactionIndex: 1,
                    blockHash: '0xblockhash',
                    logIndex: 0,
                    removed: false
                }],
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
                logsBloom: '0x'
            } as TransactionReceipt;

            const mockGetReceipt = jest.fn<(args: { hash: string }) => Promise<Transaction>>().mockResolvedValue(mockReceipt as any);

            (createPublicClient as jest.Mock).mockReturnValue({
                getTransactionReceipt: mockGetReceipt
            });

            (decodeEventLog as jest.Mock).mockReturnValue({
                args: {
                    outputToken: padHex(mockAssets['USDC'].address as `0x${string}`, { size: 32 }),
                    recipient: '0xRecipient',
                    outputAmount: '1000000000000000000'
                }
            });

            const result = await adapter.requiresCallback(route, '0xfilltxhash');

            expect(result).toEqual({
                needsCallback: false,
                amount: BigInt('1000000000000000000'),
                recipient: '0xRecipient'
            });
        });
    });

}); 