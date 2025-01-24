import { Logger } from '@mark/logger';
import { axiosPost, axiosGet } from '@mark/core';
import { ChainConfiguration, NewIntentParams, TransactionRequest } from '@mark/core';

export interface Invoice {
  amount: string;
  intent_id: string;
  owner: string;
  entry_epoch: number;
  origin: string;
  destinations: string[];
  ticker_hash: string;
  discountBps: number;
  hub_status: string; // TODO: opinionated type
  hub_invoice_enqueued_timestamp: number;
}

export class EverclearAdapter {
  private readonly apiUrl: string;
  private readonly logger: Logger;

  constructor(apiUrl: string, logger: Logger) {
    this.apiUrl = apiUrl;
    this.logger = logger;
  }

  async fetchInvoices(destinations: Record<string, ChainConfiguration>): Promise<Invoice[]> {
    const url = `${this.apiUrl}/invoices`;

    const destinationKeys = Object.keys(destinations);
    const params = destinationKeys.length > 0 ? { destinations: destinationKeys } : {};

    const { data } = await axiosGet<{ invoices: Invoice[] }>(url, { params });
    return data.invoices;
    // return [
    //   {
    //     intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
    //     owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
    //     entry_epoch: 186595,
    //     amount: '1506224658731513369685',
    //     discountBps: 1.2,
    //     origin: '1',
    //     destinations: ['8453'],
    //     hub_status: 'INVOICED',
    //     ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
    //     hub_invoice_enqueued_timestamp: 1737491219,
    //   },
    //   {
    //     intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
    //     owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
    //     entry_epoch: 186595,
    //     amount: '1706224658731513369685',
    //     discountBps: 1.2,
    //     origin: '1',
    //     destinations: ['8453'],
    //     hub_status: 'INVOICED',
    //     ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
    //     hub_invoice_enqueued_timestamp: 1737491219,
    //   },
    //   {
    //     intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
    //     owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
    //     entry_epoch: 186595,
    //     amount: '2506224658731513369685',
    //     discountBps: 0.8,
    //     origin: '56',
    //     destinations: ['1'],
    //     hub_status: 'INVOICED',
    //     ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
    //     hub_invoice_enqueued_timestamp: 1737491219,
    //   },
    //   {
    //     intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
    //     owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
    //     entry_epoch: 186595,
    //     amount: '1506224658731513369',
    //     discountBps: 0.8,
    //     origin: '56',
    //     destinations: ['1'],
    //     hub_status: 'INVOICED',
    //     ticker_hash: '0x0f8a193ff464434486c0daf7db2a895884365d2bc84ba47a68fcf89c1b14b5b8',
    //     hub_invoice_enqueued_timestamp: 1737491219,
    //   },
    //   {
    //     intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
    //     owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
    //     entry_epoch: 186595,
    //     amount: '1506224658731513369685',
    //     discountBps: 0.8,
    //     origin: '56',
    //     destinations: ['1'],
    //     hub_status: 'INVOICED',
    //     ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
    //     hub_invoice_enqueued_timestamp: 1737491219,
    //   },
    // ];
  }

  async createNewIntent(params: NewIntentParams): Promise<TransactionRequest> {
    try {
      const url = `${this.apiUrl}/intents`;
      const { data } = await axiosPost<TransactionRequest>(url, params);
      return data;
    } catch (err) {
      throw new Error(`Failed to fetch create intent from API ${err}`);
    }
  }

  // Method stub for future implementation
  async updateInvoiceStatus(/* invoiceId: string, status: string */): Promise<void> {
    throw new Error('Not implemented');
  }
}
