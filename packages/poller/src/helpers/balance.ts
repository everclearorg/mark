import { getDecimalsFromConfig, getTokenAddressFromConfig, MarkConfiguration } from '@mark/core';
import { createClient, getERC20Contract, getHubStorageContract } from './contracts';
import { getAssetHash, getTickers } from './asset';
import { PrometheusAdapter } from '@mark/prometheus';

/**
 * Returns the gas balance of mark on all chains.
 * @param config Mark configuration
 * @returns Map of native asset balances on all configured chains
 */
export const getMarkGasBalances = async (
  config: MarkConfiguration,
  prometheus: PrometheusAdapter,
): Promise<Map<string, bigint>> => {
  const { chains, ownAddress } = config;
  const markBalances = new Map<string, bigint>();

  await Promise.all(
    Object.keys(chains).map(async (chain) => {
      try {
        const client = createClient(chain, config);
        const native = await client.getBalance({ address: ownAddress as `0x${string}` });
        markBalances.set(chain, native);
        prometheus.updateGasBalance(chain, native);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        markBalances.set(chain, 0n);
      }
    }),
  );
  return markBalances;
};

/**
 * Returns all of the balances for supported assets across all chains.
 * @returns Mapping of balances keyed on tickerhash - chain - amount in 18 decimal units
 */
export const getMarkBalances = async (
  config: MarkConfiguration,
  prometheus: PrometheusAdapter,
): Promise<Map<string, Map<string, bigint>>> => {
  const { chains, ownAddress } = config;
  const markBalances = new Map<string, Map<string, bigint>>();

  // get all ticker hashes
  const tickers = getTickers(config);
  for (const ticker of tickers) {
    const domainBalances = new Map<string, bigint>();
    for (const domain of Object.keys(chains)) {
      try {
        // get asset address
        const tokenAddr = getTokenAddressFromConfig(ticker, domain, config) as `0x${string}`;
        // get decimals
        const decimals = getDecimalsFromConfig(ticker, domain, config);
        if (!tokenAddr || !decimals) {
          continue;
        }
        const tokenContract = await getERC20Contract(config, domain, tokenAddr);
        // get balance
        let balance = (await tokenContract.read.balanceOf([ownAddress])) as bigint;

        // Convert USDC balance from 6 decimals to 18 decimals, as hub custodied balances are standardized to 18 decimals
        if (decimals !== 18) {
          const DECIMALS_DIFFERENCE = BigInt(18 - decimals); // Difference between 18 and 6 decimals
          balance = BigInt(balance) * 10n ** DECIMALS_DIFFERENCE;
        }
        domainBalances.set(domain, balance);
        // Update tracker
        prometheus.updateChainBalance(domain, tokenAddr, balance);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        domainBalances.set(domain, 0n); // Set zero balance on error
      }
    }
    markBalances.set(ticker, domainBalances);
  }
  return markBalances;
};

/**
 * Returns all of the custodied amounts for supported assets across all chains
 * @returns Mapping of balances keyed on tickerhash - chain - amount
 */
export const getCustodiedBalances = async (config: MarkConfiguration): Promise<Map<string, Map<string, bigint>>> => {
  const { chains } = config;
  const custodiedBalances = new Map<string, Map<string, bigint>>();

  // get hub contract
  const contract = getHubStorageContract(config);

  // get all ticker hashes
  const tickers = getTickers(config);

  if (!tickers || tickers.length === 0) {
    return custodiedBalances; // Return the empty map immediately
  }

  for (const ticker of tickers) {
    const domainBalances = new Map<string, bigint>();
    for (const domain of Object.keys(chains)) {
      try {
        // get asset hash
        const assetHash = getAssetHash(ticker, domain, config, getTokenAddressFromConfig);
        if (!assetHash) {
          // not registered on this domain
          domainBalances.set(domain, 0n);
          continue;
        }
        // get custodied balance
        const custodied = await contract.read.custodiedAssets([assetHash]);
        domainBalances.set(domain, custodied as bigint);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        domainBalances.set(domain, 0n); // Set zero balance on error
      }
    }
    custodiedBalances.set(ticker, domainBalances);
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
