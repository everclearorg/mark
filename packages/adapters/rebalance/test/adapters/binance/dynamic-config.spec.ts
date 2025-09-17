/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ChainConfiguration } from '@mark/core';
import { DynamicAssetConfig } from '../../../src/adapters/binance/dynamic-config';
import { BinanceClient } from '../../../src/adapters/binance/client';
import { CoinConfig } from '../../../src/adapters/binance/types';

// Mock the BinanceClient
jest.mock('../../../src/adapters/binance/client');

describe('DynamicAssetConfig', () => {
  let dynamicConfig: DynamicAssetConfig;
  let mockClient: jest.Mocked<BinanceClient>;
  let mockChains: Record<string, ChainConfiguration>;

  beforeEach(() => {
    mockClient = {
      getAssetConfig: jest.fn(),
    } as unknown as jest.Mocked<BinanceClient>;

    mockChains = {
      '1': {
        assets: [
          {
            symbol: 'WETH',
            address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            decimals: 18,
            tickerHash: '0xWETH',
            isNative: false,
            balanceThreshold: '0',
          },
          {
            symbol: 'USDC',
            address: '0xa0b86a33e6c0b8a62b01b23e8aaa8e6dcc6cfa7f',
            decimals: 6,
            tickerHash: '0xUSDC',
            isNative: false,
            balanceThreshold: '0',
          },
        ],
        providers: ['http://localhost:8545'],
        invoiceAge: 3600,
        gasThreshold: '100000',
        deployments: { everclear: '0x123', permit2: '0x456', multicall3: '0x789' },
      },
      '56': {
        // BSC
        assets: [
          {
            symbol: 'WETH',
            address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
            decimals: 18,
            tickerHash: '0xWETH',
            isNative: false,
            balanceThreshold: '0',
          },
          {
            symbol: 'USDC',
            address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            decimals: 18,
            tickerHash: '0xUSDC',
            isNative: false,
            balanceThreshold: '0',
          }, // BSC USDC uses 18 decimals!
          {
            symbol: 'USDT',
            address: '0x55d398326f99059fF775485246999027B3197955',
            decimals: 18,
            tickerHash: '0xUSDT',
            isNative: false,
            balanceThreshold: '0',
          }, // BSC USDT uses 18 decimals!
        ],
        providers: ['http://localhost:8545'],
        invoiceAge: 3600,
        gasThreshold: '100000',
        deployments: { everclear: '0x123', permit2: '0x456', multicall3: '0x789' },
      },
      '42161': {
        assets: [
          {
            symbol: 'WETH',
            address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
            decimals: 18,
            tickerHash: '0xWETH',
            isNative: false,
            balanceThreshold: '0',
          },
          {
            symbol: 'USDC',
            address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
            decimals: 6,
            tickerHash: '0xUSDC',
            isNative: false,
            balanceThreshold: '0',
          },
        ],
        providers: ['http://localhost:8545'],
        invoiceAge: 3600,
        gasThreshold: '100000',
        deployments: { everclear: '0x123', permit2: '0x456', multicall3: '0x789' },
      },
    } as Record<string, ChainConfiguration>;

    dynamicConfig = new DynamicAssetConfig(mockClient, mockChains);
  });

  const mockCoinConfig: CoinConfig[] = [
    {
      coin: 'ETH',
      name: 'Ethereum',
      free: '0',
      locked: '0',
      freeze: '0',
      withdrawing: '0',
      ipoing: '0',
      ipoable: '0',
      storage: '0',
      isLegalMoney: false,
      trading: true,
      depositAllEnable: true,
      withdrawAllEnable: true,
      networkList: [
        {
          network: 'ETH',
          name: 'Ethereum',
          isDefault: true,
          depositEnable: true,
          withdrawEnable: true,
          withdrawMin: '0.01',
          withdrawFee: '0.001',
          withdrawMax: '1000',
          minConfirm: 12,
          contractAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        },
        {
          network: 'ARBITRUM',
          name: 'Arbitrum',
          isDefault: false,
          depositEnable: true,
          withdrawEnable: true,
          withdrawMin: '0.01',
          withdrawFee: '0.001',
          withdrawMax: '1000',
          minConfirm: 1,
          contractAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        },
      ],
    },
    {
      coin: 'USDC',
      name: 'USD Coin',
      free: '0',
      locked: '0',
      freeze: '0',
      withdrawing: '0',
      ipoing: '0',
      ipoable: '0',
      storage: '0',
      isLegalMoney: false,
      trading: true,
      depositAllEnable: true,
      withdrawAllEnable: true,
      networkList: [
        {
          network: 'ETH',
          name: 'Ethereum',
          isDefault: true,
          depositEnable: true,
          withdrawEnable: true,
          withdrawMin: '10',
          withdrawFee: '1',
          withdrawMax: '10000',
          minConfirm: 12,
          contractAddress: '0xa0b86a33e6c0b8a62b01b23e8aaa8e6dcc6cfa7f',
        },
        {
          network: 'BSC',
          name: 'Binance Smart Chain',
          isDefault: false,
          depositEnable: true,
          withdrawEnable: true,
          withdrawMin: '10',
          withdrawFee: '0.8',
          withdrawMax: '10000',
          minConfirm: 15,
          contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        },
      ],
    },
  ];

  describe('getAssetMapping', () => {
    it('should return asset mapping for known symbol', async () => {
      mockClient.getAssetConfig.mockResolvedValue(mockCoinConfig);

      const result = await dynamicConfig.getAssetMapping(1, 'WETH');

      expect(result).toEqual({
        chainId: 1,
        binanceAsset: '0x0000000000000000000000000000000000000000',
        binanceSymbol: 'ETH',
        network: 'ETH',
        minWithdrawalAmount: '10000000000000000',
        withdrawalFee: '1000000000000000',
        depositConfirmations: 12,
      });
    });

    it('should return asset mapping for contract address', async () => {
      mockClient.getAssetConfig.mockResolvedValue(mockCoinConfig);

      const result = await dynamicConfig.getAssetMapping(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');

      expect(result).toEqual({
        chainId: 1,
        binanceAsset: '0x0000000000000000000000000000000000000000',
        binanceSymbol: 'ETH',
        network: 'ETH',
        minWithdrawalAmount: '10000000000000000',
        withdrawalFee: '1000000000000000',
        depositConfirmations: 12,
      });
    });

    it('should throw error for unknown asset identifier', async () => {
      mockClient.getAssetConfig.mockResolvedValue(mockCoinConfig);

      await expect(dynamicConfig.getAssetMapping(1, 'UNKNOWN')).rejects.toThrow('Unknown asset identifier: UNKNOWN');
    });

    it('should throw error for unknown contract address', async () => {
      mockClient.getAssetConfig.mockResolvedValue(mockCoinConfig);

      await expect(dynamicConfig.getAssetMapping(1, '0x1234567890123456789012345678901234567890')).rejects.toThrow(
        'Unknown asset identifier: 0x1234567890123456789012345678901234567890',
      );
    });

    it('should throw error for missing Binance coin configuration', async () => {
      mockClient.getAssetConfig.mockResolvedValue([]);

      await expect(dynamicConfig.getAssetMapping(1, 'WETH')).rejects.toThrow(
        'No Binance coin configuration found for symbol: ETH',
      );
    });

    it('should throw error for unsupported chain', async () => {
      mockClient.getAssetConfig.mockResolvedValue(mockCoinConfig);

      await expect(dynamicConfig.getAssetMapping(999, 'WETH')).rejects.toThrow(
        'Binance does not support WETH on chain 999',
      );
    });

    it('should throw error when deposit is disabled', async () => {
      const configWithDisabledDeposit = [
        {
          ...mockCoinConfig[0],
          networkList: [
            {
              ...mockCoinConfig[0].networkList[0],
              depositEnable: false,
            },
          ],
        },
      ];

      mockClient.getAssetConfig.mockResolvedValue(configWithDisabledDeposit);

      await expect(dynamicConfig.getAssetMapping(1, 'WETH')).rejects.toThrow(
        'WETH on ETH is currently disabled. Deposit: false, Withdraw: true',
      );
    });

    it('should throw error when withdrawal is disabled', async () => {
      const configWithDisabledWithdrawal = [
        {
          ...mockCoinConfig[0],
          networkList: [
            {
              ...mockCoinConfig[0].networkList[0],
              withdrawEnable: false,
            },
          ],
        },
      ];

      mockClient.getAssetConfig.mockResolvedValue(configWithDisabledWithdrawal);

      await expect(dynamicConfig.getAssetMapping(1, 'WETH')).rejects.toThrow(
        'WETH on ETH is currently disabled. Deposit: true, Withdraw: false',
      );
    });

    it('should use network contract address when available', async () => {
      const configWithNetworkContract = [
        {
          ...mockCoinConfig[0],
          networkList: [
            {
              ...mockCoinConfig[0].networkList[0],
              contractAddress: '0xCustomContract',
            },
          ],
        },
      ];

      mockClient.getAssetConfig.mockResolvedValue(configWithNetworkContract);

      const result = await dynamicConfig.getAssetMapping(1, 'WETH');

      expect(result.binanceAsset).toBe('0x0000000000000000000000000000000000000000');
    });

    it('should fall back to chain config when no network contract address', async () => {
      const configWithoutNetworkContract = [
        {
          ...mockCoinConfig[0],
          networkList: [
            {
              ...mockCoinConfig[0].networkList[0],
              contractAddress: undefined,
            },
          ],
        },
      ];

      mockClient.getAssetConfig.mockResolvedValue(configWithoutNetworkContract);

      const result = await dynamicConfig.getAssetMapping(1, 'WETH');

      expect(result.binanceAsset).toBe('0x0000000000000000000000000000000000000000');
    });

    it('should throw error when no chain configuration found', async () => {
      const configWithoutNetworkContract = [
        {
          ...mockCoinConfig[0],
          networkList: [
            {
              ...mockCoinConfig[0].networkList[0],
              contractAddress: undefined,
            },
          ],
        },
      ];

      mockClient.getAssetConfig.mockResolvedValue(configWithoutNetworkContract);

      await expect(dynamicConfig.getAssetMapping(999, 'WETH')).rejects.toThrow(
        'Binance does not support WETH on chain 999',
      );
    });

    it('should throw error when asset not found in chain config', async () => {
      const configWithoutNetworkContract = [
        {
          ...mockCoinConfig[0],
          networkList: [
            {
              ...mockCoinConfig[0].networkList[0],
              contractAddress: undefined,
            },
          ],
        },
      ];

      mockClient.getAssetConfig.mockResolvedValue(configWithoutNetworkContract);

      await expect(dynamicConfig.getAssetMapping(1, 'UNKNOWN')).rejects.toThrow('Unknown asset identifier: UNKNOWN');
    });

    it('should handle USDC with 6 decimals', async () => {
      mockClient.getAssetConfig.mockResolvedValue(mockCoinConfig);

      const result = await dynamicConfig.getAssetMapping(1, 'USDC');

      expect(result.minWithdrawalAmount).toBe('10000000'); // 10 * 10^6
      expect(result.withdrawalFee).toBe('1000000'); // 1 * 10^6
    });

    it('should handle USDT with 6 decimals', async () => {
      const configWithUSDT = [
        {
          coin: 'USDT',
          networkList: [
            {
              network: 'ETH',
              name: 'Ethereum',
              isDefault: true,
              depositEnable: true,
              withdrawEnable: true,
              withdrawMin: '1',
              withdrawFee: '0.1',
              withdrawMax: '1000',
              minConfirm: 12,
              contractAddress: '0x123',
            },
          ],
        },
      ];

      mockClient.getAssetConfig.mockResolvedValue(configWithUSDT);

      // Add USDT to the symbol mapping for this test
      mockChains['1'].assets.push({
        symbol: 'USDT',
        address: '0x123',
        decimals: 6,
        tickerHash: '0xUSDT',
        isNative: false,
        balanceThreshold: '0',
      });

      const result = await dynamicConfig.getAssetMapping(1, 'USDT');

      expect(result.minWithdrawalAmount).toBe('1000000'); // 1 * 10^6
      expect(result.withdrawalFee).toBe('100000'); // 0.1 * 10^6
    });

    describe('BSC decimal handling (the critical fix)', () => {
      it('should use BSC chain decimals (18) for USDC, not Binance internal decimals (6)', async () => {
        const bscUSDCConfig = [
          {
            coin: 'USDC',
            networkList: [
              {
                network: 'BSC',
                name: 'Binance Smart Chain',
                isDefault: true,
                depositEnable: true,
                withdrawEnable: true,
                withdrawMin: '10',
                withdrawFee: '0.8',
                withdrawMax: '10000',
                minConfirm: 15,
                contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
              },
            ],
          },
        ];

        mockClient.getAssetConfig.mockResolvedValue(bscUSDCConfig);

        const result = await dynamicConfig.getAssetMapping(56, 'USDC');

        // CRITICAL: BSC USDC uses 18 decimals, not 6!
        expect(result.withdrawalFee).toBe('800000000000000000'); // 0.8 * 10^18 (not 0.8 * 10^6)
        expect(result.minWithdrawalAmount).toBe('10000000000000000000'); // 10 * 10^18
      });

      it('should use BSC chain decimals (18) for USDT, not Binance internal decimals (6)', async () => {
        const bscUSDTConfig = [
          {
            coin: 'USDT',
            networkList: [
              {
                network: 'BSC',
                name: 'Binance Smart Chain',
                isDefault: true,
                depositEnable: true,
                withdrawEnable: true,
                withdrawMin: '10',
                withdrawFee: '0.8',
                withdrawMax: '10000',
                minConfirm: 15,
                contractAddress: '0x55d398326f99059fF775485246999027B3197955',
              },
            ],
          },
        ];

        mockClient.getAssetConfig.mockResolvedValue(bscUSDTConfig);

        const result = await dynamicConfig.getAssetMapping(56, 'USDT');

        // CRITICAL: BSC USDT uses 18 decimals, not 6!
        expect(result.withdrawalFee).toBe('800000000000000000'); // 0.8 * 10^18 (not 0.8 * 10^6)
        expect(result.minWithdrawalAmount).toBe('10000000000000000000'); // 10 * 10^18
      });

      it('should throw error if chain config is missing', async () => {
        const bscUSDCConfig = [
          {
            coin: 'USDC',
            networkList: [
              {
                network: 'BSC',
                name: 'Binance Smart Chain',
                isDefault: true,
                depositEnable: true,
                withdrawEnable: true,
                withdrawMin: '10',
                withdrawFee: '0.8',
                withdrawMax: '10000',
                minConfirm: 15,
                contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
              },
            ],
          },
        ];

        mockClient.getAssetConfig.mockResolvedValue(bscUSDCConfig);

        // Chain 999 doesn't exist
        await expect(dynamicConfig.getAssetMapping(999, 'USDC')).rejects.toThrow(
          'Binance does not support USDC on chain 999',
        );
      });

      it('should throw error if asset not in chain config', async () => {
        const bscUnknownConfig = [
          {
            coin: 'UNKNOWN',
            networkList: [
              {
                network: 'BSC',
                name: 'Binance Smart Chain',
                isDefault: true,
                depositEnable: true,
                withdrawEnable: true,
                withdrawMin: '10',
                withdrawFee: '0.8',
                withdrawMax: '10000',
                minConfirm: 15,
              },
            ],
          },
        ];

        mockClient.getAssetConfig.mockResolvedValue(bscUnknownConfig);

        // UNKNOWN doesn't exist in BSC chain config
        await expect(dynamicConfig.getAssetMapping(56, 'UNKNOWN')).rejects.toThrow('Unknown asset identifier: UNKNOWN');
      });
    });
  });
});
