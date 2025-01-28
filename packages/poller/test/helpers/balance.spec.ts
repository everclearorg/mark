import { expect } from 'chai';
import sinon from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { walletBalance, getMarkBalances, getCustodiedBalances } from '../../src/helpers/balance';
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

  describe('walletBalance', () => {
    it('should return the wallet balance successfully', async () => {
      const tokenContractStub = {
        read: {
          balanceOf: sinon.stub().resolves('1000'),
        },
      };
      sinon.stub(contractModule, 'getERC20Contract').resolves(tokenContractStub as any);

      const balance = await walletBalance('0xTokenAddress', '1', mockConfig as any);

      expect(balance).to.equal('1000');
    });

    it('should log an error and return undefined on failure', async () => {
      const consoleStub = sinon.stub(console, 'log');
      sinon.stub(contractModule, 'getERC20Contract').rejects(new Error('Contract error'));

      const balance = await walletBalance('0xTokenAddress', '1', mockConfig as any);

      expect(balance).to.be.undefined;
      expect(consoleStub.calledOnceWith('Not able to fetch the wallet balance!')).to.be.true;
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
  });
});

describe('getCustodiedBalances', () => {
  const mockConfig: any = {
    chains: {
      '1': { name: 'Chain1' },
      '2': { name: 'Chain2' },
    },
    hub: {
      domain: 'hub_domain',
    },
  };

  const mockTickers = ['0xabc', '0xdef'];

  const mockHubStorageContract = {
    read: {
      custodiedAssets: sinon.stub(),
    },
  };
  afterEach(() => {
    sinon.restore(); // Clean up stubs after each test
  });

  it('should return a map of custodied balances for all tickers and domains', async () => {
    // Stub `getTickers` to return mock tickers
    const getTickersStub = sinon.stub(assetModule, 'getTickers').returns(mockTickers);

    // Stub `getHubStorageContract` to return a mock contract
    const mockHubStorageContract = {
      read: {
        custodiedAssets: sinon.stub(),
      },
    };

    const getHubStorageContractStub = sinon
      .stub(contractModule, 'getHubStorageContract')
      .returns(mockHubStorageContract as any);

    // Stub `getAssetHash` to return a valid asset hash for each ticker and domain
    const getAssetHashStub = sinon.stub(assetModule, 'getAssetHash');
    getAssetHashStub.withArgs('0xabc', '1', mockConfig, sinon.match.any).returns('0xAssetHash1');
    getAssetHashStub.withArgs('0xabc', '2', mockConfig, sinon.match.any).returns('0xAssetHash2');
    getAssetHashStub.withArgs('0xdef', '1', mockConfig, sinon.match.any).returns('0xAssetHash3');
    getAssetHashStub.withArgs('0xdef', '2', mockConfig, sinon.match.any).returns('0xAssetHash4');

    // Stub `custodiedAssets` to return balances
    mockHubStorageContract.read.custodiedAssets.withArgs(['0xAssetHash1']).resolves(100n);
    mockHubStorageContract.read.custodiedAssets.withArgs(['0xAssetHash2']).resolves(200n);
    mockHubStorageContract.read.custodiedAssets.withArgs(['0xAssetHash3']).resolves(300n);
    mockHubStorageContract.read.custodiedAssets.withArgs(['0xAssetHash4']).resolves(400n);

    const result = await getCustodiedBalances(mockConfig);

    // Assertions
    expect(result).to.be.an.instanceOf(Map);
    expect(result.size).to.equal(2); // Two tickers
    expect(result.get('0xabc')).to.deep.equal(
      new Map([
        ['1', 100n],
        ['2', 200n],
      ]),
    );
    expect(result.get('0xdef')).to.deep.equal(
      new Map([
        ['1', 300n],
        ['2', 400n],
      ]),
    );
    expect(getTickersStub.calledOnceWith(mockConfig)).to.be.true;
    expect(getHubStorageContractStub.calledOnceWith(mockConfig)).to.be.true;
    expect(getAssetHashStub.callCount).to.equal(4);
  });

  it('should handle cases where an asset is not registered on a domain', async () => {
    const getTickersStub = sinon.stub(assetModule, 'getTickers').returns(mockTickers);

    const getHubStorageContractStub = sinon
      .stub(contractModule, 'getHubStorageContract')
      .returns(mockHubStorageContract as any);

    const getAssetHashStub = sinon.stub(assetModule, 'getAssetHash');
    getAssetHashStub.withArgs('0xabc', '1', mockConfig, sinon.match.any).returns(undefined);
    getAssetHashStub.withArgs('0xabc', '2', mockConfig, sinon.match.any).returns('0xAssetHash2');
    getAssetHashStub.withArgs('0xdef', '1', mockConfig, sinon.match.any).returns('0xAssetHash3');
    getAssetHashStub.withArgs('0xdef', '2', mockConfig, sinon.match.any).returns(undefined);

    mockHubStorageContract.read.custodiedAssets.withArgs(['0xAssetHash2']).resolves(200n);
    mockHubStorageContract.read.custodiedAssets.withArgs(['0xAssetHash3']).resolves(300n);

    const result = await getCustodiedBalances(mockConfig);

    // Assertions
    expect(result).to.be.an.instanceOf(Map);
    expect(result.size).to.equal(2); // Two tickers
    expect(result.get('0xabc')).to.deep.equal(
      new Map([
        ['1', 0n], // Not registered
        ['2', 200n],
      ]),
    );
    expect(result.get('0xdef')).to.deep.equal(
      new Map([
        ['1', 300n],
        ['2', 0n], // Not registered
      ]),
    );
    expect(getTickersStub.calledOnceWith(mockConfig)).to.be.true;
    expect(getHubStorageContractStub.calledOnceWith(mockConfig)).to.be.true;
    expect(getAssetHashStub.callCount).to.equal(4);
  });

  it('should return an empty map if no tickers are found', async () => {
    const getTickersStub = sinon.stub(assetModule, 'getTickers').returns([]);

    const mockHubStorageContract = {
      read: {
        custodiedAssets: sinon.stub(),
      },
    };
    sinon.stub(contractModule, 'getHubStorageContract').returns(mockHubStorageContract as any);

    const mockConfig: any = {
      chains: {}, // No chains
      hub: {
        domain: 'hub_domain',
      },
    };

    const result = await getCustodiedBalances(mockConfig);

    expect(result).to.be.an.instanceOf(Map);
    expect(result.size).to.equal(0);
    expect(getTickersStub.calledOnceWith(mockConfig)).to.be.true;
  });
});
