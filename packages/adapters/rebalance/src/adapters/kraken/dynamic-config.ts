import { Chain } from 'viem';
import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import * as chains from 'viem/chains';

import { KrakenClient } from './client';
import { KrakenAssetMapping, KrakenDepositMethod, KrakenWithdrawMethod } from './types';

/**
 * USDC and USDC.e have different deposit and withdraw methods. Neither the asset configuration, nor
 * onchain symbol checks, can be used to verify if the config contains USDC or USDC.e
 */
const USDC_ADDRESSES: Record<number, Record<string, string>> = {
  10: {
    ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'.toLowerCase()]: 'usdc',
    ['0x7F5c764cBc14f9669B88837ca1490cCa17c31607'.toLowerCase()]: 'usdc.e',
  },
  137: {
    ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'.toLowerCase()]: 'usdc',
    ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'.toLowerCase()]: 'usdc.e',
  },
  42161: {
    ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLowerCase()]: 'usdc',
    ['0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'.toLowerCase()]: 'usdc.e',
  },
};

/**
 * Network mapping from Kraken method identifiers to chain IDs. Kraken method
 * identifiers are included in the deposit / withdraw method strings. They are _generally_
 * just the network name.
 */
const KRAKEN_DEPOSIT_METHOD_TO_CHAIN_ID_OVERRIDES = {
  Hex: 1,
} as const;

/**
 * Chain ID to method mapping
 */
const CHAIN_ID_TO_KRAKEN_DEPOSIT_METHOD_OVERRIDES = Object.fromEntries(
  Object.entries(KRAKEN_DEPOSIT_METHOD_TO_CHAIN_ID_OVERRIDES).map(([method, chainId]) => [chainId, method]),
) as Record<number, string>;

/**
 * Maps external symbols to Kraken internal symbols
 */
const EXTERNAL_TO_KRAKEN_SYMBOL = {
  WETH: 'ETH', // External WETH -> Kraken ETH
  ETH: 'ETH',
  USDC: 'USDC',
  USDT: 'USDT',
  WBTC: 'WBTC',
} as const;

/**
 * Maps Kraken symbols to their asset keys
 */
const KRAKEN_SYMBOL_TO_ASSET = {
  ETH: 'XETH',
  WETH: 'WETH',
  USDC: 'USDC',
  USDT: 'USDT',
  WBTC: 'WBTC',
} as const;

/**
 * Dynamic asset configuration service for Kraken adapter
 * Fetches real-time asset configuration from Kraken API using clean interface
 */
export class DynamicAssetConfig {
  constructor(
    private readonly client: KrakenClient,
    private readonly chains: Record<string, ChainConfiguration>,
    private readonly logger: Logger,
  ) {}

  /**
   * Get asset mapping for a specific chain and asset address or symbol
   * @param chainId - Blockchain chain ID (e.g., 1 for Ethereum)
   * @param assetIdentifier - On-chain contract address OR external symbol (e.g., 'WETH', 'USDC')
   * @returns Promise<KrakenAssetMapping> - Asset mapping with current fees and limits
   */
  async getAssetMapping(chainId: number, assetIdentifier: string): Promise<KrakenAssetMapping> {
    // Determine if it's an address or symbol
    const symbol = this.resolveAssetSymbol(assetIdentifier, chainId);
    const krakenSymbol = this.getKrakenSymbol(symbol);
    const krakenAsset = this.getKrakenAsset(krakenSymbol);

    return this.buildMapping(chainId, symbol, krakenSymbol, krakenAsset);
  }

  /**
   * Resolve asset identifier to external symbol
   * @param assetIdentifier - Contract address or symbol
   * @param chainId - Chain ID for address lookup
   * @returns External symbol (e.g., 'WETH', 'USDC')
   */
  private resolveAssetSymbol(assetIdentifier: string, chainId: number): string {
    // If it's already a known symbol, return it
    if (assetIdentifier in EXTERNAL_TO_KRAKEN_SYMBOL) {
      return assetIdentifier;
    }

    // If it's an address, look it up in chain configurations
    if (assetIdentifier.startsWith('0x')) {
      const normalizedAddress = assetIdentifier.toLowerCase();
      const chainConfig = this.chains[chainId.toString()];

      if (chainConfig) {
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
   * Get Kraken internal symbol from external symbol
   * @param externalSymbol - External symbol (e.g., 'WETH')
   * @returns Kraken symbol (e.g., 'ETH')
   */
  private getKrakenSymbol(externalSymbol: string): string {
    const krakenSymbol = EXTERNAL_TO_KRAKEN_SYMBOL[externalSymbol as keyof typeof EXTERNAL_TO_KRAKEN_SYMBOL];
    if (!krakenSymbol) {
      throw new Error(`No Kraken symbol mapping for: ${externalSymbol}`);
    }
    return krakenSymbol;
  }

  /**
   * Get Kraken asset key from symbol
   * @param krakenSymbol - Kraken symbol (e.g., 'ETH')
   * @returns Kraken asset key (e.g., 'XETH')
   */
  private getKrakenAsset(krakenSymbol: string): string {
    const krakenAsset = KRAKEN_SYMBOL_TO_ASSET[krakenSymbol as keyof typeof KRAKEN_SYMBOL_TO_ASSET];
    if (!krakenAsset) {
      throw new Error(`No Kraken asset mapping for symbol: ${krakenSymbol}`);
    }
    return krakenAsset;
  }

  /**
   * Build mapping for a specific asset and chain
   * @param chainId - Target chain ID
   * @param externalSymbol - External symbol (e.g., 'WETH')
   * @param krakenSymbol - Kraken symbol (e.g., 'ETH')
   * @param krakenAsset - Kraken asset key (e.g., 'XETH')
   * @returns KrakenAssetMapping - Formatted asset mapping
   */
  private async buildMapping(
    chainId: number,
    externalSymbol: string,
    krakenSymbol: string,
    krakenAsset: string,
  ): Promise<KrakenAssetMapping> {
    // Get asset info from config for origin and destination
    const assetInfo = (this.chains[chainId]?.assets ?? []).find(
      (a) => a.symbol.toLowerCase() === externalSymbol.toLowerCase(),
    );
    if (!assetInfo) {
      throw new Error(`No configured asset information for ${externalSymbol} on ${chainId}`);
    }

    // Get available deposit methods for this asset
    const depositMethods = await this.client.getDepositMethods(krakenAsset);

    // Find the method that matches our target chain
    const depositMethod = await this.findMethodByChainId(depositMethods, chainId, assetInfo);
    if (!depositMethod) {
      throw new Error(
        `Kraken does not support deposits of ${externalSymbol} on chain ${chainId}. ` +
          `Available methods: ${depositMethods.map((m) => m.method).join(', ')}`,
      );
    }

    // Find the withdraw method that matches our target chain
    const withdrawMethods = await this.client.getWithdrawMethods(krakenAsset);
    const withdrawMethod = await this.findMethodByChainId(withdrawMethods, chainId, assetInfo);
    if (!withdrawMethod) {
      throw new Error(
        `Kraken does not support withdrawals of ${externalSymbol} on chain ${chainId}. ` +
          `Available methods: ${withdrawMethods.map((m) => m.method).join(', ')}`,
      );
    }

    return {
      network: depositMethod.method,
      chainId,
      krakenAsset,
      krakenSymbol,
      depositMethod,
      withdrawMethod,
    };
  }

  private getNetwork(chainId: number): Chain | undefined {
    // Turn the named exports into a list of Chain objects
    const allChains = Object.values(chains) as Chain[];
    const viemEntry = allChains.find((c) => c.id === chainId);

    // Manual edits to translate viem chain names -> kraken chain names
    if (chainId !== 10) {
      return viemEntry;
    }
    return { ...viemEntry!, name: 'optimism' };
  }

  /**
   * Find deposit method by chain ID
   * @param depositMethods - Array of deposit methods
   * @param chainId - Target chain ID
   * @returns KrakenDepositMethod or undefined
   */
  private async findMethodByChainId<T extends KrakenDepositMethod | KrakenWithdrawMethod = KrakenDepositMethod>(
    methods: T[],
    chainId: number,
    assetInfo: AssetConfiguration,
  ): Promise<T | undefined> {
    // Try to find exact method match first

    // Get network nickname and kraken override
    // NOTE: deposits of ETH to L1 use the `Hex` identifier in their L1 method
    const depositOverrideNetwork = CHAIN_ID_TO_KRAKEN_DEPOSIT_METHOD_OVERRIDES[chainId]?.toLowerCase();
    const network = this.getNetwork(chainId)?.name?.toLowerCase();

    // Find the correct token symbol for the asset and chain
    const symbol = (USDC_ADDRESSES[chainId] ?? {})[assetInfo.address.toLowerCase()] ?? assetInfo.symbol;

    // Find the matching method(s)
    const matched = methods.filter((method) => {
      // Check if its withdraw or deposit method
      const isWithdraw = !!(method as unknown as { network: string })?.network;
      if (isWithdraw) {
        const m = method as KrakenWithdrawMethod;
        // Could match with symbol + network or just network. Try symbol + network (ie. USDC.e vs USDC)
        return m.network.toLowerCase().includes(network!);
      }
      // Use deposits with overrides
      const overridden = method.method.toLowerCase().includes(depositOverrideNetwork);
      if (overridden) {
        return overridden;
      }
      // Fallback to the network on deposit
      return network ? method.method.toLowerCase().includes(network) : undefined;
    });
    if (matched.length === 1) {
      return matched[0];
    }
    return matched.find((m) => ((m as KrakenWithdrawMethod).network ?? m.method).toLowerCase().includes(symbol));
  }
}
