import { expect } from 'chai';
import sinon from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { getMarkBalances } from '../../src/helpers/balance';
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
  });
});
