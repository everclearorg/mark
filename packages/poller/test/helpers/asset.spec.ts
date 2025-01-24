import { getTickers, getAssetHash, isXerc20Supported } from '../../src/helpers/asset';
import { expect } from 'chai';
import sinon from 'sinon';
import * as viemFns from 'viem';
import * as assetFns from '../../src/helpers/asset';

describe('getTickers', () => {
  it('should return ticker hashes in lowercase from the configuration', () => {
    const config = {
      chains: {
        chain1: {
          assets: [{ tickerHash: '0xABCDEF' }, { tickerHash: '0x123456' }],
        },
        chain2: {
          assets: [{ tickerHash: '0xDEADBEEF' }],
        },
      },
    };
    const result = getTickers(config as any);
    expect(result).to.deep.eq(['0xabcdef', '0x123456', '0xdeadbeef']);
  });

  it('should return an empty array when configuration is empty', () => {
    const config = { chains: {} };
    const result = getTickers(config as any);
    expect(result).to.deep.eq([]);
  });

  it('should return an empty array when chains have no assets', () => {
    const config = {
      chains: {
        chain1: { assets: [] },
        chain2: { assets: [] },
      },
    };
    const result = getTickers(config as any);
    expect(result).to.deep.eq([]);
  });

  it('should handle mixed case ticker hashes correctly', () => {
    const config = {
      chains: {
        chain1: {
          assets: [{ tickerHash: '0xAbCdEf' }, { tickerHash: '0x123ABC' }],
        },
      },
    };
    const result = getTickers(config as any);
    expect(result).to.deep.eq(['0xabcdef', '0x123abc']);
  });

  it('should handle multiple chains with multiple assets', () => {
    const config = {
      chains: {
        chain1: {
          assets: [{ tickerHash: '0xABCDEF' }, { tickerHash: '0x123456' }],
        },
        chain2: {
          assets: [{ tickerHash: '0xDEADBEEF' }, { tickerHash: '0xCAFEBABE' }],
        },
      },
    };
    const result = getTickers(config as any);
    expect(result).to.deep.eq(['0xabcdef', '0x123456', '0xdeadbeef', '0xcafebabe']);
  });
});

describe('getAssetHash', () => {
  const mockConfig: any = {
    chains: {
      '1': {
        tokens: {
          '0xhash1': {
            address: '0xTokenAddress1',
          },
        },
      },
      '2': {
        tokens: {
          '0xhash2': {
            address: '0xTokenAddress2',
          },
        },
      },
    },
  };

  afterEach(() => {
    sinon.restore();
  });

  it('should return the correct asset hash for a valid token and domain', () => {
    const getTokenAddressMock = sinon.stub().returns('0x0000000000000000000000000000000000000001');
    const encodeAbiStub = sinon.stub(viemFns, 'encodeAbiParameters').returns('0xEncodedParameters');

    const result = getAssetHash('0xhash1', '1', mockConfig, getTokenAddressMock);
    const expectedHash = '0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f'; // hashing `keccak(calldata)`

    expect(result).to.equal(expectedHash);
    expect(getTokenAddressMock.calledOnceWith('0xhash1', '1', mockConfig)).to.be.true;
  });

  it('should return undefined if the token address is not found', () => {
    const getTokenAddressMock = sinon.stub().returns(undefined);

    const result = getAssetHash('0xhash1', '3', mockConfig, getTokenAddressMock);

    expect(result).to.be.undefined;
  });
});

describe('isXerc20Supported', () => {
  const mockConfig: any = {
    chains: {
      '1': {
        tokens: {
          '0xhash1': {
            address: '0xTokenAddress1',
          },
        },
      },
      '2': {
        tokens: {
          '0xhash2': {
            address: '0xTokenAddress2',
          },
        },
      },
    },
    hub: {
      domain: 'hub_domain',
      providers: ['https://mainnet.infura.io/v3/test'],
    },
  };

  enum SettlementStrategy {
    DEFAULT,
    XERC20,
  }
  afterEach(() => {
    sinon.restore();
  });

  it('should return true if any domain supports XERC20', async () => {
    const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash').returns(viemFns.pad('0xAssetHash1'));
    const getAssetConfig = sinon
      .stub(assetFns, 'getAssetConfig')
      .resolves({ strategy: SettlementStrategy.XERC20 } as any);
    const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig);

    expect(result).to.be.true;
    expect(getAssetHashStub.called).to.be.true;
  });

  it('should return false if no domain supports XERC20', async () => {
    const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash');
    getAssetHashStub.withArgs('ticker', '1', mockConfig, sinon.match.any).returns('0xAssetHash1');
    getAssetHashStub.withArgs('ticker', '2', mockConfig, sinon.match.any).returns('0xAssetHash2');

    const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');
    getAssetConfigStub.withArgs('0xAssetHash1', mockConfig).resolves({ strategy: SettlementStrategy.DEFAULT } as any);
    getAssetConfigStub.withArgs('0xAssetHash2', mockConfig).resolves({ strategy: SettlementStrategy.DEFAULT } as any);

    const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig);

    expect(result).to.be.false;
    expect(getAssetHashStub.calledTwice).to.be.true;
    expect(getAssetConfigStub.calledTwice).to.be.true;
  });

  it('should return false if no asset hashes are found', async () => {
    const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash');
    getAssetHashStub.withArgs('ticker', '1', mockConfig, sinon.match.any).returns(undefined);
    getAssetHashStub.withArgs('ticker', '2', mockConfig, sinon.match.any).returns(undefined);

    const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');

    const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig);

    expect(result).to.be.false;
    expect(getAssetHashStub.calledTwice).to.be.true;
    expect(getAssetConfigStub.notCalled).to.be.true;
  });

  it('should continue checking other domains if one domain has no asset hash', async () => {
    const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash');
    getAssetHashStub.withArgs('ticker', '1', mockConfig, sinon.match.any).returns(undefined);
    getAssetHashStub.withArgs('ticker', '2', mockConfig, sinon.match.any).returns('0xAssetHash2');

    const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');
    getAssetConfigStub.withArgs('0xAssetHash2', mockConfig).resolves({ strategy: SettlementStrategy.XERC20 } as any);

    const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig);

    expect(result).to.be.true;
    expect(getAssetHashStub.calledTwice).to.be.true;
    expect(getAssetConfigStub.calledOnceWith('0xAssetHash2', mockConfig)).to.be.true;
  });
});
