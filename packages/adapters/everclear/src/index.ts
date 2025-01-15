import { Logger } from '../../../adapters/logger/src';
import { axiosGet } from 'utils/axios';

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

  async fetchInvoices(destinations: string[]): Promise<Invoice[]> {
    const url = `${this.config.apiUrl}/invoices`;
    const params = destinations.length > 0 ? { destinations } : {}; // Need to know if we are only restricting it for blast

    const { data } = await axiosGet(url, { params });
    return data;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async updateInvoiceStatus(_invoiceId: string, _status: string) {
    // Implementation will go here
    throw new Error('Not implemented');
  }
}
