import { Logger } from '../../../adapters/logger/src';

export interface EverclearConfig {
  apiUrl: string;
  apiKey: string;
}

export class EverclearAdapter {
  private readonly logger: Logger;
  private readonly config: EverclearConfig;

  constructor(config: EverclearConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async fetchInvoices(): Promise<any[]> {
    // Implementation will go here
    return []; // Temporarily
  }

  async updateInvoiceStatus(invoiceId: string, status: string) {
    // Implementation will go here
    throw new Error('Not implemented');
  }
}
