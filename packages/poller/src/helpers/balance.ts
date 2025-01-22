import { getERC20Contract } from './contracts';
import { MarkConfiguration } from '@mark/core';

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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const getMarkBalances = async (config: MarkConfiguration): Promise<Map<string, Map<string, bigint>>> => {
  // const { chains, supportedAssets } = config;
  throw new Error(`not implemented - getMarkBalances`);
};

/**
 * Returns all of the custodied amounts for supported assets across all chains
 * @returns Mapping of balances keyed on tickerhash - chain - amount
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const getCustodiedBalances = async (config: MarkConfiguration): Promise<Map<string, Map<string, bigint>>> => {
  // const { chains, supportedAssets } = config;
  throw new Error(`not implemented - getCustodiedBalances`);
};
