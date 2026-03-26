import { PostBridgeActionType } from '@mark/core';
import { ProcessingContext } from '../init';
import { rebalanceAaveToken, executeAaveTokenCallbacks, AaveTokenFlowDescriptor } from './aaveTokenRebalancer';

// Ticker hashes from chaindata/everclear.json
const AMANSYRUPUSDT_TICKER_HASH = '0x50754231141ed10c02426fd810290fe327a8ea327cf763ea23aa37d0c1baa32e';
const SYRUPUSDT_TICKER_HASH = '0x7bb29d70724bbe7b0958c9fa41e525d57faa30c509988884b3f212b9108edd0e';
const USDC_TICKER_HASH = '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa';

const aMansyrupUsdtDescriptor: AaveTokenFlowDescriptor = {
  name: 'aMansyrupUSDT',
  aTokenTickerHash: AMANSYRUPUSDT_TICKER_HASH,
  intermediateTokenTickerHash: SYRUPUSDT_TICKER_HASH,
  sourceTokenTickerHash: USDC_TICKER_HASH,
  bridgeTag: 'stargate-amansyrupusdt',
  getConfig: (config) => config.aMansyrupUsdtRebalance,
  buildPostBridgeActions: ({ sourceTokenOnMantle, intermediateTokenOnMantle, aavePoolAddress, dexSwapSlippageBps }) => [
    {
      type: PostBridgeActionType.DexSwap as const,
      sellToken: sourceTokenOnMantle,
      buyToken: intermediateTokenOnMantle,
      slippageBps: dexSwapSlippageBps,
    },
    {
      type: PostBridgeActionType.AaveSupply as const,
      poolAddress: aavePoolAddress,
      supplyAsset: intermediateTokenOnMantle,
    },
  ],
  getAavePoolAddress: () => process.env.AMANSYRUPUSDT_AAVE_POOL_ADDRESS,
  getDexSwapSlippageBps: () => parseInt(process.env.AMANSYRUPUSDT_DEX_SWAP_SLIPPAGE_BPS ?? '', 10) || 100,
};

export const rebalanceAMansyrupUsdt = (context: ProcessingContext) =>
  rebalanceAaveToken(context, aMansyrupUsdtDescriptor);

export const executeAMansyrupUsdtCallbacks = (context: ProcessingContext) =>
  executeAaveTokenCallbacks(context, aMansyrupUsdtDescriptor);
