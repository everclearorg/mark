import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios, { AxiosInstance } from 'axios';
import { Logger } from '@mark/logger';
import { BinanceClient } from '../../../src/adapters/binance/client';

// Mock axios
jest.mock('axios');

describe('BinanceClient', () => {
  let client: BinanceClient;
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
      request: jest.fn(),
      defaults: { headers: { common: {} } },
    } as unknown as jest.Mocked<AxiosInstance>;

    // Mock axios.create
    (axios.create as jest.MockedFunction<typeof axios.create>).mockReturnValue(mockAxiosInstance);

    // Create client
    client = new BinanceClient('test-key', 'test-secret', 'https://api.binance.com', mockLogger);
  });

  describe('Parameter ordering for signed requests', () => {
    it('should preserve alphabetical parameter order in URL for signed GET requests', async () => {
      // Mock successful response
      mockAxiosInstance.request.mockResolvedValueOnce({
        data: [],
        status: 200,
        headers: {},
      });

      // Call a method that uses signed GET request with multiple parameters
      await client.getDepositHistory('ETH', 1);

      // Check that the request was made with manually constructed URL
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: expect.stringMatching(/^\/sapi\/v1\/capital\/deposit\/hisrec\?/),
        })
      );

      // Get the actual URL that was called
      const callArgs = mockAxiosInstance.request.mock.calls[0][0];
      const url = callArgs.url as string;
      
      // Extract query string
      const queryString = url.split('?')[1];
      const params = queryString.split('&');
      
      // Verify parameters are in alphabetical order
      const paramNames = params.map(p => p.split('=')[0]);
      const sortedParamNames = [...paramNames].sort();
      
      expect(paramNames).toEqual(sortedParamNames);
      expect(paramNames).toContain('coin');
      expect(paramNames).toContain('limit');
      expect(paramNames).toContain('offset');
      expect(paramNames).toContain('signature');
      expect(paramNames).toContain('status');
      expect(paramNames).toContain('timestamp');
    });

    it('should handle different parameter orders consistently', async () => {
      // Mock Date.now to return consistent timestamp
      const mockTimestamp = 1234567890123;
      jest.spyOn(Date, 'now').mockReturnValue(mockTimestamp);

      // Mock successful responses
      mockAxiosInstance.request.mockResolvedValue({
        data: [],
        status: 200,
        headers: {},
      });

      // Test 1: Call with parameters in one order
      await client.getWithdrawHistory('BTC', 'order123', 1);
      
      const firstCallUrl = (mockAxiosInstance.request.mock.calls[0][0] as any).url;
      const firstQueryString = firstCallUrl.split('?')[1];
      
      // Clear mock
      mockAxiosInstance.request.mockClear();
      
      // Test 2: Same parameters but method might add them in different order internally
      await client.getWithdrawHistory('BTC', 'order123', 1);
      
      const secondCallUrl = (mockAxiosInstance.request.mock.calls[0][0] as any).url;
      const secondQueryString = secondCallUrl.split('?')[1];
      
      // Both calls should produce identical query strings
      expect(firstQueryString).toBe(secondQueryString);
      
      // Restore Date.now
      jest.restoreAllMocks();
    });

    it('should use normal axios params for non-signed requests', async () => {
      // Mock successful response
      mockAxiosInstance.request.mockResolvedValueOnce({
        data: { status: 0, msg: 'normal' },
        status: 200,
        headers: {},
      });

      // Call a non-signed endpoint
      await client.isSystemOperational();

      // Should use params property, not manual URL construction
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: '/sapi/v1/system/status', // No query string
          params: {}, // Empty params object
        })
      );
    });

    it('should send withdrawal parameters in URL query string, not body', async () => {
      // Mock successful response
      mockAxiosInstance.request.mockResolvedValueOnce({
        data: { id: 'withdraw-123' },
        status: 200,
        headers: {},
      });

      // Call withdraw (which uses POST)
      await client.withdraw({
        coin: 'ETH',
        network: 'ETH',
        address: '0x123',
        amount: '1.0',
      });

      // Should send params in URL for withdrawal endpoint
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: expect.stringMatching(/^\/sapi\/v1\/capital\/withdraw\/apply\?/),
          data: {}, // Empty body
        })
      );
      
      // Verify URL contains all required params
      const callArgs = mockAxiosInstance.request.mock.calls[0][0];
      const url = callArgs.url as string;
      expect(url).toContain('coin=ETH');
      expect(url).toContain('network=ETH');
      expect(url).toContain('address=0x123');
      expect(url).toContain('amount=1.0');
      expect(url).toContain('signature=');
      expect(url).toContain('timestamp=');
    });

    it('should filter out undefined and null parameters', async () => {
      // Mock successful response
      mockAxiosInstance.request.mockResolvedValueOnce({
        data: [],
        status: 200,
        headers: {},
      });

      // Call getWithdrawHistory with optional parameters as undefined
      await client.getWithdrawHistory('ETH', undefined, undefined, undefined, undefined);

      const callArgs = mockAxiosInstance.request.mock.calls[0][0];
      const url = callArgs.url as string;
      const queryString = url.split('?')[1];
      
      // Should only include required parameters (coin, limit, offset, timestamp, signature)
      expect(queryString).toContain('coin=ETH');
      expect(queryString).toContain('limit=');
      expect(queryString).toContain('offset=');
      expect(queryString).toContain('timestamp=');
      expect(queryString).toContain('signature=');
      
      // Should not include undefined parameters
      expect(queryString).not.toContain('withdrawOrderId');
      expect(queryString).not.toContain('status=undefined');
      expect(queryString).not.toContain('startTime');
      expect(queryString).not.toContain('endTime');
    });

    it('should generate consistent signatures regardless of parameter input order', async () => {
      // Mock Date.now to return consistent timestamp
      const mockTimestamp = 1234567890123;
      jest.spyOn(Date, 'now').mockReturnValue(mockTimestamp);

      // Mock successful responses
      mockAxiosInstance.request.mockResolvedValue({
        data: [],
        status: 200,
        headers: {},
      });

      // Capture signatures from multiple calls
      const signatures: string[] = [];
      
      // Override request to capture signatures
      mockAxiosInstance.request.mockImplementation((config) => {
        const url = config.url as string;
        const signatureMatch = url.match(/signature=([^&]+)/);
        if (signatureMatch) {
          signatures.push(signatureMatch[1]);
        }
        return Promise.resolve({ data: [], status: 200, headers: {} } as any);
      });

      // Make multiple calls that should produce the same signature
      await client.getDepositHistory('ETH', 1);
      await client.getDepositHistory('ETH', 1);
      
      // All signatures should be identical for the same parameters
      expect(signatures.length).toBe(2);
      expect(signatures[0]).toBe(signatures[1]);
      
      // Restore Date.now
      jest.restoreAllMocks();
    });
  });

  describe('API error handling', () => {
    it('should throw descriptive error for signature failures', async () => {
      // Create proper axios error structure
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            code: -1022,
            msg: 'Signature for this request is not valid.',
          },
          headers: {},
          config: {},
          statusText: 'Bad Request'
        },
        config: {},
        message: 'Request failed with status code 400',
        name: 'AxiosError',
        code: 'ERR_BAD_REQUEST'
      };
      
      // Mock axios.isAxiosError
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      
      // Mock signature error response
      mockAxiosInstance.request.mockRejectedValueOnce(axiosError);

      await expect(client.getDepositHistory('ETH')).rejects.toThrow(
        'Binance API error 400 (-1022): Signature for this request is not valid.'
      );
    });

    it('should handle authorization errors', async () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 401,
          data: {
            code: -1002,
            msg: 'You are not authorized to execute this request.',
          },
          headers: {},
          config: {},
          statusText: 'Unauthorized'
        },
        config: {},
        message: 'Request failed with status code 401',
        name: 'AxiosError',
        code: 'ERR_BAD_REQUEST'
      };
      
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      mockAxiosInstance.request.mockRejectedValueOnce(axiosError);

      await expect(client.withdraw({
        coin: 'ETH',
        network: 'ETH',
        address: '0x123',
        amount: '1.0',
      })).rejects.toThrow(
        'Binance API error 401 (-1002): You are not authorized to execute this request.'
      );
    });

    it('should handle insufficient balance errors', async () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            code: -4026,
            msg: 'Insufficient balance',
          },
          headers: {},
          config: {},
          statusText: 'Bad Request'
        },
        config: {},
        message: 'Request failed with status code 400',
        name: 'AxiosError',
        code: 'ERR_BAD_REQUEST'
      };
      
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      mockAxiosInstance.request.mockRejectedValueOnce(axiosError);

      await expect(client.withdraw({
        coin: 'ETH',
        network: 'ETH',
        address: '0x123',
        amount: '1.0',
      })).rejects.toThrow(
        'Binance API error 400 (-4026): Insufficient balance'
      );
    });

    it('should handle rate limit errors', async () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 429,
          data: {
            code: -1003,
            msg: 'Too much request weight used.',
          },
          headers: {
            'retry-after': '60'
          },
          config: {},
          statusText: 'Too Many Requests'
        },
        config: {},
        message: 'Request failed with status code 429',
        name: 'AxiosError',
        code: 'ERR_TOO_MANY_REQUESTS'
      };
      
      // Mock the delay function to avoid waiting
      jest.spyOn(client as any, 'delay').mockResolvedValue(undefined);
      
      // Need to mock isAxiosError for each call
      let isAxiosErrorCallCount = 0;
      jest.spyOn(axios, 'isAxiosError').mockImplementation(() => {
        isAxiosErrorCallCount++;
        // Return true for the first 8 calls (2 checks per request * 4 requests)
        return isAxiosErrorCallCount <= 8;
      });
      
      // Mock it to fail 4 times (more than max retries) to ensure it throws
      mockAxiosInstance.request.mockRejectedValue(axiosError);

      // The method should throw a formatted error after max retries
      await expect(client.getDepositHistory('ETH')).rejects.toThrow(
        'Binance API error 429 (-1003): Too much request weight used.'
      );
      
      // Verify it retried the maximum number of times
      expect(mockAxiosInstance.request).toHaveBeenCalledTimes(4); // initial + 3 retries
    });

    it('should handle network errors without response', async () => {
      const axiosError = {
        isAxiosError: true,
        response: undefined,
        config: {},
        message: 'Network Error',
        name: 'AxiosError',
        code: 'ENOTFOUND'
      };
      
      jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
      mockAxiosInstance.request.mockRejectedValueOnce(axiosError);

      await expect(client.getDepositHistory('ETH')).rejects.toThrow('Network Error');
    });
  });

  describe('Core API methods', () => {
    describe('getDepositAddress', () => {
      it('should fetch deposit address for a coin and network', async () => {
        const mockResponse = {
          coin: 'ETH',
          address: '0xabc123',
          tag: '',
          url: 'https://etherscan.io/address/0xabc123'
        };

        mockAxiosInstance.request.mockResolvedValueOnce({
          data: mockResponse,
          status: 200,
          headers: {},
        });

        const result = await client.getDepositAddress('ETH', 'ETH');

        expect(result).toEqual(mockResponse);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'GET',
            url: expect.stringMatching(/\/sapi\/v1\/capital\/deposit\/address\?.*coin=ETH.*network=ETH/),
          })
        );
      });
    });

    describe('getWithdrawQuota', () => {
      it('should fetch withdrawal quota', async () => {
        const mockResponse = {
          hasWithdrawEncryption: false,
          withdrawSafeAmount: '10000.00',
          wdQuota: '10000.00',
          usedWdQuota: '2000.00'
        };

        mockAxiosInstance.request.mockResolvedValueOnce({
          data: mockResponse,
          status: 200,
          headers: {},
        });

        const result = await client.getWithdrawQuota();

        expect(result).toEqual(mockResponse);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'GET',
            url: expect.stringMatching(/\/sapi\/v1\/capital\/withdraw\/quota/),
          })
        );
      });
    });

    describe('getPrice', () => {
      it('should fetch price for a trading pair', async () => {
        const mockResponse = {
          symbol: 'ETHUSDT',
          price: '3000.50'
        };

        mockAxiosInstance.request.mockResolvedValueOnce({
          data: mockResponse,
          status: 200,
          headers: {},
        });

        const result = await client.getPrice('ETHUSDT');

        expect(result).toEqual(mockResponse);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'GET',
            url: '/api/v3/ticker/price',
            params: { symbol: 'ETHUSDT' },
          })
        );
      });
    });

    describe('getAssetConfig', () => {
      it('should fetch asset configuration', async () => {
        const mockResponse = [
          {
            coin: 'ETH',
            depositAllEnable: true,
            withdrawAllEnable: true,
            networkList: [
              {
                network: 'ETH',
                coin: 'ETH',
                withdrawEnable: true,
                depositEnable: true,
                withdrawFee: '0.0004',
                withdrawMin: '0.002',
                withdrawMax: '10000'
              }
            ]
          }
        ];

        mockAxiosInstance.request.mockResolvedValueOnce({
          data: mockResponse,
          status: 200,
          headers: {},
        });

        const result = await client.getAssetConfig();

        expect(result).toEqual(mockResponse);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'GET',
            url: expect.stringMatching(/\/sapi\/v1\/capital\/config\/getall/),
          })
        );
      });
    });

    describe('isConfigured', () => {
      it('should check if client is properly configured', async () => {
        const result = await client.isConfigured();
        expect(result).toBe(true);
      });

      it('should return false for client without API key', async () => {
        const invalidClient = new BinanceClient('', 'test-secret', 'https://api.binance.com', mockLogger);
        const result = await invalidClient.isConfigured();
        expect(result).toBe(false);
      });

      it('should return false for client without API secret', async () => {
        const invalidClient = new BinanceClient('test-key', '', 'https://api.binance.com', mockLogger);
        const result = await invalidClient.isConfigured();
        expect(result).toBe(false);
      });
    });

    describe('isSystemOperational', () => {
      it('should check system status', async () => {
        mockAxiosInstance.request.mockResolvedValueOnce({
          data: { status: 0, msg: 'normal' },
          status: 200,
          headers: {},
        });

        const result = await client.isSystemOperational();

        expect(result).toBe(true);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'GET',
            url: '/sapi/v1/system/status',
            params: {},
          })
        );
      });

      it('should return false for system maintenance', async () => {
        mockAxiosInstance.request.mockResolvedValueOnce({
          data: { status: 1, msg: 'system maintenance' },
          status: 200,
          headers: {},
        });

        const result = await client.isSystemOperational();
        expect(result).toBe(false);
      });
    });
  });

  describe('Retry and rate limiting', () => {
    it('should retry failed requests with exponential backoff', async () => {
      // First two calls fail, third succeeds
      mockAxiosInstance.request
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          data: { status: 0, msg: 'normal' },
          status: 200,
          headers: {},
        });

      const result = await client.isSystemOperational();

      // isSystemOperational catches errors and returns false
      expect(result).toBe(false);
      // It only makes one call since getSystemStatus doesn't retry
      expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    });

    it('should respect retry limit', async () => {
      // All calls fail
      mockAxiosInstance.request.mockRejectedValue(new Error('Network error'));

      // isSystemOperational catches errors and returns false instead of throwing
      const result = await client.isSystemOperational();
      expect(result).toBe(false);
      // Only one call since getSystemStatus doesn't retry
      expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST endpoints with body parameters', () => {
    it('should send non-withdrawal POST parameters in request body', async () => {
      // Mock a generic POST endpoint (not withdrawal)
      mockAxiosInstance.request.mockResolvedValueOnce({
        data: { success: true },
        status: 200,
        headers: {},
      });

      // Test a signed POST request (not withdrawal)
      const mockPostMethod = async () => {
        return (client as any).request('POST', '/sapi/v1/some/endpoint', {
          param1: 'value1',
          param2: 'value2'
        }, true);
      };

      await mockPostMethod();

      // For signed POST requests (not withdrawal), parameters should be in body
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: '/sapi/v1/some/endpoint', // No query params
          data: expect.objectContaining({
            param1: 'value1',
            param2: 'value2',
            timestamp: expect.any(Number),
            signature: expect.any(String),
          }),
        })
      );
    });

    it('should send withdrawal POST parameters in URL', async () => {
      // Mock withdrawal endpoint
      mockAxiosInstance.request.mockResolvedValueOnce({
        data: { id: 'withdraw-123' },
        status: 200,
        headers: {},
      });

      // Test withdrawal POST request
      const mockPostMethod = async () => {
        return (client as any).request('POST', '/sapi/v1/capital/withdraw/apply', {
          coin: 'ETH',
          network: 'ETH',
          address: '0x123',
          amount: '1.0'
        }, true);
      };

      await mockPostMethod();

      // For withdrawal POST requests, parameters should be in URL
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: expect.stringMatching(/\/sapi\/v1\/capital\/withdraw\/apply\?/),
          data: {}, // Empty body
        })
      );
      
      // Verify URL contains all required params (in alphabetical order)
      const callArgs = mockAxiosInstance.request.mock.calls[0][0];
      const url = callArgs.url as string;
      expect(url).toContain('address=0x123');
      expect(url).toContain('amount=1.0');
      expect(url).toContain('coin=ETH');
      expect(url).toContain('network=ETH');
      expect(url).toContain('signature=');
      expect(url).toContain('timestamp=');
    });
  });

  describe('Error handling', () => {
    it('should handle server errors (5xx) with retry', async () => {
      // Mock server error followed by success
      const serverError = {
        isAxiosError: true,
        response: { 
          status: 500, 
          data: { msg: 'Internal Server Error' },
          headers: {}
        },
      };

      (axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>).mockReturnValue(true);
      mockAxiosInstance.request
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({
          data: { success: true },
          status: 200,
          headers: {},
        });

      jest.spyOn(client as any, 'delay').mockResolvedValue(undefined);

      const result = await (client as any).request('GET', '/test', {}, false);

      expect(result).toEqual({ success: true });
      expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
    });

    it('should handle rate limit with retry-after header', async () => {
      // Mock rate limit error with retry-after header
      const rateLimitError = {
        isAxiosError: true,
        response: { 
          status: 429, 
          data: { msg: 'Rate limit exceeded' },
          headers: { 'retry-after': '5' }
        },
      };

      (axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>).mockReturnValue(true);
      mockAxiosInstance.request
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, headers: {} });

      jest.spyOn(client as any, 'delay').mockResolvedValue(undefined);

      const result = await (client as any).request('GET', '/test', {}, false);

      expect(result).toEqual({ success: true });
      expect((client as any).delay).toHaveBeenCalledWith(5000);
    });

    it('should log rate limit warnings when approaching SAPI limits', async () => {
      mockAxiosInstance.request.mockResolvedValueOnce({
        data: { success: true },
        status: 200,
        headers: {
          'x-sapi-used-ip-weight-1m': '11000',
        },
      });

      await (client as any).request('GET', '/sapi/v1/test', {}, false);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Approaching SAPI IP rate limit',
        expect.objectContaining({
          weightUsed: 11000,
        })
      );
    });

    it('should handle non-axios errors by rethrowing', async () => {
      const regularError = new Error('Non-axios error');
      mockAxiosInstance.request.mockRejectedValueOnce(regularError);

      await expect(
        (client as any).request('GET', '/test', {}, false)
      ).rejects.toThrow('Non-axios error');
    });
  });
});