import axios, { AxiosResponse, AxiosRequestConfig, AxiosInstance } from 'axios';
import { Agent } from 'https';
import { Agent as HttpAgent } from 'http';

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
        lastError = { error: err.toJSON(), status: err.response?.status };
      } else {
        lastError = err;
      }
    }
    await delay(retryDelay);
  }
  throw new Error(`AxiosQueryError Post: ${JSON.stringify(lastError)}`);
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
        lastError = { error: err.toJSON(), status: err.response?.status };
      } else {
        lastError = err;
      }
    }
    await delay(retryDelay);
  }
  throw new Error(`AxiosQueryError Get: ${JSON.stringify(lastError)}`);
};
