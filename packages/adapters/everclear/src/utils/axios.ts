import axios, { AxiosResponse, AxiosRequestConfig } from 'axios';

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
  numAttempts = 30,
  retryDelay = 2000,
): Promise<TResponse> => {
  let lastError;
  for (let i = 0; i < numAttempts; i++) {
    try {
      const response = await axios.post<TResponseData, TResponse, TRequestData>(url, data, config);
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
  data?: TRequestData,
  numAttempts = 5,
  retryDelay = 2000,
): Promise<TResponse> => {
  let lastError;
  for (let i = 0; i < numAttempts; i++) {
    try {
      const response = await axios.get<TResponseData, TResponse, TRequestData>(url, data);
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
