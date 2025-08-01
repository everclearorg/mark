import {
  getDecimalsFromConfig,
  getTokenAddressFromConfig,
  MarkConfiguration,
  isSvmChain,
  SOLANA_NATIVE_ASSET_ID,
  AddressFormat,
} from '@mark/core';
import { createClient, getERC20Contract, getHubStorageContract } from './contracts';
import { getAssetHash, getTickers } from './asset';
import { PrometheusAdapter } from '@mark/prometheus';
import { getValidatedZodiacConfig, getActualOwner } from './zodiac';
import { ChainService } from '@mark/chainservice';

/**
 * Returns the gas balance of mark on all chains.
 * @param config Mark configuration
 * @returns Map of native asset balances on all configured chains
 */
export const getMarkGasBalances = async (
  config: MarkConfiguration,
  chainService: ChainService,
  prometheus: PrometheusAdapter,
): Promise<Map<string, bigint>> => {
  const { chains, ownAddress, ownSolAddress } = config;
  const gasBalances = new Map<string, bigint>();

  await Promise.all(
    Object.keys(chains).map(async (chain) => {
      try {
        let balance: bigint;
        if (isSvmChain(chain)) {
          const balanceStr = await chainService.getBalance(+chain, ownSolAddress, SOLANA_NATIVE_ASSET_ID);
          balance = BigInt(balanceStr);
        } else {
          // EVM chain with zodiac logic
          // Get Zodiac configuration for this chain
          const chainConfig = chains[chain];
          const zodiacConfig = getValidatedZodiacConfig(chainConfig);
          const actualOwner = getActualOwner(zodiacConfig, ownAddress);

          const client = createClient(chain, config);
          // NOTE: gas balances are always relevant for the sending EOA only
          balance = await client.getBalance({ address: actualOwner as `0x${string}` });
        }
        gasBalances.set(chain, balance);
        prometheus.updateGasBalance(chain, balance);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        gasBalances.set(chain, 0n);
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
      const format = isSvm ? AddressFormat.Base58 : AddressFormat.Hex;
      const tokenAddr = getTokenAddressFromConfig(ticker, domain, config, format);
      const decimals = getDecimalsFromConfig(ticker, domain, config);

      if (!tokenAddr || !decimals) {
        continue;
      }
      const balancePromise = isSvm
        ? getSvmBalance(config, chainService, domain, tokenAddr, decimals, prometheus)
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
  const { chains, ownAddress } = config;
  const chainConfig = chains[domain];
  try {
    // Get Zodiac configuration for this chain
    const zodiacConfig = getValidatedZodiacConfig(chainConfig);
    const actualOwner = getActualOwner(zodiacConfig, ownAddress);

    const tokenContract = await getERC20Contract(config, domain, tokenAddr as `0x${string}`);
    let balance = (await tokenContract.read.balanceOf([actualOwner as `0x${string}`])) as bigint;

    // Convert USDC balance from 6 decimals to 18 decimals, as hub custodied balances are standardized to 18 decimals
    if (decimals !== 18) {
      const DECIMALS_DIFFERENCE = BigInt(18 - decimals); // Difference between 18 and 6 decimals
      balance = BigInt(balance) * 10n ** DECIMALS_DIFFERENCE;
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
