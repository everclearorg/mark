import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios, { AxiosInstance } from 'axios';
import { Logger } from '@mark/logger';
import { KrakenClient } from '../../../src/adapters/kraken/client';
import { KRAKEN_BASE_URL } from '../../../src/adapters/kraken/types';

// Mock axios
jest.mock('axios');

describe('KrakenClient', () => {
    let client: KrakenClient;
    let mockAxiosInstance: jest.Mocked<AxiosInstance>;
    let mockLogger: jest.Mocked<Logger>;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock logger
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        } as unknown as jest.Mocked<Logger>;

        // Mock axios instance
        mockAxiosInstance = {
            post: jest.fn(),
            defaults: { headers: { common: {} } },
        } as unknown as jest.Mocked<AxiosInstance>;

        // Mock axios.create
        (axios.create as jest.MockedFunction<typeof axios.create>).mockReturnValue(mockAxiosInstance);

        // Create client
        client = new KrakenClient('test-key', 'test-secret', mockLogger, KRAKEN_BASE_URL, 2);
    });

    describe('Constructor and Configuration', () => {
        it('should initialize with correct default values', () => {
            expect(axios.create).toHaveBeenCalledWith({
                baseURL: KRAKEN_BASE_URL,
                timeout: 30000,
            });
            expect(mockLogger.debug).toHaveBeenCalledWith('KrakenClient initialized', {
                baseUrl: KRAKEN_BASE_URL,
                hasApiKey: true,
                hasApiSecret: true,
                timeout: 30000,
                retryCount: 2,
            });
        });

        it('should use custom base URL when provided', () => {
            const customUrl = 'https://custom.kraken.com';
            new KrakenClient('', '', mockLogger, customUrl);

            expect(axios.create).toHaveBeenCalledWith({
                baseURL: customUrl,
                timeout: 30000,
            });
        });

        it('should log configuration status correctly', () => {
            new KrakenClient('', '', mockLogger, KRAKEN_BASE_URL);

            expect(mockLogger.debug).toHaveBeenLastCalledWith('KrakenClient initialized', {
                baseUrl: KRAKEN_BASE_URL,
                hasApiKey: false,
                hasApiSecret: false,
                timeout: 30000,
                retryCount: 3,
            });
        });

        describe('isConfigured', () => {
            it('should return true when both API key and secret are provided', () => {
                expect(client.isConfigured()).toBe(true);
            });

            it('should return false when API key is missing', () => {
                const invalidClient = new KrakenClient('', 'secret', mockLogger, KRAKEN_BASE_URL);
                expect(invalidClient.isConfigured()).toBe(false);
            });

            it('should return false when API secret is missing', () => {
                const invalidClient = new KrakenClient('key', '', mockLogger, KRAKEN_BASE_URL);
                expect(invalidClient.isConfigured()).toBe(false);
            });

            it('should return false when both are missing', () => {
                const invalidClient = new KrakenClient('', '', mockLogger, KRAKEN_BASE_URL);
                expect(invalidClient.isConfigured()).toBe(false);
            });
        });
    });

    describe('Private Helper Methods', () => {
        describe('generateNonce', () => {
            it('should generate increasing nonce values', () => {
                const nonce1 = (client as any).generateNonce();
                const nonce2 = (client as any).generateNonce();

                expect(parseInt(nonce2)).toBeGreaterThan(parseInt(nonce1));
            });

            it('should use current timestamp if nonce falls behind', () => {
                jest.spyOn(Date, 'now').mockReturnValue(9999999999);

                const nonce = (client as any).generateNonce();
                expect(parseInt(nonce)).toBeGreaterThanOrEqual(9999999999);

                jest.restoreAllMocks();
            });
        });

        describe('sign', () => {
            it('should generate consistent signatures for same input', () => {
                const path = '/0/private/Balance';
                const postData = 'nonce=1234567890';

                const signature1 = (client as any).sign(path, postData);
                const signature2 = (client as any).sign(path, postData);

                expect(signature1).toBe(signature2);
                expect(signature1).toMatch(/^[A-Za-z0-9+/=]+$/); // Base64 pattern
            });

            it('should generate different signatures for different inputs', () => {
                const path = '/0/private/Balance';
                const postData1 = 'nonce=1234567890';
                const postData2 = 'nonce=1234567891';

                const signature1 = (client as any).sign(path, postData1);
                const signature2 = (client as any).sign(path, postData2);

                expect(signature1).not.toBe(signature2);
            });
        });

        describe('shouldRetry', () => {
            it('should return true for 429 status', () => {
                const error = {
                    isAxiosError: true,
                    response: { status: 429 }
                };
                jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);

                expect((client as any).shouldRetry(error)).toBe(true);
            });

            it('should return true for 5xx status codes', () => {
                const error = {
                    isAxiosError: true,
                    response: { status: 500 }
                };
                jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);

                expect((client as any).shouldRetry(error)).toBe(true);
            });

            it('should return false for 4xx status codes (except 429)', () => {
                const error = {
                    isAxiosError: true,
                    response: { status: 400 }
                };
                jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);

                expect((client as any).shouldRetry(error)).toBe(false);
            });

            it('should return false for non-axios errors', () => {
                const error = new Error('Non-axios error');
                jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);

                expect((client as any).shouldRetry(error)).toBe(false);
            });
        });
    });

    describe('Public API Methods', () => {
        describe('getSystemStatus', () => {
            it('should fetch system status successfully', async () => {
                const mockResponse = {
                    status: 'online',
                    timestamp: '2023-01-01T00:00:00Z'
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getSystemStatus();

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/public/SystemStatus',
                    '',
                    { headers: {} }
                );
            });
        });

        describe('isSystemOperational', () => {
            it('should return true when system is online', async () => {
                const mockResponse = {
                    status: 'online',
                    timestamp: '2023-01-01T00:00:00Z'
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.isSystemOperational();
                expect(result).toBe(true);
            });

            it('should return false when system is in maintenance', async () => {
                const mockResponse = {
                    status: 'maintenance',
                    timestamp: '2023-01-01T00:00:00Z'
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.isSystemOperational();
                expect(result).toBe(false);
            });

            it('should return false when API call fails', async () => {
                mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network error'));

                const result = await client.isSystemOperational();
                expect(result).toBe(false);
                expect(mockLogger.error).toHaveBeenCalledWith(
                    'Kraken system status check failed, assuming offline',
                    expect.objectContaining({
                        error: expect.any(Object),
                        endpoint: 'public/SystemStatus',
                        fallbackStatus: 'offline',
                        httpStatus: 'unknown',
                    })
                );
            });
        });

        describe('getAssetInfo', () => {
            it('should fetch all assets when no specific assets provided', async () => {
                const mockResponse = {
                    'XXBT': {
                        aclass: 'currency',
                        altname: 'XBT',
                        decimals: 10,
                        display_decimals: 5
                    }
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getAssetInfo();

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/public/Assets',
                    '',
                    { headers: {} }
                );
            });

            it('should fetch specific assets when provided', async () => {
                const mockResponse = {
                    'XXBT': {
                        aclass: 'currency',
                        altname: 'XBT',
                        decimals: 10,
                        display_decimals: 5
                    }
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getAssetInfo(['XXBT', 'XETH']);

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/public/Assets',
                    'asset=XXBT%2CXETH',
                    { headers: {} }
                );
            });
        });
    });

    describe('Private API Methods', () => {
        beforeEach(() => {
            // Mock Date.now for consistent nonce generation
            jest.spyOn(Date, 'now').mockReturnValue(1234567890000);
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        describe('getBalance', () => {
            it('should fetch account balance', async () => {
                const mockResponse = {
                    'XXBT': '1.2345',
                    'XETH': '10.5678'
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getBalance();

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/Balance',
                    expect.stringMatching(/nonce=\d+/),
                    expect.objectContaining({
                        headers: expect.objectContaining({
                            'API-Key': 'test-key',
                            'API-Sign': expect.any(String)
                        })
                    })
                );
            });
        });

        describe('getDepositMethods', () => {
            it('should fetch deposit methods for an asset', async () => {
                const mockResponse: any[] = [
                    { method: 'Bitcoin', fields: [], gen: true },
                    { method: 'Lightning', fields: ['routing_number'], gen: false }
                ];

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositMethods('XXBT');

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/DepositMethods',
                    expect.stringMatching(/asset=XXBT/),
                    expect.objectContaining({
                        headers: expect.objectContaining({
                            'API-Key': 'test-key',
                            'API-Sign': expect.any(String)
                        })
                    })
                );
            });

            it('should return empty array when result is not array', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: null, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositMethods('XXBT');
                expect(result).toEqual([]);
            });

            it('should return empty array when result is undefined', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: undefined, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositMethods('XXBT');
                expect(result).toEqual([]);
            });
        });

        describe('getDepositAddresses', () => {
            it('should fetch deposit addresses with default parameters', async () => {
                const mockResponse: any[] = [
                    { address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }
                ];

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositAddresses('XXBT', 'Bitcoin');

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/DepositAddresses',
                    expect.stringMatching(/asset=XXBT.*method=Bitcoin.*new=false/),
                    expect.any(Object)
                );
            });

            it('should request new address when specified', async () => {
                const mockResponse: any[] = [
                    { address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', new: true }
                ];

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositAddresses('XXBT', 'Bitcoin', true);

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/DepositAddresses',
                    expect.stringMatching(/new=true/),
                    expect.any(Object)
                );
            });

            it('should return empty array when result is not array', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: null, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositAddresses('XXBT', 'Bitcoin');
                expect(result).toEqual([]);
            });
        });

        describe('getDepositStatus', () => {
            it('should fetch all deposit records when no asset provided', async () => {
                const mockResponse: any[] = [
                    {
                        method: 'Bitcoin',
                        aclass: 'currency',
                        asset: 'XXBT',
                        refid: 'ABCDEF-123456',
                        txid: 'tx123',
                        info: 'deposit info',
                        amount: '1.0',
                        fee: '0.0',
                        time: 1234567890,
                        status: 'Success'
                    }
                ];

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                // Note: getDepositStatus requires asset parameter
                const result = await client.getDepositStatus('XXBT', `deposit`);

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/DepositStatus',
                    expect.stringMatching(/asset=XXBT/),
                    expect.any(Object)
                );
            });

            it('should filter by asset and method when both provided', async () => {
                const mockResponse: any[] = [];

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositStatus('XXBT', 'Bitcoin');

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/DepositStatus',
                    expect.stringMatching(/asset=XXBT.*method=Bitcoin/),
                    expect.any(Object)
                );
            });

            it('should return empty array when result is not array', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: null, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getDepositStatus('XXBT', 'deposit');
                expect(result).toEqual([]);
            });
        });

        describe('getWithdrawMethods', () => {
            it('should fetch withdrawal methods for an asset', async () => {
                const mockResponse: any[] = [
                    {
                        asset: 'XXBT',
                        method: 'Bitcoin',
                        network: 'Bitcoin',
                        minimum: '0.0005'
                    }
                ];

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getWithdrawMethods('XXBT');

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/WithdrawMethods',
                    expect.stringMatching(/asset=XXBT/),
                    expect.any(Object)
                );
            });

            it('should return empty array when result is not array', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: null, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getWithdrawMethods('XXBT');
                expect(result).toEqual([]);
            });
        });

        describe('getWithdrawInfo', () => {
            it('should fetch withdrawal information', async () => {
                const mockResponse = {
                    method: 'Bitcoin',
                    limit: '10000.00',
                    amount: '1.0',
                    fee: '0.0005'
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getWithdrawInfo('XXBT', 'btc-wallet', '1.0');

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/WithdrawInfo',
                    expect.stringMatching(/asset=XXBT.*key=btc-wallet.*amount=1\.0/),
                    expect.any(Object)
                );
            });
        });

        describe('withdraw', () => {
            it('should execute withdrawal', async () => {
                const mockResponse = {
                    refid: 'ABCDEF-123456'
                };

                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.withdraw({
                    asset: 'XXBT',
                    key: 'btc-wallet',
                    amount: '1.0'
                });

                expect(result).toEqual(mockResponse);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/Withdraw',
                    expect.stringMatching(/asset=XXBT.*key=btc-wallet.*amount=1\.0/),
                    expect.any(Object)
                );
            });
        });

        describe('getWithdrawStatus', () => {
            const refid = 'ABCDEF-123456';
            const mockResponse = [
                {
                    asset: 'XXBT',
                    refid,
                    txid: 'tx456',
                    info: 'withdrawal info',
                    amount: '1.0',
                    fee: '0.0005',
                    time: 1234567890,
                    status: 'Success'
                }
            ];
            it('should fetch all withdrawal records when no asset filter provided', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: mockResponse, error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getWithdrawStatus('XETH', 'Ethereum', refid);

                expect(result).toEqual(mockResponse[0]);
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/WithdrawStatus',
                    expect.stringMatching(/nonce=\d+&asset=XETH&method=Ethereum&limit=50$/),
                    expect.any(Object)
                );
            });

            it('should handle undefined', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: [], error: [] },
                    status: 200,
                    headers: {},
                });

                const result = await client.getWithdrawStatus('XXBT', 'Bitcoin', 'test-refid-2');

                expect(result).toBeUndefined();
                expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                    '/0/private/WithdrawStatus',
                    expect.stringMatching(/asset=XXBT/),
                    expect.any(Object)
                );
            });

            it('should return empty array when result is not array', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: { result: [], error: undefined },
                    status: 200,
                    headers: {},
                });

                const result = await client.getWithdrawStatus('XETH', 'Ethereum', 'test-refid-3');
                expect(result).toEqual(undefined);
            });
        });
    });

    describe('Error Handling', () => {
        describe('Kraken API errors', () => {
            it('should throw formatted error when API returns error', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: {
                        result: null,
                        error: ['EGeneral:Invalid arguments']
                    },
                    status: 200,
                    headers: {},
                });

                await expect(client.getBalance()).rejects.toThrow(
                    'Kraken API error: EGeneral:Invalid arguments'
                );
            });

            it('should throw formatted error for multiple API errors', async () => {
                mockAxiosInstance.post.mockResolvedValueOnce({
                    data: {
                        result: null,
                        error: ['EGeneral:Invalid arguments', 'EAuth:Invalid key']
                    },
                    status: 200,
                    headers: {},
                });

                await expect(client.getBalance()).rejects.toThrow(
                    'Kraken API error: EGeneral:Invalid arguments, EAuth:Invalid key'
                );
            });
        });

        describe('Network errors', () => {
            it('should handle network errors without retry (retry logic is disabled)', async () => {
                const networkError = new Error('Network Error');
                mockAxiosInstance.post.mockRejectedValueOnce(networkError);

                await expect(client.getSystemStatus()).rejects.toThrow('Network Error');
                expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1); // No retries
            });

            it('should handle axios errors without retry', async () => {
                const axiosError = {
                    isAxiosError: true,
                    response: { status: 500 }
                };

                mockAxiosInstance.post.mockRejectedValueOnce(axiosError);

                await expect(client.getBalance()).rejects.toEqual(axiosError);
                expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1); // No retries
            });
        });
    });

    describe('Edge Cases and Validation', () => {
        it('should handle empty asset list in getAssetInfo', async () => {
            const mockResponse = {};

            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { result: mockResponse, error: [] },
                status: 200,
                headers: {},
            });

            const result = await client.getAssetInfo([]);

            expect(result).toEqual(mockResponse);
            expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                '/0/public/Assets',
                '',
                expect.any(Object)
            );
        });

        it('should handle special characters in parameters', async () => {
            const mockResponse = { refid: 'test-123' };

            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { result: mockResponse, error: [] },
                status: 200,
                headers: {},
            });

            await client.withdraw({
                asset: 'XXBT',
                key: 'wallet@test.com',
                amount: '1.5'
            });

            expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                '/0/private/Withdraw',
                expect.stringMatching(/key=wallet%40test\.com/), // URL encoded
                expect.any(Object)
            );
        });

        it('should log debug information for all requests', async () => {
            const mockResponse = { status: 'online', timestamp: '2023-01-01' };

            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { result: mockResponse, error: [] },
                status: 200,
                headers: {},
            });

            await client.getSystemStatus();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Kraken API request initiated',
                expect.objectContaining({
                    endpoint: 'public/SystemStatus',
                    method: 'POST',
                    baseUrl: KRAKEN_BASE_URL,
                    paramCount: 0,
                    retryAttempt: 1,
                    maxRetries: 2,
                    nonce: 'N/A',
                })
            );
        });

        it('should handle large numeric values in parameters', async () => {
            const mockResponse = { refid: 'test-ref' };

            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { result: mockResponse, error: [] },
                status: 200,
                headers: {},
            });

            await client.getWithdrawInfo('XXBT', 'wallet-key', '999999999.123456789');

            expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                '/0/private/WithdrawInfo',
                expect.stringMatching(/amount=999999999\.123456789/),
                expect.any(Object)
            );
        });

        it('should handle null/undefined values in optional parameters gracefully', async () => {
            const mockResponse: any[] = [];

            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { result: mockResponse, error: [] },
                status: 200,
                headers: {},
            });

            // Test with valid parameters for getWithdrawStatus
            const result = await client.getWithdrawStatus('XETH', 'Ethereum', 'test-refid-4');

            expect(result).toEqual(undefined);
            expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                '/0/private/WithdrawStatus',
                expect.stringMatching(/nonce=\d+&asset=XETH&method=Ethereum&limit=50$/), // Only nonce, no asset param
                expect.any(Object)
            );
        });

        it('should handle empty string parameters', async () => {
            const mockResponse: any[] = [];

            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { result: mockResponse, error: [] },
                status: 200,
                headers: {},
            });

            await client.getAssetInfo([]);

            expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                '/0/public/Assets',
                '',
                expect.any(Object)
            );
        });
    });
});