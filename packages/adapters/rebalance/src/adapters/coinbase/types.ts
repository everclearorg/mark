// Coinbase-specific types and interfaces

export const COINBASE_BASE_URL = 'https://api.coinbase.com';

export interface CoinbaseTransferRequest {
  type: 'send' | 'request';
  to: string;
  amount: string;
  currency: string;
  description?: string;
  idem?: string;
}

export interface CoinbaseTransferResponse {
  data: {
    id: string;
    type: string;
    status: string;
    amount: {
      amount: string;
      currency: string;
    };
    native_amount: {
      amount: string;
      currency: string;
    };
    description?: string;
    created_at: string;
    updated_at: string;
    resource: string;
    resource_path: string;
    network?: {
      status: string;
      status_description: string;
      hash?: string;
      transaction_url?: string;
    };
    to?: {
      resource: string;
      resource_path: string;
      address?: string;
      address_info?: {
        address: string;
        destination_tag?: string;
      };
    };
    from?: {
      resource: string;
      resource_path: string;
      address?: string;
    };
    details?: {
      title: string;
      subtitle: string;
      header: string;
      health: string;
    };
  };
}

export interface CoinbaseAddress {
  id: string;
  address: string;
  name?: string;
  created_at: string;
  updated_at: string;
  network: string;
  resource: string;
  resource_path: string;
  exchange_deposit_address?: boolean;
  callback_url?: string;
  destination_tag?: string;
}

export interface CoinbaseAddressResponse {
  data: CoinbaseAddress[];
  pagination?: {
    ending_before?: string;
    starting_after?: string;
    previous_ending_before?: string;
    next_starting_after?: string;
    limit?: number;
    order?: string;
    previous_uri?: string;
    next_uri?: string;
  };
}

export interface CoinbaseTx {
  id: string;
  type: string;
  status: string;
  amount: {
    amount: string;
    currency: string;
  };
  native_amount: {
    amount: string;
    currency: string;
  };
  description?: string;
  created_at: string;
  updated_at: string;
  resource: string;
  resource_path: string;
  network?: {
    status: string;
    status_description: string;
    hash?: string;
    transaction_url?: string;
    transaction_fee?: {
      amount: string;
      currency: string;
    };
  };
  to?: {
    resource: string;
    resource_path: string;
    address?: string;
    address_info?: {
      address: string;
      destination_tag?: string;
    };
  };
  from?: {
    resource: string;
    resource_path: string;
    address?: string;
  };
  details?: {
    title: string;
    subtitle: string;
    header: string;
    health: string;
  };
}


export interface CoinbaseApiResponse<T = any> {
  data: T;
  pagination?: {
    ending_before?: string;
    starting_after?: string;
    previous_ending_before?: string;
    next_starting_after?: string;
    limit?: number;
    order?: string;
    previous_uri?: string;
    next_uri?: string;
  };
  warnings?: string[];
}

export interface CoinbaseTxAmount {
  amount: string;
  currency: string;
}

export interface CoinbaseTxNetworkInfo {
  status: string;
  name: string;
}

export interface CoinbaseTxParty {
  id?: string;
  resource?: string;
  address?: string;
}

export interface CoinbaseDepositAccount {
  accountId: string;
  accountName?: string;
  currencyCode: string;
  addressId: string;
  address: string;
  network?: string;
}

export interface CoinbaseTxResponse {
  data: CoinbaseTx[];
  pagination?: {
    ending_before?: string;
    starting_after?: string;
    previous_ending_before?: string;
    next_starting_after?: string;
    limit?: number;
    order?: string;
    previous_uri?: string;
    next_uri?: string;
  };
}

export interface CoinbaseError {
  id: string;
  message: string;
  url?: string;
  errors?: Array<{
    id: string;
    message: string;
    url?: string;
  }>;
}

export interface CoinbaseApiError extends Error {
  response?: Response;
  status?: number;
  errors?: CoinbaseError[];
}
