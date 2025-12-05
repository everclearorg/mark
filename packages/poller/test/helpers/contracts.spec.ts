import sinon from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { MarkConfiguration } from '@mark/core';

// Test types
interface MockContractConfig {
  chains: Record<
    string,
    {
      providers: string[];
      deployments?: { multicall3: string };
    }
  >;
  hub: {
    domain: string;
    providers: string[];
  };
  environment?: string;
}

interface MockClient {
  // Prevent arbitrary properties to improve type safety
  [key: string]: never;
}

describe('Contracts Module', () => {
  const HUB_TESTNET_ADDR = '0x4C526917051ee1981475BB6c49361B0756F505a8';
  const HUB_MAINNET_ADDR = '0xa05A3380889115bf313f1Db9d5f335157Be4D816';
  const mockConfig: MockContractConfig = {
    chains: {
      '1': {
        providers: ['https://mainnet.infura.io/v3/test'],
        deployments: { multicall3: '0xMulticallAddress' },
      },
      hub_chain_id: { providers: ['https://hub.infura.io/v3/test'] },
    },
    hub: {
      domain: 'hub_domain',
      providers: ['https://mainnet.infura.io/v3/test'],
    },
  };

  afterEach(() => {
    sinon.restore();
    contractModule.cleanupViemClients();
  });

  describe('getMulticallAddress', () => {
    it('should return multicall address for valid chainId', () => {
      const address = contractModule.getMulticallAddress('1', mockConfig as MarkConfiguration);
      expect(address).toBe('0xMulticallAddress');
    });

    it('should throw error for invalid chainId', () => {
      expect(() => contractModule.getMulticallAddress('999', mockConfig as MarkConfiguration)).toThrow(
        'Chain configuration not found for chain ID: 999',
      );
    });
  });

  describe('getProviderUrls', () => {
    it('should return all provider URLs for a valid chainId', () => {
      const configWithMultipleProviders: MockContractConfig = {
        ...mockConfig,
        chains: {
          '1': {
            providers: [
              'https://mainnet.infura.io/v3/test1',
              'https://mainnet.infura.io/v3/test2',
              'https://mainnet.infura.io/v3/test3',
            ],
          },
        },
      };
      const urls = contractModule.getProviderUrls('1', configWithMultipleProviders as MarkConfiguration);
      expect(urls).toEqual([
        'https://mainnet.infura.io/v3/test1',
        'https://mainnet.infura.io/v3/test2',
        'https://mainnet.infura.io/v3/test3',
      ]);
    });

    it('should return hub providers when chainId matches hub domain', () => {
      const configWithHubProviders: MockContractConfig = {
        ...mockConfig,
        hub: {
          domain: 'hub_domain',
          providers: ['https://hub.provider1.com', 'https://hub.provider2.com'],
        },
      };
      const urls = contractModule.getProviderUrls('hub_domain', configWithHubProviders as MarkConfiguration);
      expect(urls).toEqual(['https://hub.provider1.com', 'https://hub.provider2.com']);
    });

    it('should return empty array for an invalid chainId', () => {
      const urls = contractModule.getProviderUrls('999', mockConfig as MarkConfiguration);
      expect(urls).toEqual([]);
    });
  });

  describe('createClient', () => {
    it('should create a public client with a valid chainId', () => {
      const client = contractModule.createClient('1', mockConfig as MarkConfiguration);
      expect(typeof client).toBe('object');
    });

    it('should return the same client instance on subsequent calls (caching)', () => {
      const client1 = contractModule.createClient('1', mockConfig as MarkConfiguration);
      const client2 = contractModule.createClient('1', mockConfig as MarkConfiguration);
      expect(client1).toBe(client2);
    });

    it('should throw an error for an invalid chainId', () => {
      expect(() => contractModule.createClient('999', mockConfig as MarkConfiguration)).toThrow(
        'No RPC configured for given domain: 999',
      );
    });
  });

  describe('getHubStorageContract', () => {
    it('should return a contract instance for the hub chain', async () => {
      const mockClient: MockClient = {};
      const clientStub = sinon
        .stub(contractModule, 'createClient')
        .returns(mockClient as unknown as ReturnType<typeof contractModule.createClient>);

      const contract = contractModule.getHubStorageContract(mockConfig as MarkConfiguration);

      expect(clientStub.calledOnce).toBe(true);
      expect(clientStub.firstCall.args[0]).toBe('hub_domain');
      expect(clientStub.firstCall.args[1]).toEqual(mockConfig);

      expect(typeof contract).toBe('object');
      expect(contract.address).toBe(HUB_TESTNET_ADDR);
    });

    it('should return a contract instance for the hub mainnet chain', async () => {
      const mockClient: MockClient = {};
      const clientStub = sinon
        .stub(contractModule, 'createClient')
        .returns(mockClient as unknown as ReturnType<typeof contractModule.createClient>);

      const mainnetConfig: MockContractConfig = { ...mockConfig, environment: 'mainnet' };
      const contract = contractModule.getHubStorageContract(mainnetConfig as MarkConfiguration);

      expect(clientStub.calledOnce).toBe(true);
      expect(clientStub.firstCall.args[0]).toBe('hub_domain');
      expect(clientStub.firstCall.args[1]).toEqual(mainnetConfig);

      expect(typeof contract).toBe('object');
      expect(contract.address).toBe(HUB_MAINNET_ADDR);
    });
  });

  describe('getERC20Contract', () => {
    it('should return a contract instance for a given chain and address', async () => {
      const mockClient: MockClient = {};
      const clientStub = sinon
        .stub(contractModule, 'createClient')
        .returns(mockClient as unknown as ReturnType<typeof contractModule.createClient>);

      const contract = await contractModule.getERC20Contract(mockConfig as MarkConfiguration, '1', '0x121344');

      expect(clientStub.calledOnce).toBe(true);
      expect(typeof contract).toBe('object');
    });

    it('should throw an error if the chainId is invalid', async () => {
      try {
        await contractModule.getERC20Contract(mockConfig as MarkConfiguration, '999', '0x121344');
      } catch (error: unknown) {
        expect((error as Error).message).toBe('No RPC configured for given domain: 999');
      }
    });
  });
});
