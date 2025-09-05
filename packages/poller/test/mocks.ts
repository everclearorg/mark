import { Invoice, MarkConfiguration } from '@mark/core';
import { Address } from 'viem';
import { stub, SinonStub } from 'sinon';

// Default single-dest mock invoice, optional override fields
export function createMockInvoice(overrides?: Partial<Invoice>): Invoice {
  return {
    intent_id: '0x123',
    amount: '1000000000000000000',
    origin: '1',
    destinations: ['8453'],
    ticker_hash: '0xticker1',
    hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 7200,
    source_domain: '1',
    target_domain: '8453',
    source_address: '0xsource',
    target_address: '0xtarget',
    source_token_address: '0xtoken1',
    target_token_address: '0xtoken2',
    status: 'PENDING',
    owner: '0xowner',
    entry_epoch: 0,
    discountBps: 0,
    hub_status: 'PENDING',
    severity: 0,
    ...overrides,
  } as Invoice;
}

export const mockConfig: MarkConfiguration = {
  pushGatewayUrl: 'http://localhost:9091',
  web3SignerUrl: 'http://localhost:8545',
  everclearApiUrl: 'http://localhost:3000',
  relayer: {
    url: 'http://localhost:8080',
  },
  binance: {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
  },
  kraken: {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
  },
  near: {
    jwtToken: 'test-jwt-token',
  },
  redis: {
    host: 'localhost',
    port: 6379,
  },
  ownAddress: '0x1234567890123456789012345678901234567890',
  ownSolAddress: '9WUUr2WNUiKMzwxJgbb4oxS81oYAyhrBFkv3NSg2mjbj',
  stage: 'development',
  environment: 'devnet',
  logLevel: 'debug',
  supportedSettlementDomains: [1, 8453],
  forceOldestInvoice: false,
  supportedAssets: ['0xticker1'],
  purchaseCacheTtlSeconds: 5400,
  chains: {
    '1': {
      providers: ['http://localhost:8545'],
      assets: [
        {
          tickerHash: '0xticker1',
          address: '0xtoken1',
          decimals: 18,
          symbol: 'TEST',
          isNative: false,
          balanceThreshold: '1000000000000000000',
        },
      ],
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      invoiceAge: 3600,
      gasThreshold: '1000000000000000000',
    },
    '8453': {
      providers: ['http://localhost:8545'],
      assets: [
        {
          tickerHash: '0xticker1',
          address: '0xtoken1',
          decimals: 18,
          symbol: 'TEST',
          isNative: false,
          balanceThreshold: '1000000000000000000',
        },
      ],
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      invoiceAge: 3600,
      gasThreshold: '1000000000000000000',
    },
    '10': {
      providers: ['http://localhost:8545'],
      assets: [
        {
          tickerHash: '0xticker1',
          address: '0xtoken1',
          decimals: 18,
          symbol: 'TEST',
          isNative: false,
          balanceThreshold: '1000000000000000000',
        },
      ],
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      invoiceAge: 3600,
      gasThreshold: '1000000000000000000',
    },
  },
  hub: {
    domain: '1',
    providers: ['http://localhost:8545'],
    assets: [
      {
        tickerHash: '0xticker1',
        address: '0xtoken1',
        decimals: 18,
        symbol: 'TEST',
        isNative: false,
        balanceThreshold: '1000000000000000000',
      },
    ],
  },
  routes: [],
  database: {
    connectionString: 'postgresql://test:test@localhost:5432/test',
  },
};

export interface MockWalletClient {
  account: {
    address: Address;
  };
  signTypedData: SinonStub;
  sendTransaction: SinonStub;
  signMessage: SinonStub;
  getAddresses: SinonStub;
  requestAddresses: SinonStub;
}

/**
 * Creates a mock WalletClient for use in tests
 * @param address - The address to use for the wallet (defaults to a test address)
 * @returns A mocked WalletClient with stubbed methods
 */
export function createMockWalletClient(
  address: Address = '0x1234567890123456789012345678901234567890'
): MockWalletClient {
  return {
    account: {
      address,
    },
    signTypedData: stub().resolves('0xmocked_signature'),
    sendTransaction: stub().resolves('0xmocked_transaction_hash'),
    signMessage: stub().resolves('0xmocked_message_signature'),
    getAddresses: stub().resolves([address]),
    requestAddresses: stub().resolves([address]),
  };
}

/**
 * Creates a mock WalletClient that will fail with specific errors
 * Useful for testing error handling
 */
export function createFailingMockWalletClient(
  address: Address = '0x1234567890123456789012345678901234567890',
  error: Error = new Error('Mock wallet error')
): MockWalletClient {
  return {
    account: {
      address,
    },
    signTypedData: stub().rejects(error),
    sendTransaction: stub().rejects(error),
    signMessage: stub().rejects(error),
    getAddresses: stub().resolves([address]),
    requestAddresses: stub().resolves([address]),
  };
}
