import { expect } from 'chai';
import sinon from 'sinon';
import { createPublicClient, getContract, http } from 'viem';
import * as contractModule from '../../src/helpers/contracts';
import * as ViemFns from 'viem';

describe('Contracts Module', () => {
  const mockConfig = {
    chains: {
      '1': { providers: ['https://mainnet.infura.io/v3/test'] },
      hub_chain_id: { providers: ['https://hub.infura.io/v3/test'] },
    },
  };

  afterEach(() => {
    sinon.restore();
  });

  describe('getProviderUrl', () => {
    it('should return the provider URL for a valid chainId', () => {
      const url = contractModule.getProviderUrl('1', mockConfig as any);
      expect(url).to.equal('https://mainnet.infura.io/v3/test');
    });

    it('should return undefined for an invalid chainId', () => {
      const url = contractModule.getProviderUrl('999', mockConfig as any);
      expect(url).to.be.undefined;
    });
  });

  describe('createClient', () => {
    it('should create a public client with a valid chainId', () => {
      const clientStub = sinon.stub(contractModule, 'createClient');
      contractModule.createClient('1', mockConfig as any);

      expect(clientStub.calledOnce).to.be.true;
      const args = clientStub.args[0][0];

      expect(args).to.equal('1');
    });

    it('should throw an error for an invalid chainId', () => {
      expect(() => contractModule.createClient('999', mockConfig as any)).to.throw(
        'No RPC configured for given domain: 999',
      );
    });
  });

  describe('getHubStorageContract', () => {
    it('should return a contract instance for the hub chain', async () => {
      const clientStub = sinon.stub(contractModule, 'createClient').returns({} as any);

      const contractStub = sinon.stub(ViemFns, 'getContract').returns({} as any);

      const contract = await contractModule.getHubStorageContract(mockConfig as any);

      expect(clientStub.calledOnce).to.be.true;
      expect(clientStub.firstCall.args[0]).to.equal('hub_chain_id');
      expect(clientStub.firstCall.args[1]).to.deep.equal(mockConfig);

      expect(contract).to.be.an('object');
    });
  });

  describe('getERC20Contract', () => {
    it('should return a contract instance for a given chain and address', async () => {
      const clientStub = sinon.stub(contractModule, 'createClient').returns({} as any);
      const contractStub = sinon.stub(ViemFns, 'getContract').returns({} as any);

      const contract = await contractModule.getERC20Contract(mockConfig as any, '1', '0x121344');

      expect(clientStub.calledOnce).to.be.true;
      expect(contract).to.be.an('object');
    });

    it('should throw an error if the chainId is invalid', async () => {
      try {
        await contractModule.getERC20Contract(mockConfig as any, '999', '0x121344');
        throw new Error('Expected getERC20Contract to throw an error, but it did not');
      } catch (error: any) {
        expect(error.message).to.equal('No RPC configured for given domain: 999');
      }
    });
  });
});
