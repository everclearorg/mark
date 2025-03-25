import { Logger } from '@mark/logger';
import { axiosPost, axiosGet } from '@mark/core';
import {
  ChainConfiguration,
  NewIntentParams,
  TransactionRequest,
  Invoice,
  NewIntentWithPermit2Params,
} from '@mark/core';

export interface MinAmountsResponse {
  invoiceAmount: string;
  amountAfterDiscount: string;
  discountBps: string;
  custodiedAmounts: Record<string, string>;
  minAmounts: Record<string, string>;
}

export interface CustodiedAssetsResponse {
  custodiedAmount: string;
}

export enum IntentStatus {
  NONE = 'NONE',
  ADDED = 'ADDED',
  ADDED_SPOKE = 'ADDED_SPOKE',
  ADDED_HUB = 'ADDED_HUB',
  DEPOSIT_PROCESSED = 'DEPOSIT_PROCESSED',
  FILLED = 'FILLED',
  ADDED_AND_FILLED = 'ADDED_AND_FILLED',
  INVOICED = 'INVOICED',
  SETTLED = 'SETTLED',
  SETTLED_AND_COMPLETED = 'SETTLED_AND_COMPLETED',
  SETTLED_AND_MANUALLY_EXECUTED = 'SETTLED_AND_MANUALLY_EXECUTED',
  UNSUPPORTED = 'UNSUPPORTED',
  UNSUPPORTED_RETURNED = 'UNSUPPORTED_RETURNED',
  DISPATCHED_HUB = 'DISPATCHED_HUB',
  DISPATCHED_SPOKE = 'DISPATCHED_SPOKE',
  DISPATCHED_UNSUPPORTED = 'DISPATCHED_UNSUPPORTED',
}

export interface IntentStatusResponse {
  intent: {
    intent_id: string;
    queue_idx: number;
    message_id: string;
    status: IntentStatus;
    receiver: string;
    input_asset: string;
    output_asset: string;
    origin_amount: string;
    destination_amount: string;
    origin: string;
    nonce: number;
    transaction_hash: string;
    receive_tx_hash: string;
    intent_created_timestamp: number;
    settlement_timestamp: number;
    intent_created_block_number: number;
    receive_blocknumber: number;
    tx_origin: string;
    tx_nonce: number;
    auto_id: number;
    max_fee: string;
    call_data: string;
    filled: boolean;
    initiator: string;
    origin_gas_fees: string;
    destination_gas_fees: string;
    hub_settlement_domain: string;
    ttl: number;
    destinations: string[];
  };
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

  async createNewIntent(
    params: NewIntentParams | NewIntentWithPermit2Params | (NewIntentParams | NewIntentWithPermit2Params)[]
  ): Promise<TransactionRequest> {
    try {
      const url = `${this.apiUrl}/intents`;
      const { data } = await axiosPost<TransactionRequest>(url, params);
      return data;
    } catch (err) {
      throw new Error(`Failed to fetch create intent from API ${err}`);
    }
  }

  async getMinAmounts(intentId: string): Promise<MinAmountsResponse> {
    const url = `${this.apiUrl}/invoices/${intentId}/min-amounts`;
    const { data } = await axiosGet<MinAmountsResponse>(url);
    return data;
  }

  async intentStatus(intentId: string): Promise<IntentStatus> {
    const url = `${this.apiUrl}/intents/${intentId}`;
    const { data } = await axiosGet<IntentStatusResponse>(url);
    return data?.intent.status ?? IntentStatus.NONE;
  }

  async getCustodiedAssets(tickerHash: string, domain: string): Promise<CustodiedAssetsResponse> {
    const url = `${this.apiUrl}/tickers/${tickerHash}/domains/${domain}/custodied-assets`;
    const { data } = await axiosGet<CustodiedAssetsResponse>(url);
    return data;
  }
}
