import { getERC20Contract } from './contracts';
import { fetchTokenAddress, MarkConfiguration } from '@mark/core';

export const walletBalance = async (tokenAddress: string, chainId: string, config: MarkConfiguration) => {
  try {
    const tokenContract = await getERC20Contract(config, chainId, tokenAddress as `0x${string}`);
    const balance = await tokenContract.read.balanceOf([config.ownAddress]);
    return balance;
  } catch (err) {
    console.log('Not able to fetch the wallet balance!');
  }
};

export const markHighestLiquidityBalance = async (
  ticker_hash: string,
  origins: string[],
  config: MarkConfiguration,
  getTokenAddressFn: (ticker_hash: string, origin: string) => Promise<string> | string,
) => {
  try {
    let highestLiquidityDomain = 0;
    let amount = 0;

    for (const origin of origins) {
      const tokenAddress = await getTokenAddressFn(ticker_hash, origin);
      const tokenContract = await getERC20Contract(config, origin, tokenAddress as `0x${string}`);
      const balance = (await tokenContract.read.balanceOf()) as number;
      if (balance > amount) {
        amount = balance;
        highestLiquidityDomain = +origin;
      }
    }

    return highestLiquidityDomain;
  } catch (err) {
    console.log('Not able to fetch the wallet balance!');
    return 0;
  }
};
