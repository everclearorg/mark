import { getTokenAddressFromConfig, MarkConfiguration } from '@mark/core';
import { getERC20Contract, getHubStorageContract } from './contracts';
import { getAssetHash, getTickers } from './asset';

export const walletBalance = async (tokenAddress: string, chainId: string, config: MarkConfiguration) => {
  try {
    const tokenContract = await getERC20Contract(config, chainId, tokenAddress as `0x${string}`);
    const balance = await tokenContract.read.balanceOf([config.ownAddress]);
    return balance;
  } catch (err) {
    console.log('Not able to fetch the wallet balance!', err);
  }
};

/**
 * Returns all of the balances for supported assets across all chains.
 * @returns Mapping of balances keyed on tickerhash - chain - amount
 */
export const getMarkBalances = async (config: MarkConfiguration): Promise<Map<string, Map<string, bigint>>> => {
  const { chains, ownAddress } = config;
  const markBalances = new Map<string, Map<string, bigint>>();

  // get all ticker hashes
  const tickers = getTickers(config);
  for (const ticker of tickers) {
    const domainBalances = new Map<string, bigint>();
    for (const domain of Object.keys(chains)) {
      // get asset address
      const tokenAddr = getTokenAddressFromConfig(ticker, domain, config) as `0x${string}`;
      if (!tokenAddr) {
        continue;
      }
      const tokenContract = await getERC20Contract(config, domain, tokenAddr);
      // get balance
      const balance = await tokenContract.read.balanceOf([ownAddress]);
      domainBalances.set(domain, balance as bigint);
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
  for (const ticker of tickers) {
    const domainBalances = new Map<string, bigint>();
    for (const domain of Object.keys(chains)) {
      // get asset hash
      const assetHash = getAssetHash(ticker, domain, config);
      if (!assetHash) {
        // not registered on this domain
        domainBalances.set(domain, 0n);
        continue;
      }
      // get custodied balance
      const custodied = await contract.read.custodiedAssets([assetHash]);
      domainBalances.set(domain, custodied as bigint);
    }
    custodiedBalances.set(ticker, domainBalances);
  }
  return custodiedBalances;
};
