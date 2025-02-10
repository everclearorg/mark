import { expect } from 'chai';
import sinon from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { getMarkBalances, getMarkGasBalances, getCustodiedBalances } from '../../src/helpers/balance';
import * as assetModule from '../../src/helpers/asset';
import { MarkConfiguration } from '@mark/core';

describe('Wallet Balance Utilities', () => {
  const mockAssetConfig = {
    symbol: 'TEST',
    address: '0xtest',
    decimals: 18,
    tickerHash: '0xtestticker',
    isNative: false,
  };
  const mockConfig = {
    ownAddress: '0xOwnAddress',
    chains: {
      '1': {
        providers: ['https://mainnet.infura.io/v3/test'],
        assets: [mockAssetConfig],
      },
      '2': { providers: ['https://other.infura.io/v3/test'], assets: [mockAssetConfig] },
    },
  } as unknown as MarkConfiguration;

  afterEach(() => {
    sinon.restore();
  });

  describe('getMarkGasBalances', () => {
    beforeEach(() => {
      sinon.stub(contractModule, 'createClient').returns({
        getBalance: sinon.stub().resolves(BigInt('1000000000000000000')), // 1 ETH
      } as any);
    });

    it('should return gas balances for all chains', async () => {
      const balances = await getMarkGasBalances(mockConfig);

      expect(balances.size).to.equal(Object.keys(mockConfig.chains).length);
      for (const chain of Object.keys(mockConfig.chains)) {
        expect(balances.get(chain)?.toString()).to.equal('1000000000000000000');
      }
    });

    it('should handle chain client errors by returning zero balance', async () => {
      (contractModule.createClient as any).restore();
      const createClientStub = sinon.stub(contractModule, 'createClient');
      // First chain succeeds, second fails
      createClientStub.withArgs('1', mockConfig).returns({
        getBalance: sinon.stub().resolves(BigInt('1000000000000000000')),
      } as any);
      createClientStub.withArgs('2', mockConfig).returns({
        getBalance: sinon.stub().rejects(new Error('RPC error')),
      } as any);

      const balances = await getMarkGasBalances(mockConfig);
      expect(balances.get('1')?.toString()).to.equal('1000000000000000000');
      expect(balances.get('2')?.toString()).to.equal('0'); // Should return 0 for failed chain
    });
  });

  describe('getMarkBalances', () => {
    const mockTickers = ['0xtestticker'];
    const mockBalance = '1000';

    beforeEach(() => {
      sinon.stub(contractModule, 'getERC20Contract').resolves({
        read: {
          balanceOf: sinon.stub().resolves(mockBalance),
        },
      } as any);

      sinon.stub(assetModule, 'getTickers').returns(mockTickers);
    });

    it('should return balances for all tickers and chains', async () => {
      const balances = await getMarkBalances(mockConfig);

      expect(balances.size).to.equal(mockTickers.length);
      for (const ticker of mockTickers) {
        const domainBalances = balances.get(ticker);
        expect(domainBalances).to.not.be.undefined;
        expect(domainBalances?.size).to.equal(Object.keys(mockConfig.chains).length);
        for (const domain of Object.keys(mockConfig.chains)) {
          expect(domainBalances?.get(domain)?.toString()).to.equal(mockBalance);
        }
      }
    });

    it('should normalize balance for non-18 decimal assets', async () => {
      // Restore previous stubs since we need new ones
      sinon.restore();

      // Create a 6 decimal asset config
      const sixDecimalAsset = {
        ...mockAssetConfig,
        decimals: 6,
        tickerHash: '0xsixdecimal',
        symbol: 'SIXDEC',
      };

      const configWithSixDecimals = {
        ownAddress: '0xOwnAddress',
        chains: {
          '1': {
            providers: ['https://mainnet.infura.io/v3/test'],
            assets: [sixDecimalAsset],
          },
        },
      } as unknown as MarkConfiguration;

      const inputBalance = '1000000'; // 1 token with 6 decimals
      const expectedBalance = BigInt(inputBalance) * BigInt(10 ** 12); // Convert to 18 decimals

      // Mock getTickers to return our 6 decimal asset
      sinon.stub(assetModule, 'getTickers').returns([sixDecimalAsset.tickerHash]);

      // Mock the contract call
      sinon.stub(contractModule, 'getERC20Contract').resolves({
        read: {
          balanceOf: sinon.stub().resolves(inputBalance),
        },
      } as any);

      const balances = await getMarkBalances(configWithSixDecimals);
      const assetBalances = balances.get(sixDecimalAsset.tickerHash);

      expect(assetBalances?.get('1')?.toString()).to.equal(expectedBalance.toString());
    });

    it('should skip assets with missing token address', async () => {
      const configWithoutAddress = {
        ...mockConfig,
        chains: {
          '1': {
            providers: ['https://mainnet.infura.io/v3/test'],
            assets: [
              {
                ...mockAssetConfig,
                address: undefined,
              },
            ],
          },
        },
      } as unknown as MarkConfiguration;

      const balances = await getMarkBalances(configWithoutAddress);
      expect(balances.get(mockAssetConfig.tickerHash)?.get('1')).to.be.undefined;
    });

    it('should handle contract errors gracefully', async () => {
      (contractModule.getERC20Contract as any).restore();
      sinon.stub(contractModule, 'getERC20Contract').rejects(new Error('Contract error'));

      const balances = await getMarkBalances(mockConfig);
      const domainBalances = balances.get(mockAssetConfig.tickerHash);
      expect(domainBalances?.get('1')?.toString()).to.equal('0'); // Should return 0 for failed contract
    });
  });

  describe('getCustodiedBalances', () => {
    const mockTickers = ['0xtestticker'];
    const mockCustodiedAmount = BigInt('1000000000000000000'); // 1 token

    beforeEach(() => {
      sinon.stub(assetModule, 'getTickers').returns(mockTickers);
      sinon.stub(assetModule, 'getAssetHash').returns('0xassethash');
      sinon.stub(contractModule, 'getHubStorageContract').returns({
        read: {
          custodiedAssets: sinon.stub().resolves(mockCustodiedAmount),
        },
      } as any);
    });

    it('should return custodied balances for all tickers and chains', async () => {
      const balances = await getCustodiedBalances(mockConfig);

      expect(balances.size).to.equal(mockTickers.length);
      for (const ticker of mockTickers) {
        const domainBalances = balances.get(ticker);
        expect(domainBalances).to.not.be.undefined;
        expect(domainBalances?.size).to.equal(Object.keys(mockConfig.chains).length);
        for (const domain of Object.keys(mockConfig.chains)) {
          expect(domainBalances?.get(domain)?.toString()).to.equal(mockCustodiedAmount.toString());
        }
      }
    });

    it('should handle missing asset hash', async () => {
      (assetModule.getAssetHash as any).restore();
      sinon.stub(assetModule, 'getAssetHash').returns(undefined);

      const balances = await getCustodiedBalances(mockConfig);
      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('1')).to.equal(0n);
    });

    it('should handle empty tickers list', async () => {
      (assetModule.getTickers as any).restore();
      sinon.stub(assetModule, 'getTickers').returns([]);

      const balances = await getCustodiedBalances(mockConfig);
      expect(balances.size).to.equal(0);
    });

    it('should handle contract errors gracefully', async () => {
      (contractModule.getHubStorageContract as any).restore();
      sinon.stub(contractModule, 'getHubStorageContract').returns({
        read: {
          custodiedAssets: sinon.stub().rejects(new Error('Contract error')),
        },
      } as any);

      const balances = await getCustodiedBalances(mockConfig);
      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('1')?.toString()).to.equal('0'); // Should return 0 for failed contract
    });
  });
});
