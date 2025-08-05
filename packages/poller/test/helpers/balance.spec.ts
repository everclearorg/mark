import { SinonStubbedInstance, stub, createStubInstance } from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { getMarkBalances, getMarkGasBalances, getCustodiedBalances } from '../../src/helpers/balance';
import * as assetModule from '../../src/helpers/asset';
import * as zodiacModule from '../../src/helpers/zodiac';
import { AssetConfiguration, MarkConfiguration, WalletType } from '@mark/core';
import { PrometheusAdapter } from '@mark/prometheus';
import { ChainService } from '@mark/chainservice';

// Mock interfaces for proper typing
interface MockClient {
  getBalance: sinon.SinonStub;
}

interface MockERC20Contract {
  read: {
    balanceOf: sinon.SinonStub;
  };
}

interface MockHubStorageContract {
  read: {
    custodiedAssets: sinon.SinonStub;
  };
}

describe('Wallet Balance Utilities', () => {
  const mockAssetConfig: AssetConfiguration = {
    symbol: 'TEST',
    address: '0xtest',
    decimals: 18,
    tickerHash: '0xtestticker',
    isNative: false,
    balanceThreshold: '10000000000',
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
  let mockChainService: SinonStubbedInstance<ChainService>;

  beforeEach(() => {
    prometheus = createStubInstance(PrometheusAdapter);
    mockChainService = createStubInstance(ChainService);
  });

  describe('getMarkGasBalances', () => {
    it('should return gas balances for all chains', async () => {
      const mockClient: MockClient = {
        getBalance: stub().resolves(BigInt('1000000000000000000')), // 1 ETH
      };
      stub(contractModule, 'createClient').returns(
        mockClient as unknown as ReturnType<typeof contractModule.createClient>,
      );

      const balances = await getMarkGasBalances(mockConfig, mockChainService as unknown as ChainService, prometheus);

      expect(balances.size).toBe(Object.keys(mockConfig.chains).length);
      for (const chain of Object.keys(mockConfig.chains)) {
        expect(balances.get(chain)?.toString()).toBe('1000000000000000000');
      }
    });

    it('should handle chain client errors by returning zero balance', async () => {
      // First chain succeeds, second fails
      const mockClient1: MockClient = {
        getBalance: stub().resolves(BigInt('1000000000000000000')),
      };
      const mockClient2: MockClient = {
        getBalance: stub().rejects(new Error('RPC error')),
      };

      stub(contractModule, 'createClient')
        .withArgs('1', mockConfig)
        .returns(mockClient1 as unknown as ReturnType<typeof contractModule.createClient>)
        .withArgs('2', mockConfig)
        .returns(mockClient2 as unknown as ReturnType<typeof contractModule.createClient>);

      const balances = await getMarkGasBalances(mockConfig, mockChainService as unknown as ChainService, prometheus);
      expect(balances.get('1')?.toString()).toBe('1000000000000000000');
      expect(balances.get('2')?.toString()).toBe('0'); // Should return 0 for failed chain
    });
  });

  describe('getMarkBalances', () => {
    const mockTickers = ['0xtestticker'];
    const mockBalance = '1000';

    it('should return balances for all tickers and chains', async () => {
      const mockContract: MockERC20Contract = {
        read: {
          balanceOf: stub().resolves(mockBalance),
        },
      };
      stub(contractModule, 'getERC20Contract').resolves(
        mockContract as unknown as Awaited<ReturnType<typeof contractModule.getERC20Contract>>,
      );

      stub(assetModule, 'getTickers').returns(mockTickers);

      const balances = await getMarkBalances(mockConfig, mockChainService as unknown as ChainService, prometheus);

      expect(balances.size).toBe(mockTickers.length);
      for (const ticker of mockTickers) {
        const domainBalances = balances.get(ticker);
        expect(domainBalances).toBeDefined();
        expect(domainBalances?.size).toBe(Object.keys(mockConfig.chains).length);
        for (const domain of Object.keys(mockConfig.chains)) {
          expect(domainBalances?.get(domain)?.toString()).toBe(mockBalance);
        }
      }
      // call count is per token per chain. right now only one asset on each chain
      expect(prometheus.updateChainBalance.callCount).toBe(Object.keys(mockConfig.chains).length);
    });

    it('should use Gnosis Safe address when Zodiac is enabled', async () => {
      // Mock zodiac functions
      const mockZodiacConfigEnabled = { walletType: WalletType.Zodiac, safeAddress: '0xGnosisSafe' as `0x${string}` };
      const mockZodiacConfigDisabled = { walletType: WalletType.EOA };

      stub(zodiacModule, 'getValidatedZodiacConfig')
        .withArgs(mockConfigWithZodiac.chains['1'])
        .returns(mockZodiacConfigEnabled)
        .withArgs(mockConfigWithZodiac.chains['2'])
        .returns(mockZodiacConfigDisabled);

      stub(zodiacModule, 'getActualOwner')
        .withArgs(mockZodiacConfigEnabled, mockConfigWithZodiac.ownAddress)
        .returns('0xGnosisSafe')
        .withArgs(mockZodiacConfigDisabled, mockConfigWithZodiac.ownAddress)
        .returns(mockConfigWithZodiac.ownAddress);

      stub(assetModule, 'getTickers').returns(mockTickers);

      // Mock ERC20 contracts to track which addresses are used
      const mockBalanceOf1 = stub().resolves('5000');
      const mockBalanceOf2 = stub().resolves('6000');

      const mockContract1 = { read: { balanceOf: mockBalanceOf1 } };
      const mockContract2 = { read: { balanceOf: mockBalanceOf2 } };

      stub(contractModule, 'getERC20Contract')
        .withArgs(mockConfigWithZodiac, '1', '0xtest')
        .resolves(mockContract1 as unknown as Awaited<ReturnType<typeof contractModule.getERC20Contract>>)
        .withArgs(mockConfigWithZodiac, '2', '0xtest')
        .resolves(mockContract2 as unknown as Awaited<ReturnType<typeof contractModule.getERC20Contract>>);

      const balances = await getMarkBalances(
        mockConfigWithZodiac,
        mockChainService as unknown as ChainService,
        prometheus,
      );

      // Verify correct addresses were used for balance checks
      expect(mockBalanceOf1.calledWith(['0xGnosisSafe'])).toBe(true);
      expect(mockBalanceOf2.calledWith(['0xOwnAddress'])).toBe(true);

      const ticker1Balances = balances.get(mockTickers[0]);
      expect(ticker1Balances?.get('1')?.toString()).toBe('5000');
      expect(ticker1Balances?.get('2')?.toString()).toBe('6000');
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
      const mockContract: MockERC20Contract = {
        read: {
          balanceOf: stub().resolves(inputBalance),
        },
      };
      stub(contractModule, 'getERC20Contract').resolves(
        mockContract as unknown as Awaited<ReturnType<typeof contractModule.getERC20Contract>>,
      );

      const balances = await getMarkBalances(
        configWithSixDecimals,
        mockChainService as unknown as ChainService,
        prometheus,
      );
      const assetBalances = balances.get(sixDecimalAsset.tickerHash);

      expect(assetBalances?.get('1')?.toString()).toBe(expectedBalance.toString());
      expect(prometheus.updateChainBalance.calledOnce).toBe(true);
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
      const mockContract: MockERC20Contract = {
        read: {
          balanceOf: stub().resolves('1000'),
        },
      };
      stub(contractModule, 'getERC20Contract').resolves(
        mockContract as unknown as Awaited<ReturnType<typeof contractModule.getERC20Contract>>,
      );

      const balances = await getMarkBalances(
        configWithoutAddress,
        mockChainService as unknown as ChainService,
        prometheus,
      );
      expect(balances.get(mockAssetConfig.tickerHash)?.get('1')).toBeUndefined();
      expect(prometheus.updateChainBalance.calledOnce).toBe(false);
    });

    it('should handle contract errors gracefully', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(contractModule, 'getERC20Contract').rejects(new Error('Contract error'));

      const balances = await getMarkBalances(mockConfig, mockChainService as unknown as ChainService, prometheus);
      const domainBalances = balances.get(mockAssetConfig.tickerHash);
      expect(domainBalances?.get('1')?.toString()).toBe('0'); // Should return 0 for failed contract
    });
  });

  describe('getCustodiedBalances', () => {
    const mockTickers = ['0xtestticker'];
    const mockCustodiedAmount = BigInt('1000000000000000000'); // 1 token

    it('should return custodied balances for all tickers and chains', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(assetModule, 'getAssetHash').returns('0xassethash');
      const mockHubContract: MockHubStorageContract = {
        read: {
          custodiedAssets: stub().resolves(mockCustodiedAmount),
        },
      };
      stub(contractModule, 'getHubStorageContract').returns(
        mockHubContract as unknown as ReturnType<typeof contractModule.getHubStorageContract>,
      );

      const balances = await getCustodiedBalances(mockConfig);

      expect(balances.size).toBe(mockTickers.length);
      for (const ticker of mockTickers) {
        const domainBalances = balances.get(ticker);
        expect(domainBalances).toBeDefined();
        expect(domainBalances?.size).toBe(Object.keys(mockConfig.chains).length);
        for (const domain of Object.keys(mockConfig.chains)) {
          expect(domainBalances?.get(domain)?.toString()).toBe(mockCustodiedAmount.toString());
        }
      }
    });

    it('should handle missing asset hash', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(assetModule, 'getAssetHash').returns(undefined);
      const mockHubContract: MockHubStorageContract = {
        read: {
          custodiedAssets: stub().resolves(mockCustodiedAmount),
        },
      };
      stub(contractModule, 'getHubStorageContract').returns(
        mockHubContract as unknown as ReturnType<typeof contractModule.getHubStorageContract>,
      );

      const balances = await getCustodiedBalances(mockConfig);
      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('1')).toBe(0n);
    });

    it('should handle empty tickers list', async () => {
      stub(assetModule, 'getTickers').returns([]);

      const balances = await getCustodiedBalances(mockConfig);
      expect(balances.size).toBe(0);
    });

    it('should handle contract errors gracefully', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(assetModule, 'getAssetHash').returns('0xassethash');
      const mockHubContract: MockHubStorageContract = {
        read: {
          custodiedAssets: stub().rejects(new Error('Contract error')),
        },
      };
      stub(contractModule, 'getHubStorageContract').returns(
        mockHubContract as unknown as ReturnType<typeof contractModule.getHubStorageContract>,
      );

      const balances = await getCustodiedBalances(mockConfig);
      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('1')?.toString()).toBe('0'); // Should return 0 for failed contract
    });
  });
});
