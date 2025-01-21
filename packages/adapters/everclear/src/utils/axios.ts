import axios, { AxiosResponse, AxiosRequestConfig } from 'axios';

/**
 * Creates a promise that resolves after a specified period
 *
 * @param ms - Time to wait for resolution
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
export const delay = (ms: number): Promise<void> => new Promise((res: () => void): any => setTimeout(res, ms));

export const axiosPost = async <T = any, R = AxiosResponse<T>, D = any>(
  url: string,
  data?: D,
  config?: AxiosRequestConfig<D>,
  numAttempts = 30,
  retryDelay = 2000,
): Promise<R> => {
  let error;
  for (let i = 0; i < numAttempts; i++) {
    try {
      const response = await axios.post<T, R, D>(url, data, config);
      return response;
    } catch (err: unknown) {
      // eslint-disable-next-line import/no-named-as-default-member
      if (axios.isAxiosError(err)) {
        error = { error: err.toJSON(), status: err.response?.status };
      }
      error = err;
    }
    await delay(retryDelay);
  }
  throw new Error('AxiosQueryError' + ' Post');
};

export const axiosGet = async <T = any, R = AxiosResponse<T>, D = any>(
  url: string,
  data?: D,
  numAttempts = 5,
  retryDelay = 2000,
): Promise<R> => {
  let error;
  for (let i = 0; i < numAttempts; i++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const response = await axios.get<T, R, D>(url, data as any);
      return response;
    } catch (err: unknown) {
      // eslint-disable-next-line import/no-named-as-default-member
      if (axios.isAxiosError(err)) {
        error = { error: err.toJSON(), status: err.response?.status };
      }
      error = err;
    }
    await delay(retryDelay);
  }
  throw new Error('AxiosQueryError' + ' Get');
};
