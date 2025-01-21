import { Logger } from '../../../adapters/logger/src';
import { axiosGet, axiosPost } from './utils/axios';
import { ChainConfiguration, NewIntentParams, TransactionRequest } from '@mark/core';

export interface EverclearConfig {
  apiUrl: string;
  apiKey: string;
}

export interface Invoice {
  amount: number;
  chainId: string;
  id: string;
  owner: string;
  destinations: string[];
  ticker_hash: string;
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

    const { data } = await axiosGet<Invoice[]>(url, { params });
    return data;
  }

  async createNewIntent(params: NewIntentParams): Promise<TransactionRequest> {
    const url = `${this.config.apiUrl}/intents`;

    const { data } = await axiosPost<TransactionRequest>(url, { params });
    return data;
  }

  // Method stub for future implementation
  async updateInvoiceStatus(/* invoiceId: string, status: string */): Promise<void> {
    throw new Error('Not implemented');
  }
}
