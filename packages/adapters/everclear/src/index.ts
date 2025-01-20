import { Logger } from '../../../adapters/logger/src';
import { axiosGet, axiosPost } from 'utils/axios';
import { ChainConfiguration, NewIntentParams, TransactionRequest } from '@mark/core';

export interface EverclearConfig {
  apiUrl: string;
  apiKey: string;
}

export interface Invoice {
  amount: string;
  chainId: string;
  id: string;
}

export class EverclearAdapter {
  private readonly logger: Logger;
  private readonly config: EverclearConfig;

  constructor(config: EverclearConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async fetchInvoices(destinations: Record<string, ChainConfiguration>): Promise<Invoice[]> {
    const url = `${this.config.apiUrl}/invoices`;

    const destinationKeys = Object.keys(destinations);
    const params = destinationKeys.length > 0 ? { destinations: destinationKeys } : {};

    const { data } = await axiosGet(url, { params });
    return data;
  }

  async createNewIntent(params: NewIntentParams) {
    const url = `${this.config.apiUrl}/intents`;

    const { data } = await axiosPost(url, { params });
    return data as TransactionRequest;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async updateInvoiceStatus(_invoiceId: string, _status: string) {
    // Implementation will go here
    throw new Error('Not implemented');
  }
}
