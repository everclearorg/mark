import axios, { AxiosInstance, AxiosResponse } from 'axios';
import crypto from 'crypto';
import { Logger, jsonifyError } from '@mark/logger';
import {
  KrakenDepositMethod,
  KrakenDepositAddress,
  KrakenDepositRecord,
  KrakenWithdrawMethod,
  KrakenWithdrawInfo,
  KrakenWithdrawResponse,
  KrakenWithdrawRecord,
  KrakenSystemStatus,
  KrakenAssetInfo,
  KrakenBalance,
  KRAKEN_BASE_URL,
} from './types';

export class KrakenClient {
  private readonly axios: AxiosInstance;
  private nonce: number;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly logger: Logger,
    private readonly baseUrl: string = KRAKEN_BASE_URL,
    private readonly numRetries = 3,
  ) {
    this.nonce = Date.now();
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
    });

    this.logger.debug('KrakenClient initialized', {
      baseUrl: this.baseUrl,
      hasApiKey: !!apiKey,
      hasApiSecret: !!apiSecret,
      timeout: 30000,
      retryCount: this.numRetries,
    });
  }

  isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  private generateNonce(): string {
    this.nonce = Math.max(this.nonce + 1, Date.now());
    return this.nonce.toString();
  }

  private sign(path: string, postData: string): string {
    const message = path + crypto.createHash('sha256').update(postData).digest('binary');
    const secret = Buffer.from(this.apiSecret, 'base64');
    return crypto.createHmac('sha512', secret).update(message, 'binary').digest('base64');
  }

  private async request<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
    isPrivate = false,
    retryCount = 0,
  ): Promise<T> {
    try {
      const nonce = this.generateNonce();
      let requestData = '';
      let headers: Record<string, string> = {};

      if (isPrivate) {
        const postData = new URLSearchParams({
          nonce,
          ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
        }).toString();

        requestData = postData;
        const signature = this.sign(`/0/private/${endpoint}`, nonce + postData);
        headers = {
          ...headers,
          'API-Key': this.apiKey,
          'API-Sign': signature,
        };
      } else {
        requestData = new URLSearchParams(
          Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
        ).toString();
      }

      this.logger.debug('Kraken API request initiated', {
        endpoint: `${isPrivate ? 'private' : 'public'}/${endpoint}`,
        method: 'POST',
        baseUrl: this.baseUrl,
        paramCount: Object.keys(params).length,
        retryAttempt: retryCount + 1,
        maxRetries: this.numRetries,
        nonce: isPrivate ? nonce : 'N/A',
      });

      const response: AxiosResponse = await this.axios.post(
        `/0/${isPrivate ? 'private' : 'public'}/${endpoint}`,
        requestData,
        { headers },
      );

      if (response.data.error && response.data.error.length > 0) {
        this.logger.warn('Kraken API error:', {
          error: jsonifyError(response.data.error),
          endpoint: `/0/${isPrivate ? 'private' : 'public'}/${endpoint}`,
          data: requestData,
        });
        throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
      }

      return response.data.result as T;
    } catch (error) {
      if (retryCount < this.numRetries && this.shouldRetry(error)) {
        const delay = Math.pow(2, retryCount) * 1000;
        this.logger.warn('Kraken API request failed, retrying with exponential backoff', {
          endpoint: `${isPrivate ? 'private' : 'public'}/${endpoint}`,
          error: jsonifyError(error),
          retryAttempt: retryCount + 1,
          maxRetries: this.numRetries,
          backoffDelayMs: delay,
          httpStatus: axios.isAxiosError(error) ? error.response?.status : 'unknown',
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request(endpoint, params, isPrivate, retryCount + 1);
      }

      this.logger.error('Kraken API request failed after all retries exhausted', {
        endpoint: `${isPrivate ? 'private' : 'public'}/${endpoint}`,
        error: jsonifyError(error),
        totalAttempts: retryCount + 1,
        maxRetries: this.numRetries,
        httpStatus: axios.isAxiosError(error) ? error.response?.status : 'unknown',
        responseData: axios.isAxiosError(error) ? error.response?.data : undefined,
      });
      throw error;
    }
  }

  private shouldRetry(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      return error.response?.status === 429 || (error.response?.status ?? 0) >= 500;
    }
    const err = error as Error;
    if (err.message.includes(`Rate limit exceeded`)) {
      return false;
    }
    if (err.message.includes(`Internal error`)) {
      return false;
    }
    return false;
  }

  async getSystemStatus(): Promise<KrakenSystemStatus> {
    return this.request<KrakenSystemStatus>('SystemStatus');
  }

  async isSystemOperational(): Promise<boolean> {
    try {
      const status = await this.getSystemStatus();
      return status.status === 'online';
    } catch (error) {
      this.logger.error('Kraken system status check failed, assuming offline', {
        error: jsonifyError(error),
        endpoint: 'public/SystemStatus',
        fallbackStatus: 'offline',
        httpStatus: axios.isAxiosError(error) ? error.response?.status : 'unknown',
      });
      return false;
    }
  }

  async getAssetInfo(assets?: string[]): Promise<Record<string, KrakenAssetInfo>> {
    const params: Record<string, unknown> = {};
    if (assets && assets.length > 0) {
      params.asset = assets.join(',');
    }
    return this.request<Record<string, KrakenAssetInfo>>('Assets', params);
  }

  async getBalance(): Promise<KrakenBalance> {
    return this.request<KrakenBalance>('Balance', {}, true);
  }

  async getDepositMethods(asset: string): Promise<KrakenDepositMethod[]> {
    const result = await this.request<KrakenDepositMethod[]>('DepositMethods', { asset }, true);
    return Array.isArray(result) ? result : [];
  }

  async getDepositAddresses(asset: string, method: string, new_address = false): Promise<KrakenDepositAddress[]> {
    const result = await this.request<KrakenDepositAddress[]>(
      'DepositAddresses',
      { asset, method, new: new_address },
      true,
    );
    return Array.isArray(result) ? result : [];
  }

  /**
   * @dev Returns latest 25 deposits for method/asset
   */
  async getDepositStatus(asset: string, method: string): Promise<KrakenDepositRecord[]> {
    const result = await this.request<KrakenDepositRecord[]>(
      'DepositStatus',
      {
        asset,
        method,
      },
      true,
    );
    return Array.isArray(result) ? result : [];
  }

  async getWithdrawMethods(asset: string): Promise<KrakenWithdrawMethod[]> {
    const result = await this.request<KrakenWithdrawMethod[]>('WithdrawMethods', { asset }, true);
    return Array.isArray(result) ? result : [];
  }

  async getWithdrawInfo(asset: string, key: string, amount: string): Promise<KrakenWithdrawInfo> {
    return this.request<KrakenWithdrawInfo>('WithdrawInfo', { asset, key: key.toLowerCase(), amount }, true);
  }

  async withdraw(params: { asset: string; key: string; amount: string }): Promise<KrakenWithdrawResponse> {
    return this.request<KrakenWithdrawResponse>('Withdraw', params, true);
  }

  async getWithdrawStatus(asset: string, method: string, refid: string): Promise<KrakenWithdrawRecord | undefined> {
    const MAX_PAGES = 10; // hard cap on pagination
    const PAGE_LIMIT = 50; // server page size (newest→oldest)
    const target = refid.toLowerCase();

    let cursor: string | undefined;
    const params = { asset, method, limit: PAGE_LIMIT } as Record<string, string | number>;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (cursor) {
        params.cursor = cursor;
      }
      const raw = await this.request<KrakenWithdrawRecord[] | { withdrawals: KrakenWithdrawRecord[]; cursor?: string }>(
        'WithdrawStatus',
        params,
        true,
      );

      // Normalize shape -> cursor returned when > 1page of withdrawals
      const withdrawals = Array.isArray(raw) ? raw : (raw.withdrawals ?? []);
      const nextCursor = Array.isArray(raw) ? undefined : raw.cursor;

      // Look for the match on this page
      const hit = withdrawals.find((w) => w.refid?.toLowerCase() === target);
      if (hit) return hit;

      // No more pages
      if (!nextCursor || withdrawals.length === 0) break;

      cursor = nextCursor; // advance to next (older) page
    }

    return undefined;
  }
}
