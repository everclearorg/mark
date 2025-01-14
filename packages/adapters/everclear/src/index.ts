import { Logger } from '@mark/logger-adapter';

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

  async fetchInvoices() {
    // Implementation will go here
    throw new Error('Not implemented');
  }

  async updateInvoiceStatus(invoiceId: string, status: string) {
    // Implementation will go here
    throw new Error('Not implemented');
  }
}
