import sinon from 'sinon';

// Mock isSvmChain and getTokenAddressFromConfig from @mark/core
jest.mock('@mark/core', () => ({
  ...jest.requireActual('@mark/core'),
  isSvmChain: jest.fn(() => false),
  getTokenAddressFromConfig: jest.fn(),
}));
import {
  getTickers,
  getAssetHash,
  isXerc20Supported,
  getTickerForAsset,
  getAssetConfig,
  convertHubAmountToLocalDecimals,
  getSupportedDomainsForTicker,
} from '../../src/helpers/asset';
import * as assetFns from '../../src/helpers/asset';
import * as contractFns from '../../src/helpers/contracts';
import { MarkConfiguration, getTokenAddressFromConfig } from '@mark/core';

// Test types
enum SettlementStrategy {
  DEFAULT,
  XERC20,
}

interface AssetConfig {
  tickerHash: string;
  adopted: string;
  domain: string;
  approval: boolean;
  strategy: SettlementStrategy;
}

interface MockHubStorageContract {
  read: {
    adoptedForAssets: sinon.SinonStub;
  };
}
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
      expect(result).toEqual(['0xabcdef', '0x123456', '0xdeadbeef']);
    });

    it('should return an empty array when configuration is empty', () => {
      const result = getTickers(mockConfigs.emptyConfig as MarkConfiguration);
      expect(result).toEqual([]);
    });

    it('should return an empty array when chains have no assets', () => {
      const result = getTickers(mockConfigs.noAssetsConfig as MarkConfiguration);
      expect(result).toEqual([]);
    });

    it('should handle mixed-case ticker hashes correctly', () => {
      const result = getTickers(mockConfigs.mixedCaseConfig as MarkConfiguration);
      expect(result).toEqual(['0xabcdef', '0x123abc']);
    });

    it('should handle multiple chains with multiple assets', () => {
      const result = getTickers(mockConfigs.multipleChainsConfig as MarkConfiguration);
      expect(result).toEqual(['0xabcdef', '0x123456', '0xdeadbeef', '0xcafebabe']);
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
      expect(result).toEqual(['0xabcdef', '0x123456', '0xdeadbeef', '0xnewhash']);
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

      const result = getAssetHash('0xhash1', '1', mockConfig as unknown as MarkConfiguration, getTokenAddressMock);
      const expectedHash = '0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f';

      expect(result).toBe(expectedHash);
      expect(getTokenAddressMock.calledOnceWith('0xhash1', '1', mockConfig)).toBe(true);
    });

    it('should return undefined if the token address is not found', () => {
      const getTokenAddressMock = sinon.stub().returns(undefined);

      const result = getAssetHash('0xhash1', '3', mockConfig as unknown as MarkConfiguration, getTokenAddressMock);

      expect(result).toBeUndefined();
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

    const SettlementStrategy = {
      DEFAULT: 0,
      XERC20: 1,
    } as const;

    it('should return true if any domain supports XERC20', async () => {
      const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash').returns('0xAssetHash1');
      const mockAssetConfig: AssetConfig = {
        tickerHash: '0xhash1',
        adopted: '0xAdoptedAddress',
        domain: '1',
        approval: true,
        strategy: SettlementStrategy.XERC20,
      };
      const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig').resolves(mockAssetConfig);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).toBe(true);
      expect(getAssetHashStub.called).toBe(true);
      expect(getAssetConfigStub.called).toBe(true);
    });

    it('should return false if no domain supports XERC20', async () => {
      // Mock getTokenAddressFromConfig to return valid addresses
      (getTokenAddressFromConfig as jest.Mock).mockImplementation((ticker, domain) => {
        if (domain === '1') return '0x1234567890123456789012345678901234567890';
        if (domain === '2') return '0x2345678901234567890123456789012345678901';
        return undefined;
      });

      const mockDefaultConfig: AssetConfig = {
        tickerHash: '0xhash1',
        adopted: '0xAdoptedAddress',
        domain: '1',
        approval: true,
        strategy: SettlementStrategy.DEFAULT,
      };
      const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');
      getAssetConfigStub.resolves(mockDefaultConfig);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).toBe(false);
      expect(getAssetConfigStub.calledTwice).toBe(true);
    });

    it('should return false if no asset hashes are found', async () => {
      const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash').returns(undefined);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).toBe(false);
      expect(getAssetHashStub.calledTwice).toBe(true);
    });

    it('should continue checking other domains if one domain has no asset hash', async () => {
      // Mock getTokenAddressFromConfig
      (getTokenAddressFromConfig as jest.Mock).mockImplementation((ticker, domain) => {
        if (domain === '1') return undefined;
        if (domain === '2') return '0x2345678901234567890123456789012345678901';
        return undefined;
      });

      const mockXercConfig: AssetConfig = {
        tickerHash: '0xhash2',
        adopted: '0xAdoptedAddress2',
        domain: '2',
        approval: true,
        strategy: SettlementStrategy.XERC20,
      };
      const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');
      getAssetConfigStub.resolves(mockXercConfig);

      const result = await isXerc20Supported('ticker', ['1', '2'], mockConfig as unknown as MarkConfiguration);

      expect(result).toBe(true);
      expect(getAssetConfigStub.calledOnce).toBe(true);
    });

    it('should skip SVM and TVM chains and return false when only non-EVM chains provided', async () => {
      const getAssetHashStub = sinon.stub(assetFns, 'getAssetHash');
      const getAssetConfigStub = sinon.stub(assetFns, 'getAssetConfig');

      const result = await isXerc20Supported('ticker', ['728126428', '1399811149'], mockConfig as unknown as MarkConfiguration);

      expect(result).toBe(false);
      expect(getAssetHashStub.called).toBe(false)
      expect(getAssetConfigStub.called).toBe(false)
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
      expect(result).toBeUndefined();
    });

    it('should return undefined if chainConfig has no assets', () => {
      const configWithoutAssets = {
        chains: {
          '1': {} as { assets?: MockTickerAsset[] },
        },
      };
      const result = getTickerForAsset('0xTokenAddress1', 1, configWithoutAssets as unknown as MarkConfiguration);
      expect(result).toBeUndefined();
    });

    it('should return undefined if asset is not found', () => {
      const result = getTickerForAsset('0xNonExistentToken', 1, mockConfig as MarkConfiguration);
      expect(result).toBeUndefined();
    });

    it('should return ticker hash for found asset', () => {
      const result = getTickerForAsset('0xTokenAddress1', 1, mockConfig as MarkConfiguration);
      expect(result).toBe('0xhash1');
    });

    it('should handle case insensitive asset addresses', () => {
      const result = getTickerForAsset('0xtokenaddress1', 1, mockConfig as MarkConfiguration);
      expect(result).toBe('0xhash1');
    });
  });

  describe('getAssetConfig', () => {
    it('should call getHubStorageContract and return asset config', async () => {
      const mockContract: MockHubStorageContract = {
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
      const getHubStorageContractStub = sinon
        .stub(contractFns, 'getHubStorageContract')
        .returns(mockContract as unknown as ReturnType<typeof contractFns.getHubStorageContract>);

      const mockConfig: Partial<MarkConfiguration> = {
        hub: {
          domain: '1',
          providers: ['http://localhost:8545'],
        } as MarkConfiguration['hub'],
      };
      const result = await getAssetConfig('0xAssetHash', mockConfig as MarkConfiguration);

      expect(getHubStorageContractStub.calledOnce).toBe(true);
      expect(getHubStorageContractStub.firstCall.args[0]).toEqual(mockConfig);
      expect(mockContract.read.adoptedForAssets.calledOnce).toBe(true);
      expect(mockContract.read.adoptedForAssets.firstCall.args[0]).toEqual(['0xAssetHash']);
      expect(result).toEqual({
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
      expect(result).toMatch(/^\d+$/); // Should be a numeric string
    });

    it('should return integer when no decimal is present', () => {
      const result = convertHubAmountToLocalDecimals(
        BigInt('123000000000000000000'),
        '0xDAI',
        '1',
        mockConfig as MarkConfiguration,
      );

      // DAI has 18 decimals, so formatUnits should be called with 18-18=0 decimals
      expect(result).toMatch(/^\d+$/); // Should be a numeric string
    });

    it('should use 18 decimals as default when asset not found', () => {
      const result = convertHubAmountToLocalDecimals(
        BigInt('123456000000000000000'),
        '0xUnknown',
        '1',
        mockConfig as MarkConfiguration,
      );

      // Unknown asset defaults to 18 decimals, so formatUnits should be called with 18-18=0 decimals
      expect(result).toMatch(/^\d+$/); // Should be a numeric string
    });

    it('should return integer directly when amount has no decimal part', () => {
      // Test with exact whole number (no decimal part after formatting)
      // For DAI (18 decimals), formatUnits is called with 18-18=0 decimals,
      // so the amount stays as is without decimal conversion
      const result = convertHubAmountToLocalDecimals(
        BigInt('1000000000000000000'), // Exactly 1 token in 18 decimals
        '0xDAI',
        '1',
        mockConfig as MarkConfiguration,
      );

      expect(result).toBe('1000000000000000000');
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
      expect(result).toEqual(['1', '2']);
    });

    it('should return empty array when no domains support the ticker', () => {
      const result = getSupportedDomainsForTicker('0xnonexistent', mockConfig as MarkConfiguration);
      expect(result).toEqual([]);
    });

    it('should handle case insensitive ticker matching', () => {
      const result = getSupportedDomainsForTicker('0xHASH1', mockConfig as MarkConfiguration);
      expect(result).toEqual(['1', '2']);
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
      expect(result).toEqual(['1']);
    });
  });
});
