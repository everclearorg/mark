/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest, afterEach } from '@jest/globals';
import axios from 'axios';
import { CoinbaseClient } from '../../../src/adapters/coinbase/client';

const mockAccounts = [
    {
      id: 'acc-eth',
      name: 'ETH',
      type: 'wallet',
      currency: { code: 'ETH', name: 'Ethereum' },
      balance: { amount: '1', currency: 'ETH' },
    },
  {
    id: 'acc-usdc',
    name: 'USDC Acc',
    type: 'wallet',
    currency: { code: 'USDC', name: 'USD Coin' },
    balance: { amount: '1000', currency: 'USDC' },
  },
  {
    id: 'acc-eurc',
    name: 'EURC Acc',
    type: 'wallet',
    currency: { code: 'EURC', name: 'Euro Coin' },
    balance: { amount: '500', currency: 'EURC' },
  },
  ]

jest.mock('axios');
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'jwt-token'),
}));
jest.mock('crypto', () => {
  const actualCrypto = jest.requireActual('crypto') as any;
  return {
    randomBytes: jest.fn((size: number) => {
      const buf = Buffer.alloc(size);
      buf.fill(0);
      return buf;
    }),
    createHmac: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn(() => Buffer.from('sig')),
    })),
    ...actualCrypto,
  };
});

describe('CoinbaseClient', () => {
  const apiKey = 'key';
  const apiSecret = 'secret';
  const allowedRecipients = ['0xabc0000000000000000000000000000000000000'];

  const mockAxios = axios as unknown as jest.Mocked<typeof axios>;

  beforeEach(() => {
    jest.clearAllMocks();
    // default axios response
    mockAxios.mockResolvedValue({ data: {} } as any);
    // default fetch
    (global as any).fetch = (jest.fn() as any).mockResolvedValue({
      ok: true,
      json: async () => ({ fee: '0.01' }),
      statusText: 'OK',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('getInstance returns validated instance when skipValidation', async () => {
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    expect(client.isConfigured()).toBe(true);
  });

  it('getCoinbaseNetwork maps known chainId and throws for unknown', async () => {
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    const net = client.getCoinbaseNetwork(42161);
    expect(net.networkLabel).toBe('arbitrum');
    expect(() => client.getCoinbaseNetwork(99999)).toThrow('Unsupported chain ID: 99999');
  });

  it('getAccounts returns paged data', async () => {
    // first page
    mockAxios.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'acc-1',
            name: 'ETH Acc',
            type: 'wallet',
            currency: { code: 'ETH', name: 'Ethereum' },
            balance: { amount: '1', currency: 'ETH' },
          },
        ],
        pagination: { next_starting_after: undefined },
      },
    } as any);

    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    const res = await client.getAccounts();
    expect(Array.isArray(res.data)).toBe(true);
    expect(mockAxios).toHaveBeenCalled();
  });

  it('getTransactionByHash returns null when not found', async () => {
    mockAxios.mockResolvedValueOnce({
      data: {
        data: [{ network: { hash: '0xnotit' } }],
        pagination: {},
      },
    } as any);
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    const tx = await client.getTransactionByHash('acc', 'addr', '0xdeadbeef');
    expect(tx).toBeNull();
  });

  it('getTransactionByHash returns matching tx and stops early', async () => {
    mockAxios.mockResolvedValueOnce({
      data: {
        data: [{ network: { hash: 'deadbeef' } }],
        pagination: {},
      },
    } as any);
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    const tx = await client.getTransactionByHash('acc', 'addr', '0xdeadbeef');
    expect(tx).toEqual({ network: { hash: 'deadbeef' } });
  });

  it('listTransactions builds GET query params correctly', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { data: [], pagination: {} },
    } as any);
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await client.listTransactions('acc-1', { limit: 50, order: 'asc', starting_after: 'a', ending_before: 'b' });
    const callArgs = ((axios as unknown) as jest.Mock).mock.calls[0][0] as { url: string };
    expect(callArgs.url).toContain('/v2/accounts/acc-1/transactions?');
    expect(callArgs.url).toContain('limit=50');
    expect(callArgs.url).toContain('order=asc');
    expect(callArgs.url).toContain('starting_after=a');
    expect(callArgs.url).toContain('ending_before=b');
  });

  it('makeRequest maps axios error to Coinbase API error', async () => {
    (mockAxios as any).isAxiosError = () => true;
    mockAxios.mockRejectedValueOnce({
      response: { status: 500, statusText: 'Internal Server Error', data: { message: 'boom' } },
    });
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(client.getAccounts()).rejects.toThrow('Coinbase API error: 500 Internal Server Error');
  });
  it('sendCrypto validates network/asset support and allowed recipients', async () => {
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    // configure supported account id to pass accountId check
    (client as any).supportedAssets.ETH.accountId = 'acc-eth';
    expect(() =>
      client.sendCrypto({ to: '0xabc', units: '1', currency: 'FOO', network: 'ethereum' }),
    ).rejects.toThrow('Currency "FOO" on network "ethereum" is not supported');
    await expect(
      client.sendCrypto({
        to: '0xdef0000000000000000000000000000000000000',
        units: '1',
        currency: 'ETH',
        network: 'ethereum',
      }),
    ).rejects.toThrow('Recipient address "0xdef0000000000000000000000000000000000000" is not in the configured allowed recipients list');
  });

  it('sendCrypto throws when accountId missing for currency', async () => {
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    (client as any).supportedAssets.ETH.accountId = undefined;
    await expect(
      client.sendCrypto({ to: allowedRecipients[0], units: '1', currency: 'ETH', network: 'ethereum' }),
    ).rejects.toThrow('No account found for currency "ETH".');
  });

  it('getWithdrawalFee uses fetch and returns fee', async () => {
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    const fee = await client.getWithdrawalFee({ currency: 'ETH', crypto_address: '0xabc', network: 'ethereum' });
    expect(fee).toBe('0.01');
    expect((global as any).fetch).toHaveBeenCalled();
  });

  it('getDepositAccount selects address by network group or throws', async () => {
    // accounts
    mockAxios
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              id: 'acc-eth',
              name: 'ETH',
              type: 'wallet',
              currency: { code: 'ETH', name: 'Ethereum' },
              balance: { amount: '1', currency: 'ETH' },
            },
          ],
          pagination: {},
        },
      } as any)
      // listAddresses
      .mockResolvedValueOnce({
        data: { data: [{ id: 'addr-1', address: '0xabc', network: 'ethereum' }], pagination: {} },
      } as any)
      // showAddress
      .mockResolvedValueOnce({ data: { data: { id: 'addr-1', address: '0xabc', network: 'ethereum' } } } as any);

    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });

    const acct = await client.getDepositAccount('ETH', 'ethereum');
    expect(acct.address).toBe('0xabc');
  });

  it('getDepositAccount throws when asset/network not supported', async () => {
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(client.getDepositAccount('ETH', 'unknown-net')).rejects.toThrow(
      'Currency "ETH" on network "unknown-net" is not supported',
    );
  });
  it('validateConnection returns true and propagates errors', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { data: [], pagination: {} },
    } as any);
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(client.validateConnection()).resolves.toBe(true);

    (mockAxios as any).isAxiosError = () => false;
    mockAxios.mockRejectedValueOnce(new Error('network error'));
    await expect(client.validateConnection()).rejects.toThrow('network error');
  });

  it('getWithdrawalFee throws when response not ok', async () => {
    (global as any).fetch = (jest.fn() as any).mockResolvedValue({
      ok: false,
      statusText: 'Bad',
    });
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(
      client.getWithdrawalFee({ currency: 'ETH', crypto_address: '0xabc', network: 'ethereum' }),
    ).rejects.toThrow('Failed to get withdrawal fee: Bad');
  });

  it('getDepositAccount throws when no account found for currency', async () => {
    mockAxios.mockResolvedValueOnce({
      data: {
        data: [{ id: 'acc-eth', name: 'ETH', type: 'wallet', currency: { code: 'ETH', name: 'Ethereum' }, balance: { amount: '1', currency: 'ETH' } }],
        pagination: {},
      },
    } as any);
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(client.getDepositAccount('USDC', 'ethereum')).rejects.toThrow(
      'No Coinbase account found for currency "USDC"',
    );
  });

  it('getTransactionByHash stops early when condition matches on second page', async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {
          data: [{ network: { hash: '0xnotit' } }],
          pagination: { next_starting_after: 'cursor1' },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          data: [{ network: { hash: '0xdeadbeef' } }],
          pagination: {},
        },
      } as any);
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    const tx = await client.getTransactionByHash('acc', 'addr', '0xdeadbeef');
    expect(tx).not.toBeNull();
    expect(tx?.network?.hash).toBe('0xdeadbeef');
  });

  it('makeRequest throws when GET query param is not string', async () => {
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(
      (client as any).makeRequest({
        method: 'GET',
        path: '/test',
        body: { limit: 100 },
      }),
    ).rejects.toThrow('Query parameter "limit" must be a string');
  });

  it('getDepositAccount throws when no matching address found', async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              id: 'acc-eth',
              name: 'ETH',
              type: 'wallet',
              currency: { code: 'ETH', name: 'Ethereum' },
              balance: { amount: '1', currency: 'ETH' },
            },
          ],
          pagination: {},
        },
      } as any)
      .mockResolvedValueOnce({
        data: { data: [{ id: 'addr-1', address: '0xabc', network: 'polygon' }], pagination: {} },
      } as any)
      .mockResolvedValueOnce({ data: { data: { id: 'addr-1', address: '0xabc', network: 'polygon' } } } as any);
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(client.getDepositAccount('ETH', 'ethereum')).rejects.toThrow(
      'No deposit address available for ETH on ethereum',
    );
  });

  it('getDepositAccount handles listAddresses 500 error', async () => {
    mockAxios
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              id: 'acc-eth',
              name: 'ETH',
              type: 'wallet',
              currency: { code: 'ETH', name: 'Ethereum' },
              balance: { amount: '1', currency: 'ETH' },
            },
          ],
          pagination: {},
        },
      } as any)
      .mockRejectedValueOnce(new Error('500 Internal Server Error'));
    const client = await (CoinbaseClient as any).getInstance({
      apiKey,
      apiSecret,
      allowedRecipients,
      skipValidation: true,
    });
    await expect(client.getDepositAccount('ETH', 'ethereum')).rejects.toThrow(
      'No deposit address available for ETH on ethereum',
    );
  });

});


