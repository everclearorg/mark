import { SinonStubbedInstance, stub, createStubInstance } from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { getMarkBalances, getMarkGasBalances, getCustodiedBalances } from '../../src/helpers/balance';
import * as assetModule from '../../src/helpers/asset';
import { AssetConfiguration, MarkConfiguration, GasType } from '@mark/core';
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

    let createClientStub: any;

    beforeEach(() => {
      createClientStub = stub(contractModule, 'createClient');
    });

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

    it('should handle Solana chain gas balance', async () => {
      const mockConfigWithSolana = {
        ...mockConfig,
        ownSolAddress: 'A0b86a33E6cC3b21c1b27b66b1b242b5a0b1c23e1234567890abcdef',
        chains: {
          ...mockConfig.chains,
          '1399811149': { // Solana chain ID
            gasEstimate: {
              type: 'gas',
            },
          },
        },
      } as any;

      chainService.getBalance.withArgs(1399811149, 'A0b86a33E6cC3b21c1b27b66b1b242b5a0b1c23e1234567890abcdef', '11111111111111111111111111111111').resolves('2000000000');

      const balances = await getMarkGasBalances(mockConfigWithSolana, chainService, prometheus);

      const solanaBalance = findMapKey(balances, '1399811149', GasType.Gas);
      expect(solanaBalance?.toString()).to.equal('2000000000');
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

    it('should handle assets with missing decimals', async () => {
      const configWithMissingDecimals = {
        ...mockConfig,
        chains: {
          '1': {
            providers: ['https://mainnet.infura.io/v3/test'],
            assets: [
              {
                ...mockAssetConfig,
                decimals: undefined, // Missing decimals
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

      const balances = await getMarkBalances(configWithMissingDecimals, chainService, prometheus);
      expect(balances.get(mockAssetConfig.tickerHash)?.get('1')).toBe(undefined);
      expect(prometheus.updateChainBalance.callCount).toBe(0);
    });

    it('should skip chains that are not configured', async () => {
      // Mock getTickers to return a ticker that's not supported on all chains
      stub(assetModule, 'getTickers').returns(mockTickers);

      // Create config where chain 2 doesn't have the ticker
      const configMismatch = {
        ...mockConfig,
        chains: {
          '1': {
            providers: ['https://mainnet.infura.io/v3/test'],
            assets: [mockAssetConfig], // Has the ticker
          },
          '2': {
            providers: ['https://other.infura.io/v3/test'],
            assets: [], // No assets - ticker not supported
          },
        },
      } as unknown as MarkConfiguration;

      stub(contractModule, 'getERC20Contract').resolves({
        read: {
          balanceOf: stub().resolves('1000'),
        },
      } as any);

      const balances = await getMarkBalances(configMismatch, chainService, prometheus);
      const domainBalances = balances.get(mockTickers[0]);

      // Should have balance for chain 1 but not chain 2
      expect(domainBalances?.get('1')?.toString()).to.equal('1000');
      expect(domainBalances?.has('2')).to.be.false; // No balance entry created for unsupported asset
      expect(prometheus.updateChainBalance.callCount).to.be.eq(1); // Only called for chain 1
    });

    it('should handle TVM chain balances', async () => {
      const mockConfigWithTvm = {
        ownAddress: '0xOwnAddress',
        chains: {
          '728126428': { // Tron chain ID
            providers: ['https://api.trongrid.io'],
            assets: [{
              ...mockAssetConfig,
              address: 'TokenAddressTron123456789',
              decimals: 6, // USDT on Tron has 6 decimals
            }],
          },
        },
      } as unknown as MarkConfiguration;

      stub(assetModule, 'getTickers').returns(mockTickers);

      // Mock TVM address and balance
      chainService.getAddress.resolves({
        '728126428': 'TronAddressExample123456789'
      });
      chainService.getBalance.withArgs(728126428, 'TronAddressExample123456789', 'TokenAddressTron123456789')
        .resolves('1000000'); // 1 token in 6 decimals

      const balances = await getMarkBalances(mockConfigWithTvm, chainService, prometheus);

      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('728126428')?.toString()).toBe('1000000000000000000'); // TVM balance normalized to 18 decimals
      expect(prometheus.updateChainBalance.callCount).toBe(1);
    });

    it('should handle TVM chain balance errors', async () => {
      const mockConfigWithTvm = {
        ownAddress: '0xOwnAddress',
        chains: {
          '728126428': { // Tron chain ID
            providers: ['https://api.trongrid.io'],
            assets: [{
              ...mockAssetConfig,
              address: 'TokenAddressTron123456789',
              decimals: 6,
            }],
          },
        },
      } as unknown as MarkConfiguration;

      stub(assetModule, 'getTickers').returns(mockTickers);

      // Mock TVM address but balance error
      chainService.getAddress.resolves({
        '728126428': 'TronAddressExample123456789'
      });
      chainService.getBalance.rejects(new Error('Tron RPC error'));

      const balances = await getMarkBalances(mockConfigWithTvm, chainService, prometheus);

      const domainBalances = balances.get(mockTickers[0]);
      expect(domainBalances?.get('728126428')?.toString()).to.equal('0'); // Should return 0 on error
      expect(prometheus.updateChainBalance.callCount).to.be.eq(0);
    });

    it('should handle SVM chain balance errors', async () => {
      const mockConfigWithSolana = {
        ownAddress: '0x1234567890123456789012345678901234567890',
        ownSolAddress: 'SoLAddress11111111111111111111111111112',
        chains: {
          '900': { // Solana chain ID
            providers: ['https://api.mainnet-beta.solana.com'],
            assets: [{
              tickerHash: 'SOL',
              address: 'So11111111111111111111111111111111111111112',
              decimals: 9,
              symbol: 'SOL',
              isNative: true,
              balanceThreshold: '0',
            }],
          },
        },
      } as unknown as MarkConfiguration;

      stub(assetModule, 'getTickers').returns(['SOL']);

      // Mock SVM balance error
      chainService.getBalance.rejects(new Error('Solana RPC error'));

      const balances = await getMarkBalances(mockConfigWithSolana, chainService, prometheus);

      const domainBalances = balances.get('SOL');
      expect(domainBalances?.get('900')?.toString()).to.equal('0'); // Should return 0 on error
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

      const balances = await getMarkBalances(mockConfig, chainService, prometheus);
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

  describe('safeStringToBigInt', () => {
    const { safeStringToBigInt } = require('../../src/helpers/balance');

    it('should convert integer string to BigInt', () => {
      const result = safeStringToBigInt('100', 1000000000000000000n);
      expect(result.toString()).to.equal('100000000000000000000');
    });

    it('should convert decimal string to BigInt', () => {
      const result = safeStringToBigInt('100.5', 1000000000000000000n);
      expect(result.toString()).to.equal('100500000000000000000');
    });

    it('should handle zero values', () => {
      expect(safeStringToBigInt('0', 1000000000000000000n).toString()).to.equal('0');
      expect(safeStringToBigInt('0.0', 1000000000000000000n).toString()).to.equal('0');
      expect(safeStringToBigInt('', 1000000000000000000n).toString()).to.equal('0');
    });

    it('should pad decimal part with zeros when needed', () => {
      const result = safeStringToBigInt('100.1', 1000000000000000000n);
      expect(result.toString()).to.equal('100100000000000000000');
    });

    it('should truncate excess decimal places', () => {
      const result = safeStringToBigInt('100.123456789012345678901', 1000000000000000000n);
      expect(result.toString()).to.equal('100123456789012345678');
    });

    it('should handle numbers without integer part', () => {
      const result = safeStringToBigInt('.5', 1000000000000000000n);
      expect(result.toString()).to.equal('500000000000000000');
    });

    it('should handle different scale factors', () => {
      const result6Decimals = safeStringToBigInt('100.5', 1000000n);
      expect(result6Decimals.toString()).to.equal('100500000');

      const result8Decimals = safeStringToBigInt('100.5', 100000000n);
      expect(result8Decimals.toString()).to.equal('10050000000');
    });
  });
});
