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
) => {
  try {
    let highestLiquidityDomain = 0;
    let amount = 0;
    const tokenAddress = fetchTokenAddress(ticker_hash, origin); // need to add utils fn

    for (const origin in origins) {
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
