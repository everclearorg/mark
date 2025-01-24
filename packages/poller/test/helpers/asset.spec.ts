import { getTickers, getAssetHash } from '../../src/helpers/asset';
import { expect } from 'chai';
import sinon from 'sinon';
import * as coreFns from '@mark/core';
import * as viemFns from 'viem';

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
    console.log(result, 'results from test');
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
