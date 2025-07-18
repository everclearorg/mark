import { parseUnits } from 'viem';
import { ChainConfiguration } from '@mark/core';
import { BinanceClient } from './client';
import { BinanceAssetMapping, CoinConfig, NetworkConfig } from './types';

/**
 * Network mapping from Binance network identifiers to chain IDs
 */
const BINANCE_NETWORK_TO_CHAIN_ID = {
  ETH: 1,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  POLYGON: 137,
  BSC: 56,
  BASE: 8453,
  SCROLL: 534352,
  ZKSYNCERA: 324,
} as const;

/**
 * Chain ID to network mapping
 */
const CHAIN_ID_TO_BINANCE_NETWORK = Object.fromEntries(
  Object.entries(BINANCE_NETWORK_TO_CHAIN_ID).map(([network, chainId]) => [chainId, network]),
) as Record<number, string>;

/**
 * Maps external symbols to Binance internal symbols
 */
const EXTERNAL_TO_BINANCE_SYMBOL = {
  WETH: 'ETH', // External WETH -> Binance ETH
  USDC: 'USDC',
  USDT: 'USDT',
} as const;

/**
 * Dynamic asset configuration service for Binance adapter
 * Fetches real-time asset configuration from Binance API
 */
export class DynamicAssetConfig {
  constructor(
    private readonly client: BinanceClient,
    private readonly chains: Record<string, ChainConfiguration>,
  ) {}

  /**
   * Get asset mapping for a specific chain and asset address or symbol
   * @param chainId - Blockchain chain ID (e.g., 1 for Ethereum)
   * @param assetIdentifier - On-chain contract address OR external symbol (e.g., 'WETH', 'USDC')
   * @returns Promise<BinanceAssetMapping> - Asset mapping with current fees and limits
   */
  async getAssetMapping(chainId: number, assetIdentifier: string): Promise<BinanceAssetMapping> {
    const config = (await this.client.getAssetConfig()) as CoinConfig[];

    // Determine if it's an address or symbol
    const symbol = this.resolveAssetSymbol(assetIdentifier);
    const binanceSymbol = this.getBinanceSymbol(symbol);

    return this.buildMapping(config, chainId, symbol, binanceSymbol);
  }

  /**
   * Resolve asset identifier to external symbol
   * @param assetIdentifier - Contract address or symbol
   * @returns External symbol (e.g., 'WETH', 'USDC')
   */
  private resolveAssetSymbol(assetIdentifier: string): string {
    // If it's already a known symbol, return it
    if (assetIdentifier in EXTERNAL_TO_BINANCE_SYMBOL) {
      return assetIdentifier;
    }

    // If it's an address, look it up in chain configurations
    if (assetIdentifier.startsWith('0x')) {
      const normalizedAddress = assetIdentifier.toLowerCase();

      for (const chainConfig of Object.values(this.chains)) {
        for (const asset of chainConfig.assets) {
          if (asset.address.toLowerCase() === normalizedAddress) {
            return asset.symbol;
          }
        }
      }
    }

    throw new Error(`Unknown asset identifier: ${assetIdentifier}`);
  }

  /**
   * Get Binance internal symbol from external symbol
   * @param externalSymbol - External symbol (e.g., 'WETH')
   * @returns Binance symbol (e.g., 'ETH')
   */
  private getBinanceSymbol(externalSymbol: string): string {
    const binanceSymbol = EXTERNAL_TO_BINANCE_SYMBOL[externalSymbol as keyof typeof EXTERNAL_TO_BINANCE_SYMBOL];
    if (!binanceSymbol) {
      throw new Error(`No Binance symbol mapping for: ${externalSymbol}`);
    }
    return binanceSymbol;
  }

  /**
   * Build mapping for a specific asset and chain
   * @param config - Binance API configuration
   * @param chainId - Target chain ID
   * @param externalSymbol - External symbol (e.g., 'WETH')
   * @param binanceSymbol - Binance symbol (e.g., 'ETH')
   * @returns BinanceAssetMapping - Formatted asset mapping
   */
  private buildMapping(
    config: CoinConfig[],
    chainId: number,
    externalSymbol: string,
    binanceSymbol: string,
  ): BinanceAssetMapping {
    // Find the coin configuration
    const coin = config.find((c) => c.coin === binanceSymbol);
    if (!coin) {
      throw new Error(`No Binance coin configuration found for symbol: ${binanceSymbol}`);
    }
    // Find the network configuration for this chain
    const network = this.findNetworkByChainId(coin.networkList, chainId);
    if (!network) {
      throw new Error(
        `Binance does not support ${externalSymbol} on chain ${chainId}. ` +
          `Available networks: ${coin.networkList.map((n) => n.network).join(', ')}`,
      );
    }

    // Validate network is enabled
    if (!network.depositEnable || !network.withdrawEnable) {
      throw new Error(
        `${externalSymbol} on ${network.network} is currently disabled. ` +
          `Deposit: ${network.depositEnable}, Withdraw: ${network.withdrawEnable}`,
      );
    }

    // Get Binance asset address and decimals
    const binanceAsset = this.getBinanceAddress(externalSymbol, chainId);
    const decimals = this.getTokenDecimals(binanceSymbol);

    return {
      chainId,
      binanceAsset: binanceAsset.toLowerCase(),
      binanceSymbol: coin.coin,
      network: network.network,
      minWithdrawalAmount: parseUnits(network.withdrawMin, decimals).toString(),
      withdrawalFee: parseUnits(network.withdrawFee, decimals).toString(),
      depositConfirmations: network.minConfirm,
    };
  }

  /**
   * Get the address that Binance accepts for deposits/withdrawals
   * @param externalSymbol - External symbol (e.g., 'WETH')
   * @param chainId - Chain ID
   * @returns Address that Binance accepts for this asset on this chain
   */
  private getBinanceAddress(externalSymbol: string, chainId: number): string {
    if (externalSymbol === 'WETH') {
      // Binance takes WETH token on BSC chain
      if (chainId === 56) {
        const chainConfig = this.chains[chainId.toString()];
        if (!chainConfig) {
          throw new Error(`No chain configuration found for chain ${chainId}`);
        }
        const asset = chainConfig.assets.find((a) => a.symbol === 'WETH');
        if (!asset) {
          throw new Error(`No WETH asset found in BSC chain configuration`);
        }
        return asset.address;
      }
      // Binance takes native ETH for all other chains
      return '0x0000000000000000000000000000000000000000';
    }

    // For non-WETH assets, use the actual contract address
    const chainConfig = this.chains[chainId.toString()];
    if (!chainConfig) {
      throw new Error(`No chain configuration found for chain ${chainId}`);
    }

    const asset = chainConfig.assets.find((a) => a.symbol === externalSymbol);
    if (!asset) {
      throw new Error(`No asset ${externalSymbol} found in chain ${chainId} configuration`);
    }

    return asset.address;
  }

  /**
   * Find network configuration by chain ID
   * @param networkList - Array of network configurations
   * @param chainId - Target chain ID
   * @returns NetworkConfig or undefined
   */
  private findNetworkByChainId(networkList: NetworkConfig[], chainId: number): NetworkConfig | undefined {
    const binanceNetwork = CHAIN_ID_TO_BINANCE_NETWORK[chainId];
    if (!binanceNetwork) {
      return undefined;
    }

    return networkList.find((network) => network.network === binanceNetwork);
  }

  /**
   * Get token decimals based on Binance symbol
   * @param binanceSymbol - Binance token symbol (e.g., 'ETH', 'USDC', 'USDT')
   * @returns number - Decimal places for the token
   */
  private getTokenDecimals(binanceSymbol: string): number {
    const decimalsMap: Record<string, number> = {
      ETH: 18,
      BTC: 8,
      USDC: 6,
      USDT: 6,
      USDD: 18,
      BUSD: 18,
      DAI: 18,
    };

    return decimalsMap[binanceSymbol] ?? 18; // Default to 18 decimals
  }
}
