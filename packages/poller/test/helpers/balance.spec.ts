import { expect } from 'chai';
import { SinonStubbedInstance, stub, createStubInstance } from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { getMarkBalances, getMarkGasBalances, getCustodiedBalances } from '../../src/helpers/balance';
import * as assetModule from '../../src/helpers/asset';
import * as zodiacModule from '../../src/helpers/zodiac';
import { AssetConfiguration, MarkConfiguration, WalletType } from '@mark/core';
import { PrometheusAdapter } from '@mark/prometheus';

describe('Wallet Balance Utilities', () => {
  const mockAssetConfig: AssetConfiguration = {
    symbol: 'TEST',
    address: '0xtest',
    decimals: 18,
    tickerHash: '0xtestticker',
    isNative: false,
    balanceThreshold: '10000000000'
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

  const mockConfigWithZodiac = {
    ownAddress: '0xOwnAddress',
    chains: {
      '1': {
        providers: ['https://mainnet.infura.io/v3/test'],
        assets: [mockAssetConfig],
        zodiacRoleModuleAddress: '0xZodiacModule',
        zodiacRoleKey: '0x1234567890abcdef',
        gnosisSafeAddress: '0xGnosisSafe',
      },
      '2': {
        providers: ['https://other.infura.io/v3/test'],
        assets: [mockAssetConfig],
        // Chain 2 has no Zodiac config
      },
    },
  } as unknown as MarkConfiguration;

  let prometheus: SinonStubbedInstance<PrometheusAdapter>;

  beforeEach(() => {
    prometheus = createStubInstance(PrometheusAdapter);
  });

  describe('getMarkGasBalances', () => {
    it('should return gas balances for all chains', async () => {
      stub(contractModule, 'createClient').returns({
        getBalance: stub().resolves(BigInt('1000000000000000000')), // 1 ETH
      } as any);

      const balances = await getMarkGasBalances(mockConfig, prometheus);

      expect(balances.size).to.equal(Object.keys(mockConfig.chains).length);
      for (const chain of Object.keys(mockConfig.chains)) {
        expect(balances.get(chain)?.toString()).to.equal('1000000000000000000');
      }
    });

    it('should handle chain client errors by returning zero balance', async () => {
      // First chain succeeds, second fails
      stub(contractModule, 'createClient')
        .withArgs('1', mockConfig).returns({
          getBalance: stub().resolves(BigInt('1000000000000000000')),
        } as any)
        .withArgs('2', mockConfig).returns({
          getBalance: stub().rejects(new Error('RPC error')),
        } as any);

      const balances = await getMarkGasBalances(mockConfig, prometheus);
      expect(balances.get('1')?.toString()).to.equal('1000000000000000000');
      expect(balances.get('2')?.toString()).to.equal('0'); // Should return 0 for failed chain
    });
  });

  describe('getMarkBalances', () => {
    const mockTickers = ['0xtestticker'];
    const mockBalance = '1000';

    it('should return balances for all tickers and chains', async () => {
      stub(contractModule, 'getERC20Contract').resolves({
        read: {
          balanceOf: stub().resolves(mockBalance),
        },
      } as any);

      stub(assetModule, 'getTickers').returns(mockTickers);

      const balances = await getMarkBalances(mockConfig, prometheus);

      expect(balances.size).to.equal(mockTickers.length);
      for (const ticker of mockTickers) {
        const domainBalances = balances.get(ticker);
        expect(domainBalances).to.not.be.undefined;
        expect(domainBalances?.size).to.equal(Object.keys(mockConfig.chains).length);
        for (const domain of Object.keys(mockConfig.chains)) {
          expect(domainBalances?.get(domain)?.toString()).to.equal(mockBalance);
        }
      }
      // call count is per token per chain. right now only one asset on each chain
      expect(prometheus.updateChainBalance.callCount).to.be.eq(Object.keys(mockConfig.chains).length);
    });

    it('should use Gnosis Safe address when Zodiac is enabled', async () => {
      // Mock zodiac functions
      const mockZodiacConfigEnabled = { walletType: WalletType.Zodiac, safeAddress: '0xGnosisSafe' as `0x${string}` };
      const mockZodiacConfigDisabled = { walletType: WalletType.EOA };

      stub(zodiacModule, 'getValidatedZodiacConfig')
        .withArgs(mockConfigWithZodiac.chains['1']).returns(mockZodiacConfigEnabled)
        .withArgs(mockConfigWithZodiac.chains['2']).returns(mockZodiacConfigDisabled);

      stub(zodiacModule, 'getActualOwner')
        .withArgs(mockZodiacConfigEnabled, mockConfigWithZodiac.ownAddress).returns('0xGnosisSafe')
        .withArgs(mockZodiacConfigDisabled, mockConfigWithZodiac.ownAddress).returns(mockConfigWithZodiac.ownAddress);

      stub(assetModule, 'getTickers').returns(mockTickers);

      // Mock ERC20 contracts to track which addresses are used
      const mockBalanceOf1 = stub().resolves('5000');
      const mockBalanceOf2 = stub().resolves('6000');

      const mockContract1 = { read: { balanceOf: mockBalanceOf1 } };
      const mockContract2 = { read: { balanceOf: mockBalanceOf2 } };

      stub(contractModule, 'getERC20Contract')
        .withArgs(mockConfigWithZodiac, '1', '0xtest').resolves(mockContract1 as any)
        .withArgs(mockConfigWithZodiac, '2', '0xtest').resolves(mockContract2 as any);

      const balances = await getMarkBalances(mockConfigWithZodiac, prometheus);

      // Verify correct addresses were used for balance checks
      expect(mockBalanceOf1.calledWith(['0xGnosisSafe'])).to.be.true;
      expect(mockBalanceOf2.calledWith(['0xOwnAddress'])).to.be.true;

      const ticker1Balances = balances.get(mockTickers[0]);
      expect(ticker1Balances?.get('1')?.toString()).to.equal('5000');
      expect(ticker1Balances?.get('2')?.toString()).to.equal('6000');
    });

    it('should normalize balance for non-18 decimal assets', async () => {
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

      const inputBalance = BigInt('1000000'); // 1 token with 6 decimals
      const expectedBalance = inputBalance * BigInt(10 ** 12); // Convert to 18 decimals

      // Mock getTickers to return our 6 decimal asset
      stub(assetModule, 'getTickers').returns([sixDecimalAsset.tickerHash]);

      // Mock the contract call
      stub(contractModule, 'getERC20Contract').resolves({
        read: {
          balanceOf: stub().resolves(inputBalance),
        },
      } as any);

      const balances = await getMarkBalances(configWithSixDecimals, prometheus);
      const assetBalances = balances.get(sixDecimalAsset.tickerHash);

      expect(assetBalances?.get('1')?.toString()).to.equal(expectedBalance.toString());
      expect(prometheus.updateChainBalance.calledOnce).to.be.true;
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

      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(contractModule, 'getERC20Contract').resolves({
        read: {
          balanceOf: stub().resolves('1000'),
        },
      } as any);

      const balances = await getMarkBalances(configWithoutAddress, prometheus);
      expect(balances.get(mockAssetConfig.tickerHash)?.get('1')).to.be.undefined;
      expect(prometheus.updateChainBalance.calledOnce).to.be.false;
    });

    it('should handle contract errors gracefully', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(contractModule, 'getERC20Contract').rejects(new Error('Contract error'));

      const balances = await getMarkBalances(mockConfig, prometheus);
      const domainBalances = balances.get(mockAssetConfig.tickerHash);
      expect(domainBalances?.get('1')?.toString()).to.equal('0'); // Should return 0 for failed contract
    });
  });

  describe('getCustodiedBalances', () => {
    const mockTickers = ['0xtestticker'];
    const mockCustodiedAmount = BigInt('1000000000000000000'); // 1 token

    it('should return custodied balances for all tickers and chains', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(assetModule, 'getAssetHash').returns('0xassethash');
      stub(contractModule, 'getHubStorageContract').returns({
        read: {
          custodiedAssets: stub().resolves(mockCustodiedAmount),
        },
      } as any);

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
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(assetModule, 'getAssetHash').returns(undefined);
      stub(contractModule, 'getHubStorageContract').returns({
        read: {
          custodiedAssets: stub().resolves(mockCustodiedAmount),
        },
      } as any);

      const balances = await getCustodiedBalances(mockConfig);
      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('1')).to.equal(0n);
    });

    it('should handle empty tickers list', async () => {
      stub(assetModule, 'getTickers').returns([]);

      const balances = await getCustodiedBalances(mockConfig);
      expect(balances.size).to.equal(0);
    });

    it('should handle contract errors gracefully', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(assetModule, 'getAssetHash').returns('0xassethash');
      stub(contractModule, 'getHubStorageContract').returns({
        read: {
          custodiedAssets: stub().rejects(new Error('Contract error')),
        },
      } as any);

      const balances = await getCustodiedBalances(mockConfig);
      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('1')?.toString()).to.equal('0'); // Should return 0 for failed contract
    });
  });
});
