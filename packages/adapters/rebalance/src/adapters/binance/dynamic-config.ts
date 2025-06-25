import { parseUnits } from 'viem';
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
} as const;

/**
 * Chain ID to network mapping
 */
const CHAIN_ID_TO_BINANCE_NETWORK = Object.fromEntries(
  Object.entries(BINANCE_NETWORK_TO_CHAIN_ID).map(([network, chainId]) => [chainId, network]),
) as Record<number, string>;

/**
 * Dynamic asset configuration service for Binance adapter
 * Fetches real-time asset configuration from Binance API
 */
export class DynamicAssetConfig {
  constructor(private readonly client: BinanceClient) {}

  /**
   * Get asset mapping for a specific chain and asset address
   * @param chainId - Blockchain chain ID (e.g., 1 for Ethereum)
   * @param onChainAddress - On-chain contract address of the asset
   * @returns Promise<BinanceAssetMapping> - Asset mapping with current fees and limits
   */
  async getAssetMapping(chainId: number, onChainAddress: string): Promise<BinanceAssetMapping> {
    const config = (await this.client.getAssetConfig()) as CoinConfig[];
    return this.buildMappingFromConfig(config, chainId, onChainAddress);
  }

  /**
   * Build BinanceAssetMapping from API configuration
   * @param config - Array of coin configurations from Binance API
   * @param chainId - Target chain ID
   * @param onChainAddress - On-chain asset address
   * @returns BinanceAssetMapping - Formatted asset mapping
   */
  private buildMappingFromConfig(config: CoinConfig[], chainId: number, onChainAddress: string): BinanceAssetMapping {
    // Find the coin by matching contract address or symbol
    const coin = this.findCoinByAddress(config, onChainAddress);
    if (!coin) {
      throw new Error(`No Binance coin found for address ${onChainAddress}`);
    }

    // Find the network configuration for this chain
    const network = this.findNetworkByChainId(coin.networkList, chainId);
    if (!network) {
      throw new Error(
        `Binance does not support ${coin.coin} on chain ${chainId}. ` +
          `Available networks: ${coin.networkList.map((n) => n.network).join(', ')}`,
      );
    }

    // Validate network is enabled
    if (!network.depositEnable || !network.withdrawEnable) {
      throw new Error(
        `${coin.coin} on ${network.network} is currently disabled. ` +
          `Deposit: ${network.depositEnable}, Withdraw: ${network.withdrawEnable}`,
      );
    }

    // Convert decimal strings to wei/smallest units
    const decimals = this.getTokenDecimals(coin.coin);

    return {
      chainId,
      onChainAddress: onChainAddress.toLowerCase(),
      binanceSymbol: coin.coin,
      network: network.network,
      minWithdrawalAmount: parseUnits(network.withdrawMin, decimals).toString(),
      withdrawalFee: parseUnits(network.withdrawFee, decimals).toString(),
      depositConfirmations: network.minConfirm,
    };
  }

  /**
   * Find coin configuration by on-chain address or symbol
   * @param config - Array of coin configurations
   * @param onChainAddress - On-chain contract address
   * @returns CoinConfig or undefined
   */
  private findCoinByAddress(config: CoinConfig[], onChainAddress: string): CoinConfig | undefined {
    const normalizedAddress = onChainAddress.toLowerCase();

    // First try to match by contract address in any network
    for (const coin of config) {
      for (const network of coin.networkList) {
        if (network.contractAddress && network.contractAddress.toLowerCase() === normalizedAddress) {
          return coin;
        }
      }
    }

    // Fallback: match by known addresses for native assets
    const knownAddresses: Record<string, string> = {
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH', // WETH on Ethereum
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'ETH', // WETH on Arbitrum
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', // USDC on Ethereum
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC', // USDC on Arbitrum
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', // USDT on Ethereum
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT', // USDT on Arbitrum
    };

    const symbol = knownAddresses[normalizedAddress];
    if (symbol) {
      return config.find((coin) => coin.coin === symbol);
    }

    return undefined;
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
   * Get token decimals based on symbol
   * @param symbol - Token symbol (e.g., 'ETH', 'USDC', 'USDT')
   * @returns number - Decimal places for the token
   */
  private getTokenDecimals(symbol: string): number {
    const decimalsMap: Record<string, number> = {
      ETH: 18,
      BTC: 8,
      USDC: 6,
      USDT: 6,
      USDD: 18,
      BUSD: 18,
      DAI: 18,
    };

    return decimalsMap[symbol] ?? 18; // Default to 18 decimals
  }
}
