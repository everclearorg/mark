import { getTickers } from '../../src/helpers/asset';
import { expect } from 'chai';

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
