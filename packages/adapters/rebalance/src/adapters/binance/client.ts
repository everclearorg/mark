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
import { BINANCE_ENDPOINTS } from './constants';

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
   * Make authenticated request to Binance API
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, any> = {},
    signed = false
  ): Promise<T> {
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
      });

      const response: AxiosResponse<T> = await this.axios.request({
        method,
        url: endpoint,
        [method === 'GET' ? 'params' : 'data']: requestParams,
      });

      this.logger.debug('Binance API request successful', {
        endpoint,
        status: response.status,
      });

      return response.data;
    } catch (error) {
      this.logger.error('Binance API request failed', {
        error: jsonifyError(error),
        endpoint,
        method,
        signed,
      });

      // Enhance error with more context
      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.msg || error.message;
        const errorCode = error.response?.data?.code;
        throw new Error(`Binance API error ${errorCode ? `(${errorCode})` : ''}: ${errorMessage}`);
      }

      throw error;
    }
  }

  /**
   * Get deposit address for a specific coin and network
   */
  async getDepositAddress(coin: string, network: string): Promise<DepositAddress> {
    this.logger.debug('Getting deposit address', { coin, network });

    const result = await this.request<DepositAddress>(
      'POST',
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
   * Check if the client is properly configured
   */
  isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }
} 