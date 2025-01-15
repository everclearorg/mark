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

  async fetchInvoices(): Promise<unknown[]> {
    // Implementation will go here
    return []; // Temporarily
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async updateInvoiceStatus(_invoiceId: string, _status: string) {
    // Implementation will go here
    throw new Error('Not implemented');
  }
}
