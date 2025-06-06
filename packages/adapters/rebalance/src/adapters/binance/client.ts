import axios, { AxiosInstance, AxiosResponse } from 'axios';
import crypto from 'crypto';
import { Logger } from '@mark/logger';
import { jsonifyError } from '@mark/logger';
import {
  DepositAddress,
  DepositRecord,
  WithdrawParams,
  WithdrawResponse,
  WithdrawRecord,
  BINANCE_BASE_URL,
} from './types';
import { BINANCE_ENDPOINTS, BINANCE_RATE_LIMITS } from './constants';

export class BinanceClient {
  private readonly axios: AxiosInstance;
  private readonly logger: Logger;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly baseUrl: string = BINANCE_BASE_URL,
    logger: Logger
  ) {
    this.logger = logger;
    this.axios = axios.create({
      baseURL: baseUrl,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 second timeout
    });

    this.logger.debug('BinanceClient initialized', {
      baseUrl,
      hasApiKey: !!apiKey,
      hasApiSecret: !!apiSecret,
    });
  }

  /**
   * Generate HMAC SHA256 signature for Binance API authentication
   */
  private sign(params: Record<string, any>): string {
    const queryString = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');

    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Make authenticated request to Binance API with rate limit handling
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, any> = {},
    signed = false,
    retryCount = 0
  ): Promise<T> {
    const maxRetries = 3;
    
    try {
      const timestamp = Date.now();
      let requestParams = { ...params };

      if (signed) {
        requestParams = {
          ...params,
          timestamp,
          signature: this.sign({ ...params, timestamp }),
        };
      }

      this.logger.debug('Making Binance API request', {
        method,
        endpoint,
        signed,
        paramCount: Object.keys(requestParams).length,
        retryCount,
      });

      const response: AxiosResponse<T> = await this.axios.request({
        method,
        url: endpoint,
        [method === 'GET' ? 'params' : 'data']: requestParams,
      });

      // Log rate limit information
      this.logRateLimitInfo(response.headers, endpoint);

      this.logger.debug('Binance API request successful', {
        endpoint,
        status: response.status,
        retryCount,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const retryAfter = error.response?.headers['retry-after'];
        
        // Handle rate limit errors (429) and IP bans (418)
        if (status === 429 || status === 418) {
          return this.handleRateLimitError(
            error,
            method,
            endpoint,
            params,
            signed,
            retryCount,
            maxRetries,
            retryAfter
          );
        }
        
        // Handle other server errors with exponential backoff
        if (status && status >= 500 && retryCount < maxRetries) {
          return this.handleServerError(
            error,
            method,
            endpoint,
            params,
            signed,
            retryCount
          );
        }
      }

      this.logger.error('Binance API request failed', {
        error: jsonifyError(error),
        endpoint,
        method,
        signed,
        retryCount,
      });

      // Enhance error with more context
      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.msg || error.message;
        const errorCode = error.response?.data?.code;
        const status = error.response?.status;
        throw new Error(`Binance API error ${status} ${errorCode ? `(${errorCode})` : ''}: ${errorMessage}`);
      }

      throw error;
    }
  }

  /**
   * Handle rate limit errors (429) and IP bans (418) with proper backoff
   */
  private async handleRateLimitError<T>(
    error: any,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, any>,
    signed: boolean,
    retryCount: number,
    maxRetries: number,
    retryAfter?: string
  ): Promise<T> {
    const status = error.response?.status;
    const isIpBan = status === 418;
    
    if (retryCount >= maxRetries) {
      this.logger.error('Max retries exceeded for rate limit error', {
        endpoint,
        status,
        retryCount,
        isIpBan,
      });
      throw error;
    }

    // Calculate delay: use Retry-After header if available, otherwise exponential backoff
    let delayMs: number;
    if (retryAfter) {
      delayMs = parseInt(retryAfter) * 1000; // Convert seconds to milliseconds
    } else {
      delayMs = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30 seconds
    }

    this.logger.warn('Rate limit hit, backing off', {
      endpoint,
      status,
      retryCount: retryCount + 1,
      delayMs,
      isIpBan,
      retryAfter,
    });

    // Wait before retrying
    await this.delay(delayMs);
    
    return this.request<T>(method, endpoint, params, signed, retryCount + 1);
  }

  /**
   * Handle server errors (5xx) with exponential backoff
   */
  private async handleServerError<T>(
    error: any,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, any>,
    signed: boolean,
    retryCount: number
  ): Promise<T> {
    const delayMs = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 seconds
    
    this.logger.warn('Server error, retrying with backoff', {
      endpoint,
      status: error.response?.status,
      retryCount: retryCount + 1,
      delayMs,
    });

    await this.delay(delayMs);
    return this.request<T>(method, endpoint, params, signed, retryCount + 1);
  }

  /**
   * Log rate limit information from response headers
   * We only use /sapi endpoints, so only check SAPI headers
   */
  private logRateLimitInfo(headers: any, endpoint: string): void {
    // SAPI endpoints use X-SAPI-USED-*-WEIGHT-1M headers
    const ipWeight = headers['x-sapi-used-ip-weight-1m'];
    const uidWeight = headers['x-sapi-used-uid-weight-1m'];
    
    if (ipWeight) {
      this.logger.debug('SAPI IP rate limit status', {
        endpoint,
        weightUsed: ipWeight,
        limit: `${BINANCE_RATE_LIMITS.SAPI_IP_WEIGHT_PER_MINUTE}/min`,
      });
      
      const currentWeight = parseInt(ipWeight);
      if (currentWeight > BINANCE_RATE_LIMITS.SAPI_IP_WARNING_THRESHOLD) {
        this.logger.warn('Approaching SAPI IP rate limit', {
          endpoint,
          weightUsed: currentWeight,
          limit: `${BINANCE_RATE_LIMITS.SAPI_IP_WEIGHT_PER_MINUTE}/min`,
          threshold: BINANCE_RATE_LIMITS.SAPI_IP_WARNING_THRESHOLD,
        });
      }
    }
    
    if (uidWeight) {
      this.logger.debug('SAPI UID rate limit status', {
        endpoint,
        weightUsed: uidWeight,
        limit: `${BINANCE_RATE_LIMITS.SAPI_UID_WEIGHT_PER_MINUTE}/min`,
      });
      
      const currentWeight = parseInt(uidWeight);
      if (currentWeight > BINANCE_RATE_LIMITS.SAPI_UID_WARNING_THRESHOLD) {
        this.logger.warn('Approaching SAPI UID rate limit', {
          endpoint,
          weightUsed: currentWeight,
          limit: `${BINANCE_RATE_LIMITS.SAPI_UID_WEIGHT_PER_MINUTE}/min`,
          threshold: BINANCE_RATE_LIMITS.SAPI_UID_WARNING_THRESHOLD,
        });
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get deposit address for a specific coin and network
   */
  async getDepositAddress(coin: string, network: string): Promise<DepositAddress> {
    this.logger.debug('Getting deposit address', { coin, network });

    const result = await this.request<DepositAddress>(
      'GET',
      BINANCE_ENDPOINTS.DEPOSIT_ADDRESS,
      { coin, network },
      true
    );

    this.logger.debug('Deposit address retrieved', {
      coin,
      network,
      address: result.address,
    });

    return result;
  }

  /**
   * Submit withdrawal request
   */
  async withdraw(params: WithdrawParams): Promise<WithdrawResponse> {
    this.logger.debug('Submitting withdrawal', {
      coin: params.coin,
      network: params.network,
      address: params.address,
      amount: params.amount,
    });

    const result = await this.request<WithdrawResponse>(
      'POST',
      BINANCE_ENDPOINTS.WITHDRAW_APPLY,
      params,
      true
    );

    this.logger.debug('Withdrawal submitted', {
      withdrawalId: result.id,
      coin: params.coin,
    });

    return result;
  }

  /**
   * Get deposit history
   */
  async getDepositHistory(
    coin?: string,
    status?: number,
    startTime?: number,
    endTime?: number,
    offset = 0,
    limit = 1000
  ): Promise<DepositRecord[]> {
    const params: Record<string, any> = {
      offset,
      limit,
    };

    if (coin) params.coin = coin;
    if (status !== undefined) params.status = status;
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    this.logger.debug('Getting deposit history', {
      coin,
      status,
      startTime,
      endTime,
      offset,
      limit,
    });

    const result = await this.request<DepositRecord[]>(
      'GET',
      BINANCE_ENDPOINTS.DEPOSIT_HISTORY,
      params,
      true
    );

    this.logger.debug('Deposit history retrieved', {
      coin,
      count: result.length,
    });

    return result;
  }

  /**
   * Get withdrawal history
   */
  async getWithdrawHistory(
    coin?: string,
    withdrawOrderId?: string,
    status?: number,
    startTime?: number,
    endTime?: number,
    offset = 0,
    limit = 1000
  ): Promise<WithdrawRecord[]> {
    const params: Record<string, any> = {
      offset,
      limit,
    };

    if (coin) params.coin = coin;
    if (withdrawOrderId) params.withdrawOrderId = withdrawOrderId;
    if (status !== undefined) params.status = status;
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    this.logger.debug('Getting withdrawal history', {
      coin,
      withdrawOrderId,
      status,
      startTime,
      endTime,
      offset,
      limit,
    });

    const result = await this.request<WithdrawRecord[]>(
      'GET',
      BINANCE_ENDPOINTS.WITHDRAW_HISTORY,
      params,
      true
    );

    this.logger.debug('Withdrawal history retrieved', {
      coin,
      count: result.length,
    });

    return result;
  }

  /**
   * Get system status
   */
  async getSystemStatus(): Promise<{ status: number; msg: string }> {
    this.logger.debug('Getting system status');

    const result = await this.request<{ status: number; msg: string }>(
      'GET',
      BINANCE_ENDPOINTS.SYSTEM_STATUS,
      {},
      false // System status doesn't require authentication
    );

    this.logger.debug('System status retrieved', {
      status: result.status,
      msg: result.msg,
    });

    return result;
  }

  /**
   * Get asset configuration
   */
  async getAssetConfig(): Promise<any[]> {
    this.logger.debug('Getting asset configuration');

    const result = await this.request<any[]>(
      'GET',
      BINANCE_ENDPOINTS.ASSET_CONFIG,
      {},
      true
    );

    this.logger.debug('Asset configuration retrieved', {
      assetCount: result.length,
    });

    return result;
  }

  /**
   * Check if Binance system is operational (status === 0)
   */
  async isSystemOperational(): Promise<boolean> {
    try {
      const status = await this.getSystemStatus();
      return status.status === 0;
    } catch (error) {
      this.logger.warn('Failed to check system status, assuming non-operational', {
        error: jsonifyError(error),
      });
      return false;
    }
  }

  /**
   * Check if the client is properly configured
   */
  isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }
} 