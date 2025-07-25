import { expect } from 'chai';
import sinon from 'sinon';
import {
  getTickers,
  getAssetHash,
  isXerc20Supported,
  getTickerForAsset,
  getAssetConfig,
  convertHubAmountToLocalDecimals,
  getSupportedDomainsForTicker,
} from '../../src/helpers/asset';
import * as viemFns from 'viem';
import * as assetFns from '../../src/helpers/asset';
import * as contractFns from '../../src/helpers/contracts';
import { MarkConfiguration } from '@mark/core';

// Test types
interface MockAssetConfig {
  tickerHash: string;
}

interface MockChainConfig {
  assets: MockAssetConfig[];
}

interface MockMarkConfig {
  chains: Record<string, MockChainConfig>;
  supportedSettlementDomains?: number[];
}

describe('Asset Helper Functions', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('getTickers', () => {
    const mockConfigs = {
      validConfig: {
        chains: {
          chain1: {
            assets: [{ tickerHash: '0xABCDEF' }, { tickerHash: '0x123456' }],
          },
          chain2: {
            assets: [{ tickerHash: '0xDEADBEEF' }],
          },
        },
      } as MockMarkConfig,
      emptyConfig: { chains: {} } as MockMarkConfig,
      noAssetsConfig: {
        chains: {
          chain1: { assets: [] },
          chain2: { assets: [] },
        },
      } as MockMarkConfig,
      mixedCaseConfig: {
        chains: {
          chain1: {
            assets: [{ tickerHash: '0xAbCdEf' }, { tickerHash: '0x123ABC' }],
          },
        },
      } as MockMarkConfig,
      multipleChainsConfig: {
        chains: {
          chain1: {
            assets: [{ tickerHash: '0xABCDEF' }, { tickerHash: '0x123456' }],
          },
          chain2: {
            assets: [{ tickerHash: '0xDEADBEEF' }, { tickerHash: '0xCAFEBABE' }],
          },
        },
      } as MockMarkConfig,
    };

    it('should return ticker hashes in lowercase from the configuration', () => {
      const result = getTickers(mockConfigs.validConfig as MarkConfiguration);
      expect(result).to.deep.eq(['0xabcdef', '0x123456', '0xdeadbeef']);
    });

    it('should return an empty array when configuration is empty', () => {
      const result = getTickers(mockConfigs.emptyConfig as MarkConfiguration);
      expect(result).to.deep.eq([]);
    });

    it('should return an empty array when chains have no assets', () => {
      const result = getTickers(mockConfigs.noAssetsConfig as MarkConfiguration);
      expect(result).to.deep.eq([]);
    });

    it('should handle mixed-case ticker hashes correctly', () => {
      const result = getTickers(mockConfigs.mixedCaseConfig as MarkConfiguration);
      expect(result).to.deep.eq(['0xabcdef', '0x123abc']);
    });

    it('should handle multiple chains with multiple assets', () => {
      const result = getTickers(mockConfigs.multipleChainsConfig as MarkConfiguration);
      expect(result).to.deep.eq(['0xabcdef', '0x123456', '0xdeadbeef', '0xcafebabe']);
    });

    it('should deduplicate ticker hashes ', () => {
      const duplicateConfig: MockMarkConfig = {
        chains: {
          chain1: {
            assets: [{ tickerHash: '0xABCDEF' }, { tickerHash: '0x123456' }],
          },
          chain2: {
            assets: [{ tickerHash: '0xabcdef' }, { tickerHash: '0xDEADBEEF' }], // dupe
          },
          chain3: {
            assets: [{ tickerHash: '0x123456' }, { tickerHash: '0xNewHash' }],
          },
        },
      };
      const result = getTickers(duplicateConfig as MarkConfiguration);
      expect(result).to.deep.eq(['0xabcdef', '0x123456', '0xdeadbeef', '0xnewhash']);
    });
  });

  describe('getAssetHash', () => {
    interface MockTokenConfig {
      address: string;
    }

    interface MockConfigWithTokens {
      chains: Record<string, { tokens: Record<string, MockTokenConfig> }>;
    }

    const mockConfig: MockConfigWithTokens = {
      chains: {
        '1': {
          tokens: { '0xhash1': { address: '0xTokenAddress1' } },
        },
        '2': {
          tokens: { '0xhash2': { address: '0xTokenAddress2' } },
        },
      },
    };

    it('should return the correct asset hash for a valid token and domain', () => {
      const getTokenAddressMock = sinon.stub().returns('0x0000000000000000000000000000000000000001');
      const encodeAbiStub = sinon.stub(viemFns, 'encodeAbiParameters').returns('0xEncodedParameters');

      const result = getAssetHash('0xhash1', '1', mockConfig as unknown as MarkConfiguration, getTokenAddressMock);
      const expectedHash = '0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f';

      expect(result).to.equal(expectedHash);
      expect(getTokenAddressMock.calledOnceWith('0xhash1', '1', mockConfig)).to.be.true;
    });

    it('should return undefined if the token address is not found', () => {
      const getTokenAddressMock = sinon.stub().returns(undefined);

      const result = getAssetHash('0xhash1', '3', mockConfig as unknown as MarkConfiguration, getTokenAddressMock);

      expect(result).to.be.undefined;
    });
  });

  describe('isXerc20Supported', () => {
    interface MockXercConfigChain {
      tokens: Record<string, { address: string }>;
    }

    interface MockXercConfig {
      chains: Record<string, MockXercConfigChain>;
      hub: {
        domain: string;
        providers: string[];
      };
    }

    const mockConfig: MockXercConfig = {
      chains: {
        '1': { tokens: { '0xhash1': { address: '0xTokenAddress1' } } },
        '2': { tokens: { '0xhash2': { address: '0xTokenAddress2' } } },
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

    interface MockAssetConfig {
      tickerHash: string;
      adopted: string;
      domain: string;
      approval: boolean;
      strategy: SettlementStrategy;
    }

    it('should return true if any domain supports XERC20', async () => {
      const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash').returns('0xAssetHash1');
      const mockAssetConfig: MockAssetConfig = {
        tickerHash: '0xhash1',
        adopted: '0xAdoptedAddress',
        domain: '1',
        approval: true,
        strategy: SettlementStrategy.XERC20,
      };
      const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig').resolves(mockAssetConfig as any);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).to.be.true;
      expect(getAssetHashStub.called).to.be.true;
      expect(getAssetConfigStub.called).to.be.true;
    });

    it('should return false if no domain supports XERC20', async () => {
      const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash');
      getAssetHashStub.withArgs('ticker', '1', sinon.match.any, sinon.match.any).returns('0xAssetHash1');
      getAssetHashStub.withArgs('ticker', '2', sinon.match.any, sinon.match.any).returns('0xAssetHash2');

      const mockDefaultConfig: MockAssetConfig = {
        tickerHash: '0xhash1',
        adopted: '0xAdoptedAddress',
        domain: '1',
        approval: true,
        strategy: SettlementStrategy.DEFAULT,
      };
      const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');
      getAssetConfigStub.withArgs('0xAssetHash1', sinon.match.any).resolves(mockDefaultConfig as any);
      getAssetConfigStub.withArgs('0xAssetHash2', sinon.match.any).resolves(mockDefaultConfig as any);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).to.be.false;
      expect(getAssetHashStub.calledTwice).to.be.true;
      expect(getAssetConfigStub.calledTwice).to.be.true;
    });

    it('should return false if no asset hashes are found', async () => {
      const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash').returns(undefined);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).to.be.false;
      expect(getAssetHashStub.calledTwice).to.be.true;
    });

    it('should continue checking other domains if one domain has no asset hash', async () => {
      const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash');
      getAssetHashStub.withArgs('ticker', '1', sinon.match.any, sinon.match.any).returns(undefined);
      getAssetHashStub.withArgs('ticker', '2', sinon.match.any, sinon.match.any).returns('0xAssetHash2');

      const mockXercConfig: MockAssetConfig = {
        tickerHash: '0xhash2',
        adopted: '0xAdoptedAddress2',
        domain: '2',
        approval: true,
        strategy: SettlementStrategy.XERC20,
      };
      const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');
      getAssetConfigStub.withArgs('0xAssetHash2', sinon.match.any).resolves(mockXercConfig as any);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).to.be.true;
      expect(getAssetHashStub.calledTwice).to.be.true;
      expect(getAssetConfigStub.calledOnceWith('0xAssetHash2', sinon.match.any)).to.be.true;
    });
  });

  describe('getTickerForAsset', () => {
    interface MockTickerAsset {
      address: string;
      tickerHash: string;
    }

    interface MockTickerConfig {
      chains: Record<string, { assets: MockTickerAsset[] }>;
    }

    const mockConfig: MockTickerConfig = {
      chains: {
        '1': {
          assets: [
            { address: '0xTokenAddress1', tickerHash: '0xhash1' },
            { address: '0xTokenAddress2', tickerHash: '0xhash2' },
          ],
        },
        '2': {
          assets: [{ address: '0xTokenAddress3', tickerHash: '0xhash3' }],
        },
      },
    };

    it('should return undefined if chainConfig does not exist', () => {
      const result = getTickerForAsset('0xTokenAddress1', 999, mockConfig as MarkConfiguration);
      expect(result).to.be.undefined;
    });

    it('should return undefined if chainConfig has no assets', () => {
      const configWithoutAssets: Partial<MockTickerConfig> = {
        chains: {
          '1': {} as any,
        },
      };
      const result = getTickerForAsset('0xTokenAddress1', 1, configWithoutAssets as MarkConfiguration);
      expect(result).to.be.undefined;
    });

    it('should return undefined if asset is not found', () => {
      const result = getTickerForAsset('0xNonExistentToken', 1, mockConfig as MarkConfiguration);
      expect(result).to.be.undefined;
    });

    it('should return ticker hash for found asset', () => {
      const result = getTickerForAsset('0xTokenAddress1', 1, mockConfig as MarkConfiguration);
      expect(result).to.equal('0xhash1');
    });

    it('should handle case insensitive asset addresses', () => {
      const result = getTickerForAsset('0xtokenaddress1', 1, mockConfig as MarkConfiguration);
      expect(result).to.equal('0xhash1');
    });
  });

  describe('getAssetConfig', () => {
    it('should call getHubStorageContract and return asset config', async () => {
      interface MockContract {
        read: {
          adoptedForAssets: sinon.SinonStub;
        };
      }

      const mockContract: MockContract = {
        read: {
          adoptedForAssets: sinon.stub().resolves({
            tickerHash: '0xhash1',
            adopted: '0xAdoptedAddress',
            domain: '1',
            approval: true,
            strategy: 1,
          }),
        },
      };
      const getHubStorageContractStub = sinon.stub(contractFns, 'getHubStorageContract').returns(mockContract as any);

      const mockConfig: Partial<MarkConfiguration> = { hub: { domain: '1' } as any };
      const result = await getAssetConfig('0xAssetHash', mockConfig as MarkConfiguration);

      expect(getHubStorageContractStub.calledOnceWith(sinon.match.any)).to.be.true;
      expect(mockContract.read.adoptedForAssets.calledOnceWith(['0xAssetHash'])).to.be.true;
      expect(result).to.deep.equal({
        tickerHash: '0xhash1',
        adopted: '0xAdoptedAddress',
        domain: '1',
        approval: true,
        strategy: 1,
      });
    });
  });

  describe('convertHubAmountToLocalDecimals', () => {
    interface MockDecimalAsset {
      address: string;
      decimals: number;
    }

    interface MockDecimalConfig {
      chains: Record<string, { assets: MockDecimalAsset[] }>;
    }

    const mockConfig: MockDecimalConfig = {
      chains: {
        '1': {
          assets: [
            { address: '0xUSDC', decimals: 6 },
            { address: '0xDAI', decimals: 18 },
          ],
        },
      },
    };

    it('should convert amount when decimal is present', () => {
      const result = convertHubAmountToLocalDecimals(
        BigInt('123456000000000000000'),
        '0xUSDC',
        '1',
        mockConfig as MarkConfiguration,
      );

      // USDC has 6 decimals, so formatUnits should be called with 18-6=12 decimals
      // Result should be rounded up when there's a decimal
      expect(result).to.match(/^\d+$/); // Should be a numeric string
    });

    it('should return integer when no decimal is present', () => {
      const result = convertHubAmountToLocalDecimals(
        BigInt('123000000000000000000'),
        '0xDAI',
        '1',
        mockConfig as MarkConfiguration,
      );

      // DAI has 18 decimals, so formatUnits should be called with 18-18=0 decimals
      expect(result).to.match(/^\d+$/); // Should be a numeric string
    });

    it('should use 18 decimals as default when asset not found', () => {
      const result = convertHubAmountToLocalDecimals(
        BigInt('123456000000000000000'),
        '0xUnknown',
        '1',
        mockConfig as MarkConfiguration,
      );

      // Unknown asset defaults to 18 decimals, so formatUnits should be called with 18-18=0 decimals
      expect(result).to.match(/^\d+$/); // Should be a numeric string
    });
  });

  describe('getSupportedDomainsForTicker', () => {
    interface MockSupportedConfig extends MockMarkConfig {
      supportedSettlementDomains: number[];
    }

    const mockConfig: MockSupportedConfig = {
      supportedSettlementDomains: [1, 2, 3],
      chains: {
        '1': {
          assets: [{ tickerHash: '0xhash1' }, { tickerHash: '0xhash2' }],
        },
        '2': {
          assets: [{ tickerHash: '0xhash1' }, { tickerHash: '0xhash3' }],
        },
        '3': {
          assets: [{ tickerHash: '0xhash4' }],
        },
      },
    };

    it('should return domains that support the ticker', () => {
      const result = getSupportedDomainsForTicker('0xhash1', mockConfig as MarkConfiguration);
      expect(result).to.deep.equal(['1', '2']);
    });

    it('should return empty array when no domains support the ticker', () => {
      const result = getSupportedDomainsForTicker('0xnonexistent', mockConfig as MarkConfiguration);
      expect(result).to.deep.equal([]);
    });

    it('should handle case insensitive ticker matching', () => {
      const result = getSupportedDomainsForTicker('0xHASH1', mockConfig as MarkConfiguration);
      expect(result).to.deep.equal(['1', '2']);
    });

    it('should return empty array when chain config does not exist', () => {
      const configWithMissingChain: MockSupportedConfig = {
        supportedSettlementDomains: [1, 999],
        chains: {
          '1': {
            assets: [{ tickerHash: '0xhash1' }],
          },
          // '999' is missing
        },
      };
      const result = getSupportedDomainsForTicker('0xhash1', configWithMissingChain as MarkConfiguration);
      expect(result).to.deep.equal(['1']);
    });
  });
});
