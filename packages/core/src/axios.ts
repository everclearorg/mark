import axios, { AxiosResponse, AxiosRequestConfig, AxiosInstance } from 'axios';
import { Agent } from 'https';
import { Agent as HttpAgent } from 'http';
import { AxiosQueryError } from './errors';

interface CleanedError extends Record<string, unknown> {
  message: string;
  status?: number;
  statusText?: string;
  url?: string;
  method?: string;
  data?: unknown;
}

// Singleton axios instance with connection pooling
let axiosInstance: AxiosInstance | null = null;

function getAxiosInstance(): AxiosInstance {
  if (!axiosInstance) {
    const httpsAgent = new Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: 60000,
    });

    const httpAgent = new HttpAgent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: 60000,
    });

    axiosInstance = axios.create({
      timeout: 60000,
      httpsAgent,
      httpAgent,
      maxRedirects: 5,
    });
  }
  return axiosInstance;
}

// Cleanup function to destroy the axios instance and close connections
export function cleanupHttpConnections(): void {
  if (axiosInstance) {
    try {
      const instance = axiosInstance;
      if (instance.defaults.httpsAgent && typeof instance.defaults.httpsAgent.destroy === 'function') {
        instance.defaults.httpsAgent.destroy();
      }
      if (instance.defaults.httpAgent && typeof instance.defaults.httpAgent.destroy === 'function') {
        instance.defaults.httpAgent.destroy();
      }
      axiosInstance = null;
      console.log('HTTP connections cleaned up successfully');
    } catch (error) {
      console.warn('Error cleaning up HTTP connections:', error);
    }
  }
}

/**
 * Creates a promise that resolves after a specified period
 *
 * @param ms - Time to wait for resolution
 */
export const delay = (ms: number): Promise<void> => new Promise((res: () => void) => setTimeout(res, ms));

export const axiosPost = async <
  TResponseData = unknown,
  TResponse extends AxiosResponse<TResponseData> = AxiosResponse<TResponseData>,
  TRequestData = unknown,
>(
  url: string,
  data?: TRequestData,
  config?: AxiosRequestConfig<TRequestData>,
  numAttempts = 10,
  retryDelay = 2000,
): Promise<TResponse> => {
  const instance = getAxiosInstance();
  let lastError;
  for (let i = 0; i < numAttempts; i++) {
    try {
      const response = await instance.post<TResponseData, TResponse, TRequestData>(url, data, config);
      return response;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        // Create a clean error object without TLS/socket details
        lastError = {
          message: err.message,
          status: err.response?.status,
          statusText: err.response?.statusText,
          url: err.config?.url,
          method: err.config?.method,
          data: err.response?.data,
        };
      } else {
        lastError = err;
      }
    }
    await delay(retryDelay);
  }

  // Create a cleaner error message for logging
  const errorMessage =
    axios.isAxiosError(lastError) || (lastError && typeof lastError === 'object' && 'status' in lastError)
      ? `HTTP ${(lastError as CleanedError).status || 'unknown'} error from ${(lastError as CleanedError).url || url}`
      : 'Request failed';

  throw new AxiosQueryError(`AxiosQueryError Post: ${errorMessage}`, lastError as CleanedError);
};

export const axiosGet = async <
  TResponseData = unknown,
  TResponse extends AxiosResponse<TResponseData> = AxiosResponse<TResponseData>,
  TRequestData = unknown,
>(
  url: string,
  config?: AxiosRequestConfig<TRequestData>,
  numAttempts = 5,
  retryDelay = 2000,
): Promise<TResponse> => {
  const instance = getAxiosInstance();
  let lastError;
  for (let i = 0; i < numAttempts; i++) {
    try {
      const response = await instance.get<TResponseData, TResponse>(url, config);
      return response;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        // Create a clean error object without TLS/socket details
        lastError = {
          message: err.message,
          status: err.response?.status,
          statusText: err.response?.statusText,
          url: err.config?.url,
          method: err.config?.method,
          data: err.response?.data,
        };
      } else {
        lastError = err;
      }
    }
    await delay(retryDelay);
  }

  // Create a cleaner error message for logging
  const errorMessage =
    axios.isAxiosError(lastError) || (lastError && typeof lastError === 'object' && 'status' in lastError)
      ? `HTTP ${(lastError as CleanedError).status || 'unknown'} error from ${(lastError as CleanedError).url || url}`
      : 'Request failed';

  throw new AxiosQueryError(`AxiosQueryError Get: ${errorMessage}`, lastError as CleanedError);
};
