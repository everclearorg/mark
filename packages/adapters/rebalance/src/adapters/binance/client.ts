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
  WithdrawQuotaResponse,
  TickerPrice,
  CoinConfig,
  AccountInfo,
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
    logger: Logger,
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
  private sign(params: Record<string, unknown>): string {
    const queryString = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b)) // Sort alphabetically, required by Binance
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  /**
   * Build query string with sorted parameters for consistent signatures
   */
  private buildQueryString(params: Record<string, unknown>): string {
    const sortedParams = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b));

    return sortedParams.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
  }

  /**
   * Make authenticated request to Binance API with rate limit handling
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, unknown> = {},
    signed = false,
    retryCount = 0,
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

      // Determine if we need to send parameters in URL
      // - All signed GET requests
      // - POST requests to withdrawal endpoint
      const sendParamsInUrl =
        (method === 'GET' && signed) || (method === 'POST' && endpoint.includes('/withdraw/apply') && signed);

      if (sendParamsInUrl) {
        // Build query string manually to preserve order
        const queryString = this.buildQueryString(requestParams);
        const finalUrl = `${endpoint}?${queryString}`;

        // Make request without params in body (already in URL)
        const response: AxiosResponse<T> = await this.axios.request({
          method,
          url: finalUrl,
          ...(method === 'POST' ? { data: {} } : {}), // Empty body for POST
        });

        // Log rate limit information
        this.logRateLimitInfo(response.headers as Record<string, string | string[] | undefined>, endpoint);

        this.logger.debug('Binance API request successful', {
          endpoint,
          status: response.status,
          retryCount,
        });

        return response.data;
      }

      // For other requests, use normal axios params
      const response: AxiosResponse<T> = await this.axios.request({
        method,
        url: endpoint,
        [method === 'GET' ? 'params' : 'data']: requestParams,
      });

      // Log rate limit information
      this.logRateLimitInfo(response.headers as Record<string, string | string[] | undefined>, endpoint);

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
          return this.handleRateLimitError(error, method, endpoint, params, signed, retryCount, maxRetries, retryAfter);
        }

        // Handle other server errors with exponential backoff
        if (status && status >= 500 && retryCount < maxRetries) {
          return this.handleServerError(error, method, endpoint, params, signed, retryCount);
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
    error: unknown,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, unknown>,
    signed: boolean,
    retryCount: number,
    maxRetries: number,
    retryAfter?: string,
  ): Promise<T> {
    if (!axios.isAxiosError(error)) {
      throw error;
    }
    const status = error.response?.status;
    const isIpBan = status === 418;

    if (retryCount >= maxRetries) {
      this.logger.error('Max retries exceeded for rate limit error', {
        endpoint,
        status,
        retryCount,
        isIpBan,
      });

      // Format the error message before throwing
      const errorMessage = error.response?.data?.msg || error.message;
      const errorCode = error.response?.data?.code;
      throw new Error(`Binance API error ${status} ${errorCode ? `(${errorCode})` : ''}: ${errorMessage}`);
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
    error: unknown,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, unknown>,
    signed: boolean,
    retryCount: number,
  ): Promise<T> {
    const delayMs = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 seconds

    const errorStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
    this.logger.warn('Server error, retrying with backoff', {
      endpoint,
      status: errorStatus,
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
  private logRateLimitInfo(headers: Record<string, string | string[] | undefined>, endpoint: string): void {
    // SAPI endpoints use X-SAPI-USED-*-WEIGHT-1M headers
    const ipWeight = headers['x-sapi-used-ip-weight-1m'];
    const uidWeight = headers['x-sapi-used-uid-weight-1m'];

    if (ipWeight && typeof ipWeight === 'string') {
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

    if (uidWeight && typeof uidWeight === 'string') {
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
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      true,
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
      params as unknown as Record<string, unknown>,
      true,
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
    limit = 1000,
  ): Promise<DepositRecord[]> {
    const params: Record<string, unknown> = {
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

    const result = await this.request<DepositRecord[]>('GET', BINANCE_ENDPOINTS.DEPOSIT_HISTORY, params, true);

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
    limit = 1000,
  ): Promise<WithdrawRecord[]> {
    const params: Record<string, unknown> = {
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

    const result = await this.request<WithdrawRecord[]>('GET', BINANCE_ENDPOINTS.WITHDRAW_HISTORY, params, true);

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
      false, // System status doesn't require authentication
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
  async getAssetConfig(): Promise<CoinConfig[]> {
    this.logger.debug('Getting asset configuration');

    const result = await this.request<CoinConfig[]>('GET', BINANCE_ENDPOINTS.ASSET_CONFIG, {}, true);

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

  /**
   * Get withdrawal quota for the account
   * Returns quota values in USD (global across all coins)
   */
  async getWithdrawQuota(): Promise<WithdrawQuotaResponse> {
    this.logger.debug('Getting withdrawal quota');

    const result = await this.request<WithdrawQuotaResponse>('GET', BINANCE_ENDPOINTS.WITHDRAW_QUOTA, {}, true);

    const totalQuota = parseFloat(result.wdQuota);
    const usedQuota = parseFloat(result.usedWdQuota);
    const remainingQuota = totalQuota - usedQuota;

    this.logger.debug('Withdrawal quota retrieved', {
      totalQuotaUSD: totalQuota,
      usedQuotaUSD: usedQuota,
      remainingQuotaUSD: remainingQuota,
    });

    return result;
  }

  /**
   * Get current price for a symbol pair (e.g., "ETHUSDT")
   * Public endpoint - no authentication required
   */
  async getPrice(symbol: string): Promise<TickerPrice> {
    this.logger.debug('Getting ticker price', { symbol });

    const result = await this.request<TickerPrice>(
      'GET',
      BINANCE_ENDPOINTS.TICKER_PRICE,
      { symbol },
      false, // Not a signed request
    );

    this.logger.debug('Ticker price retrieved', {
      symbol: result.symbol,
      price: result.price,
    });

    return result;
  }

  /**
   * Get account balance for all assets
   * Private endpoint - requires authentication
   */
  async getAccountBalance(): Promise<Record<string, string>> {
    this.logger.debug('Getting account balance');

    const result = await this.request<AccountInfo>('GET', BINANCE_ENDPOINTS.ACCOUNT_BALANCE, {}, true);

    // Validate response structure
    if (!result || !Array.isArray(result.balances)) {
      const resultAsRecord = result as unknown as Record<string, unknown>;
      this.logger.error('Invalid response structure from account balance endpoint', {
        result,
        hasResult: !!result,
        hasBalances: !!resultAsRecord?.balances,
        balancesType: typeof resultAsRecord?.balances,
      });
      throw new Error(
        'Invalid response structure from Binance account balance endpoint: balances field is missing or not an array',
      );
    }

    this.logger.debug('Account balance retrieved', {
      balances: result.balances,
    });

    const balances: Record<string, string> = {};
    for (const balance of result.balances) {
      const totalBalance = (parseFloat(balance.free) + parseFloat(balance.locked)).toString();
      if (parseFloat(totalBalance) > 0) {
        balances[balance.asset] = totalBalance;
      }
    }

    return balances;
  }
}
