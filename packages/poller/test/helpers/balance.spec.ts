import { SinonStubbedInstance, stub, createStubInstance } from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { getMarkBalances, getMarkGasBalances, getCustodiedBalances } from '../../src/helpers/balance';
import * as assetModule from '../../src/helpers/asset';
import * as zodiacModule from '../../src/helpers/zodiac';
import { AssetConfiguration, MarkConfiguration, WalletType, GasType } from '@mark/core';
import { PrometheusAdapter } from '@mark/prometheus';
import { ChainService } from '@mark/chainservice';
import { PublicClient } from 'viem';
import { TronWeb } from 'tronweb';

// Mock interfaces for proper typing
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

  const mockConfigWithTron = {
    ownAddress: '0xOwnAddress',
    chains: {
      '1': {
        providers: ['https://mainnet.infura.io/v3/test'],
        assets: [mockAssetConfig],
      },
      '728126428': {
        // Tron chain
        providers: ['https://api.trongrid.io'],
        assets: [mockAssetConfig],
      },
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
  let chainService: SinonStubbedInstance<ChainService>;

  beforeEach(() => {
    prometheus = createStubInstance(PrometheusAdapter);
    chainService = createStubInstance(ChainService);
  });

  describe('getMarkGasBalances', () => {
    // Helper function to find a key in the Map by comparing properties
    const findMapKey = (map: Map<{ chainId: string; gasType: GasType }, bigint>, chainId: string, gasType: GasType) => {
      for (const [key, value] of map.entries()) {
        if (key.chainId === chainId && key.gasType === gasType) {
          return value;
        }
      }
      return undefined;
    };

    it('should return gas balances for all chains', async () => {
      const mockClient = {
        getBalance: stub().resolves(BigInt('1000000000000000000')), // 1 ETH
      } as unknown as PublicClient;
      stub(contractModule, 'createClient').returns(mockClient);

      const balances = await getMarkGasBalances(mockConfig, chainService, prometheus);

      expect(balances.size).toBe(Object.keys(mockConfig.chains).length);
      for (const chain of Object.keys(mockConfig.chains)) {
        const balance = findMapKey(balances, chain, GasType.Gas);
        expect(balance?.toString()).toBe('1000000000000000000');
      }
    });

    it('should handle chain client errors by returning zero balance', async () => {
      // First chain succeeds, second fails
      const mockClient1 = {
        getBalance: stub().resolves(BigInt('1000000000000000000')),
      } as unknown as PublicClient;
      const mockClient2 = {
        getBalance: stub().rejects(new Error('RPC error')),
      } as unknown as PublicClient;

      stub(contractModule, 'createClient')
        .withArgs('1', mockConfig)
        .returns(mockClient1)
        .withArgs('2', mockConfig)
        .returns(mockClient2);

      const balances = await getMarkGasBalances(mockConfig, chainService, prometheus);
      const balance1 = findMapKey(balances, '1', GasType.Gas);
      const balance2 = findMapKey(balances, '2', GasType.Gas);
      expect(balance1?.toString()).toBe('1000000000000000000');
      expect(balance2?.toString()).toBe('0'); // Should return 0 for failed chain
    });

    it('should return bandwidth and energy for Tron chains', async () => {
      const mockClient = {
        getBalance: stub().resolves(BigInt('1000000000000000000')), // 1 ETH
      } as unknown as PublicClient;
      stub(contractModule, 'createClient').returns(mockClient);

      // Mock chainService.getAddress() to return addresses for all chains
      chainService.getAddress.resolves({
        '1': '0xOwnAddress',
        '728126428': '0xTronAddress',
      });

      // Mock zodiac functions
      const mockZodiacConfig = { walletType: WalletType.EOA };
      stub(zodiacModule, 'getValidatedZodiacConfig').returns(mockZodiacConfig);
      stub(zodiacModule, 'getActualOwner').returns('0xTronAddress');

      const mockTronWeb = {
        trx: {
          getAccountResources: stub().resolves({
            freeNetLimit: 1000,
            freeNetUsed: 100,
            NetLimit: 2000,
            NetUsed: 200,
            EnergyLimit: 5000,
            EnergyUsed: 500,
          }),
        },
      };

      const balances = await getMarkGasBalances(
        mockConfigWithTron,
        chainService,
        prometheus,
        mockTronWeb as unknown as TronWeb,
      );

      // Should have 3 entries: 1 for regular gas, 2 for Tron (bandwidth + energy)
      expect(balances.size).toBe(3);

      // Check regular gas balance
      const gasBalance = findMapKey(balances, '1', GasType.Gas);
      expect(gasBalance?.toString()).toBe('1000000000000000000');

      // Check Tron bandwidth: (1000 - 100) + (2000 - 200) = 2700
      const bandwidthBalance = findMapKey(balances, '728126428', GasType.Bandwidth);
      expect(bandwidthBalance?.toString()).toBe('2700');

      // Check Tron energy: 5000 - 500 = 4500
      const energyBalance = findMapKey(balances, '728126428', GasType.Energy);
      expect(energyBalance?.toString()).toBe('4500');
    });

    it('should handle Tron chain without TronWeb by setting balances to zero', async () => {
      const mockClient = {
        getBalance: stub().resolves(BigInt('1000000000000000000')), // 1 ETH
      } as unknown as PublicClient;
      stub(contractModule, 'createClient').returns(mockClient);

      const balances = await getMarkGasBalances(mockConfigWithTron, chainService, prometheus);

      // Should have 3 entries: 1 for regular gas, 2 for Tron (bandwidth + energy) set to 0
      expect(balances.size).toBe(3);

      // Check regular gas balance (should work)
      const gasBalance = findMapKey(balances, '1', GasType.Gas);
      expect(gasBalance?.toString()).toBe('1000000000000000000');

      // Check Tron bandwidth (should be 0 due to missing TronWeb)
      const bandwidthBalance = findMapKey(balances, '728126428', GasType.Bandwidth);
      expect(bandwidthBalance?.toString()).toBe('0');

      // Check Tron energy (should be 0 due to missing TronWeb)
      const energyBalance = findMapKey(balances, '728126428', GasType.Energy);
      expect(energyBalance?.toString()).toBe('0');
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

      const balances = await getMarkBalances(mockConfig, chainService, prometheus);

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

      const balances = await getMarkBalances(mockConfigWithZodiac, chainService, prometheus);

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

      const balances = await getMarkBalances(configWithSixDecimals, chainService, prometheus);
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

      const balances = await getMarkBalances(configWithoutAddress, chainService, prometheus);
      expect(balances.get(mockAssetConfig.tickerHash)?.get('1')).toBeUndefined();
      expect(prometheus.updateChainBalance.calledOnce).toBe(false);
    });

    it('should handle contract errors gracefully', async () => {
      stub(assetModule, 'getTickers').returns(mockTickers);
      stub(contractModule, 'getERC20Contract').rejects(new Error('Contract error'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const balances = await getMarkBalances(mockConfig, chainService, prometheus);
      consoleErrorSpy.mockRestore();

      const domainBalances = balances.get(mockAssetConfig.tickerHash);
      expect(domainBalances?.get('1')?.toString()).toBe('0'); // Should return 0 for failed contract
    });

    it('should skip native tokens (e.g. APE on ApeChain)', async () => {
      const nativeApeConfig = {
        ownAddress: '0xOwnAddress',
        chains: {
          '33139': {
            providers: ['https://apechain.drpc.org'],
            assets: [
              {
                ...mockAssetConfig,
                address: '0x7f9FBf9bDd3F4105C478b996B648FE6e828a1e98',
                tickerHash: '0x26bca2ecad19e981c90a8c6efd8ee9856bbc5a2042259e6ee31e310fdc08d970',
                isNative: true,
              },
            ],
          },
        },
      } as unknown as MarkConfiguration;

      const getERC20ContractStub = stub(contractModule, 'getERC20Contract');
      stub(contractModule, 'createClient').returns({
        getBytecode: stub().resolves('0x1234'),
      } as unknown as ReturnType<typeof contractModule.createClient>);

      stub(assetModule, 'getTickers').returns(['0x26bca2ecad19e981c90a8c6efd8ee9856bbc5a2042259e6ee31e310fdc08d970']);

      const balances = await getMarkBalances(nativeApeConfig, chainService, prometheus);

      expect(getERC20ContractStub.called).toBe(false); // Should not call getEvmBalance for native
      const domainBalances = balances.get('0x26bca2ecad19e981c90a8c6efd8ee9856bbc5a2042259e6ee31e310fdc08d970');
      expect(domainBalances?.get('33139')).toBeUndefined(); // Skipped - no balance entry
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
