import { jsonifyError, Logger } from '@mark/logger';
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

export interface EconomyEpoch {
  epoch: number;
  startBlock: number;
  endBlock: number;
}

export interface QueueIntent {
  intentId: string;
  amount: string;
  owner: string;
  entryEpoch?: number;
  origin?: number;
  epoch?: number;
}

export interface IncomingIntent {
  intentId: string;
  initiator: string;
  amount: string;
  destinations: string[];
}

export interface EconomyDataResponse {
  currentEpoch: EconomyEpoch;
  incomingIntents: Record<string, IncomingIntent[]> | null;
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
    const LIMIT = 100;
    const url = `${this.apiUrl}/invoices?limit=${LIMIT}`;

    const destinationKeys = Object.keys(destinations);
    const params = destinationKeys.length > 0 ? { destinations: destinationKeys } : {};

    const { data } = await axiosGet<{ invoices: Invoice[] }>(url, { params });
    return data.invoices;
  }

  async createNewIntent(
    params: NewIntentParams | NewIntentWithPermit2Params | (NewIntentParams | NewIntentWithPermit2Params)[],
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
    try {
      const { data } = await axiosGet<IntentStatusResponse>(url);
      return data?.intent.status ?? IntentStatus.NONE;
    } catch (e) {
      this.logger.error('Failed to get intent status', {
        error: jsonifyError(e),
        intentId,
      });
      return IntentStatus.NONE;
    }
  }

  async getCustodiedAssets(tickerHash: string, domain: string): Promise<CustodiedAssetsResponse> {
    const url = `${this.apiUrl}/tickers/${tickerHash}/domains/${domain}/custodied-assets`;
    const { data } = await axiosGet<CustodiedAssetsResponse>(url);
    return data;
  }

  /**
   * Fetches economy data for a specific chain and asset ticker hash
   * @param chain - The chain ID
   * @param tickerHash - The asset ticker on the specified chain
   * @returns Economy data including current epoch, queues, and incoming intents
   */
  async fetchEconomyData(chain: string, tickerHash: string): Promise<EconomyDataResponse> {
    const url = `${this.apiUrl}/economy/${chain}/${tickerHash}`;
    try {
      const { data } = await axiosGet<EconomyDataResponse>(url);
      return data;
    } catch (error) {
      this.logger.error('Failed to fetch economy data from API', {
        error: jsonifyError(error),
        chain,
        tickerHash,
        url,
      });
      throw new Error(`Failed to fetch economy data for ${chain}/${tickerHash}: ${error}`);
    }
  }
}
