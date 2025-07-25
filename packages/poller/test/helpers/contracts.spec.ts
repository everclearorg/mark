import { expect } from 'chai';
import sinon from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import * as ViemFns from 'viem';
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
  });

  describe('getMulticallAddress', () => {
    it('should return multicall address for valid chainId', () => {
      const address = contractModule.getMulticallAddress('1', mockConfig as MarkConfiguration);
      expect(address).to.equal('0xMulticallAddress');
    });

    it('should throw error for invalid chainId', () => {
      expect(() => contractModule.getMulticallAddress('999', mockConfig as MarkConfiguration)).to.throw(
        'Chain configuration not found for chain ID: 999',
      );
    });
  });

  describe('getProviderUrl', () => {
    it('should return the provider URL for a valid chainId', () => {
      const url = contractModule.getProviderUrl('1', mockConfig as MarkConfiguration);
      expect(url).to.equal('https://mainnet.infura.io/v3/test');
    });

    it('should return undefined for an invalid chainId', () => {
      const url = contractModule.getProviderUrl('999', mockConfig as MarkConfiguration);
      expect(url).to.be.undefined;
    });
  });

  describe('createClient', () => {
    it('should create a public client with a valid chainId', () => {
      const client = contractModule.createClient('1', mockConfig as MarkConfiguration);
      expect(client).to.be.an('object');
    });

    it('should return the same client instance on subsequent calls (caching)', () => {
      const client1 = contractModule.createClient('1', mockConfig as MarkConfiguration);
      const client2 = contractModule.createClient('1', mockConfig as MarkConfiguration);
      expect(client1).to.equal(client2);
    });

    it('should throw an error for an invalid chainId', () => {
      expect(() => contractModule.createClient('999', mockConfig as MarkConfiguration)).to.throw(
        'No RPC configured for given domain: 999',
      );
    });
  });

  describe('getHubStorageContract', () => {
    it('should return a contract instance for the hub chain', async () => {
      interface MockClient {}
      interface MockContract {
        address: string;
      }

      const mockClient: MockClient = {};
      const clientStub = sinon.stub(contractModule, 'createClient').returns(mockClient as any);

      const mockContract: MockContract = { address: HUB_TESTNET_ADDR };
      const contractStub = sinon.stub(ViemFns, 'getContract').returns(mockContract as any);

      const contract = await contractModule.getHubStorageContract(mockConfig as MarkConfiguration);

      expect(clientStub.calledOnce).to.be.true;
      expect(clientStub.firstCall.args[0]).to.equal('hub_domain');
      expect(clientStub.firstCall.args[1]).to.deep.equal(mockConfig);

      expect(contract).to.be.an('object');
      expect(contract.address).to.be.eq(HUB_TESTNET_ADDR);
    });

    it('should return a contract instance for the hub mainnet chain', async () => {
      interface MockClient {}
      interface MockContract {
        address: string;
      }

      const mockClient: MockClient = {};
      const clientStub = sinon.stub(contractModule, 'createClient').returns(mockClient as any);

      const mockContract: MockContract = { address: HUB_MAINNET_ADDR };
      const contractStub = sinon.stub(ViemFns, 'getContract').returns(mockContract as any);

      const mainnetConfig: MockContractConfig = { ...mockConfig, environment: 'mainnet' };
      const contract = await contractModule.getHubStorageContract(mainnetConfig as MarkConfiguration);

      expect(clientStub.calledOnce).to.be.true;
      expect(clientStub.firstCall.args[0]).to.equal('hub_domain');
      expect(clientStub.firstCall.args[1]).to.deep.equal(mainnetConfig);

      expect(contract).to.be.an('object');
      expect(contract.address).to.be.eq(HUB_MAINNET_ADDR);
    });
  });

  describe('getERC20Contract', () => {
    it('should return a contract instance for a given chain and address', async () => {
      interface MockClient {}
      interface MockContract {}

      const mockClient: MockClient = {};
      const clientStub = sinon.stub(contractModule, 'createClient').returns(mockClient as any);

      const mockContract: MockContract = {};
      const contractStub = sinon.stub(ViemFns, 'getContract').returns(mockContract as any);

      const contract = await contractModule.getERC20Contract(mockConfig as MarkConfiguration, '1', '0x121344');

      expect(clientStub.calledOnce).to.be.true;
      expect(contract).to.be.an('object');
    });

    it('should throw an error if the chainId is invalid', async () => {
      try {
        await contractModule.getERC20Contract(mockConfig as MarkConfiguration, '999', '0x121344');
      } catch (error: any) {
        expect(error.message).to.equal('No RPC configured for given domain: 999');
      }
    });
  });
});
