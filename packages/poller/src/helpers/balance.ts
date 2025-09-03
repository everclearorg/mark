import {
  getDecimalsFromConfig,
  getTokenAddressFromConfig,
  MarkConfiguration,
  isSvmChain,
  isTvmChain,
  SOLANA_NATIVE_ASSET_ID,
  AddressFormat,
  GasType,
} from '@mark/core';
import { createClient, getERC20Contract, getHubStorageContract } from './contracts';
import { getAssetHash, getTickers, convertTo18Decimals } from './asset';
import { PrometheusAdapter } from '@mark/prometheus';
import { ChainService } from '@mark/chainservice';
import { TronWeb } from 'tronweb';

/**
 * Returns the gas balance of mark on all chains.
 * @param config Mark configuration
 * @param chainService ChainService instance
 * @param prometheus PrometheusAdapter instance
 * @param tronWeb Optional TronWeb instance for Tron chain
 * @returns Map of gas balances keyed by objects with chainId and gasType
 */
export const getMarkGasBalances = async (
  config: MarkConfiguration,
  chainService: ChainService,
  prometheus: PrometheusAdapter,
  tronWeb?: TronWeb,
): Promise<Map<{ chainId: string; gasType: GasType }, bigint>> => {
  const { chains, ownAddress, ownSolAddress } = config;
  const gasBalances = new Map<{ chainId: string; gasType: GasType }, bigint>();

  await Promise.all(
    Object.keys(chains).map(async (chain) => {
      try {
        if (isTvmChain(chain)) {
          // For Tron, get both bandwidth and energy
          if (!tronWeb) throw new Error('TronWeb instance required for Tron chain');
          const addresses = await chainService.getAddress();
          const resources = await tronWeb.trx.getAccountResources(addresses[chain] ?? ownAddress);
          // Bandwidth: freeNetLimit - freeNetUsed + NetLimit - NetUsed
          const freeNet = (resources.freeNetLimit ?? 0) - (resources.freeNetUsed ?? 0);
          const stakedNet = (resources.NetLimit ?? 0) - (resources.NetUsed ?? 0);
          const bandwidth = BigInt(Math.max(0, freeNet + stakedNet));
          gasBalances.set({ chainId: chain, gasType: GasType.Bandwidth }, bandwidth);
          prometheus.updateGasBalance(`${chain}:bandwidth`, bandwidth);
          // Energy: EnergyLimit - EnergyUsed
          const energy = BigInt(Math.max(0, (resources.EnergyLimit ?? 0) - (resources.EnergyUsed ?? 0)));
          gasBalances.set({ chainId: chain, gasType: GasType.Energy }, energy);
          prometheus.updateGasBalance(`${chain}:energy`, energy);
        } else if (isSvmChain(chain)) {
          const balanceStr = await chainService.getBalance(+chain, ownSolAddress, SOLANA_NATIVE_ASSET_ID);
          const balance = BigInt(balanceStr);
          gasBalances.set({ chainId: chain, gasType: GasType.Gas }, balance);
          prometheus.updateGasBalance(chain, balance);
        } else {
          // EVM chain
          const client = createClient(chain, config);
          const balance = await client.getBalance({ address: ownAddress as `0x${string}` });
          gasBalances.set({ chainId: chain, gasType: GasType.Gas }, balance);
          prometheus.updateGasBalance(chain, balance);
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        if (isTvmChain(chain)) {
          gasBalances.set({ chainId: chain, gasType: GasType.Bandwidth }, 0n);
          gasBalances.set({ chainId: chain, gasType: GasType.Energy }, 0n);
        } else {
          gasBalances.set({ chainId: chain, gasType: GasType.Gas }, 0n);
        }
      }
    }),
  );
  return gasBalances;
};

/**
 * Returns all of the balances for supported assets across all chains.
 * @returns Mapping of balances keyed on tickerhash - chain - amount in 18 decimal units
 */
export const getMarkBalances = async (
  config: MarkConfiguration,
  chainService: ChainService,
  prometheus: PrometheusAdapter,
): Promise<Map<string, Map<string, bigint>>> => {
  const { chains } = config;
  const tickers = getTickers(config);

  const balancePromises: Array<{
    ticker: string;
    domain: string;
    promise: Promise<bigint>;
  }> = [];

  for (const ticker of tickers) {
    for (const domain of Object.keys(chains)) {
      const isSvm = isSvmChain(domain);
      const isTvm = isTvmChain(domain);
      const format = isSvm ? AddressFormat.Base58 : AddressFormat.Hex;
      const tokenAddr = getTokenAddressFromConfig(ticker, domain, config, format);
      const decimals = getDecimalsFromConfig(ticker, domain, config);

      if (!tokenAddr || !decimals) {
        continue;
      }
      const balancePromise = isSvm
        ? getSvmBalance(config, chainService, domain, tokenAddr, decimals, prometheus)
        : isTvm
          ? getTvmBalance(chainService, domain, tokenAddr, decimals, prometheus)
          : getEvmBalance(config, domain, tokenAddr, decimals, prometheus);

      balancePromises.push({
        ticker,
        domain,
        promise: balancePromise,
      });
    }
  }

  const results = await Promise.allSettled(balancePromises.map((p) => p.promise));
  const markBalances = new Map<string, Map<string, bigint>>();

  for (let i = 0; i < balancePromises.length; i++) {
    const { ticker, domain } = balancePromises[i];
    const result = results[i];

    if (!markBalances.has(ticker)) {
      markBalances.set(ticker, new Map());
    }

    const balance = result.status === 'fulfilled' ? result.value : 0n;
    markBalances.get(ticker)!.set(domain, balance);
  }

  return markBalances;
};

const getSvmBalance = async (
  config: MarkConfiguration,
  chainService: ChainService,
  domain: string,
  tokenAddr: string,
  decimals: number,
  prometheus: PrometheusAdapter,
): Promise<bigint> => {
  const { ownSolAddress } = config;
  try {
    const balanceStr = await chainService.getBalance(+domain, ownSolAddress, tokenAddr);
    let balance = BigInt(balanceStr);

    // Convert balance to standardized 18 decimals
    if (decimals !== 18) {
      balance = convertTo18Decimals(balance, decimals);
    }

    // Update tracker (this is async but we don't need to wait)
    prometheus.updateChainBalance(domain, tokenAddr, balance);
    return balance;
  } catch {
    return 0n; // Return 0 balance on error
  }
};

const getTvmBalance = async (
  chainService: ChainService,
  domain: string,
  tokenAddr: string,
  decimals: number,
  prometheus: PrometheusAdapter,
): Promise<bigint> => {
  try {
    const addresses = await chainService.getAddress();
    const balanceStr = await chainService.getBalance(+domain, addresses[domain], tokenAddr);
    let balance = BigInt(balanceStr);

    // Convert USDC balance from 6 decimals to 18 decimals, as hub custodied balances are standardized to 18 decimals
    if (decimals !== 18) {
      const DECIMALS_DIFFERENCE = BigInt(18 - decimals); // Difference between 18 and 6 decimals
      balance = balance * 10n ** DECIMALS_DIFFERENCE;
    }

    // Update tracker (this is async but we don't need to wait)
    prometheus.updateChainBalance(domain, tokenAddr, balance);
    return balance;
  } catch {
    return 0n; // Return 0 balance on error
  }
};

// TODO: make getEvmBalance get from chainService instead of viem call
const getEvmBalance = async (
  config: MarkConfiguration,
  domain: string,
  tokenAddr: string,
  decimals: number,
  prometheus: PrometheusAdapter,
): Promise<bigint> => {
  const { ownAddress } = config;
  try {
    const tokenContract = await getERC20Contract(config, domain, tokenAddr as `0x${string}`);
    let balance = (await tokenContract.read.balanceOf([ownAddress as `0x${string}`])) as bigint;

    // Convert balance to standardized 18 decimals
    if (decimals !== 18) {
      balance = convertTo18Decimals(balance, decimals);
    }

    // Update tracker (this is async but we don't need to wait)
    prometheus.updateChainBalance(domain, tokenAddr, balance);
    return balance;
  } catch {
    return 0n; // Return 0 balance on error
  }
};

/**
 * Returns all of the custodied amounts for supported assets across all chains
 * @returns Mapping of balances keyed on tickerhash - chain - amount
 */
export const getCustodiedBalances = async (config: MarkConfiguration): Promise<Map<string, Map<string, bigint>>> => {
  const { chains } = config;
  const tickers = getTickers(config);

  if (!tickers || tickers.length === 0) {
    return new Map(); // Return empty map immediately
  }

  // Build list of valid ticker-domain combos to avoid unnecessary fetches
  const tickerDomainPairs: Array<{ ticker: string; domain: string }> = [];
  for (const ticker of tickers) {
    for (const domain of Object.keys(chains)) {
      const tokenAddr = getTokenAddressFromConfig(ticker, domain, config);
      if (tokenAddr) {
        tickerDomainPairs.push({ ticker, domain });
      }
    }
  }

  // get hub contract
  const contract = getHubStorageContract(config);
  const custodiedBalances = new Map<string, Map<string, bigint>>();

  const promises = tickerDomainPairs.map(async ({ ticker, domain }) => {
    try {
      const assetHash = getAssetHash(ticker, domain, config, getTokenAddressFromConfig);
      if (!assetHash) {
        return { ticker, domain, balance: 0n };
      }
      const custodied = await contract.read.custodiedAssets([assetHash]);
      return { ticker, domain, balance: custodied as bigint };
    } catch {
      return { ticker, domain, balance: 0n };
    }
  });

  const results = await Promise.allSettled(promises);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const { ticker, domain } = tickerDomainPairs[i];

    if (!custodiedBalances.has(ticker)) {
      custodiedBalances.set(ticker, new Map());
    }

    const balance = result.status === 'fulfilled' ? result.value.balance : 0n;
    custodiedBalances.get(ticker)!.set(domain, balance);
  }

  return custodiedBalances;
};

export const safeStringToBigInt = (value: string, scaleFactor: bigint): bigint => {
  if (!value || value === '0' || value === '0.0') {
    return 0n;
  }

  if (value.includes('.')) {
    const [intPart, decimalPart] = value.split('.');
    const digits = scaleFactor.toString().length - 1;
    const paddedDecimal = decimalPart.slice(0, digits).padEnd(digits, '0');
    const integerValue = intPart || '0';
    return BigInt(`${integerValue}${paddedDecimal}`);
  }

  return BigInt(value) * scaleFactor;
};
