import { PostBridgeActionType } from '@mark/core';
import { ProcessingContext } from '../init';
import { rebalanceAaveToken, executeAaveTokenCallbacks, AaveTokenFlowDescriptor } from './aaveTokenRebalancer';

// Ticker hashes from chaindata/everclear.json
const AMANUSDE_TICKER_HASH = '0x66ccba55361fa110a5bbf2242ca4587de7dbe4596f981363a6a87711889904ac';
const USDE_TICKER_HASH = '0x01c5070cf4f26b1dca38a8754c64483958f5dd08799ad2d72067b3ff2985b82c';
const USDC_TICKER_HASH = '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa';

const aManUsdeDescriptor: AaveTokenFlowDescriptor = {
  name: 'aManUSDe',
  aTokenTickerHash: AMANUSDE_TICKER_HASH,
  intermediateTokenTickerHash: USDE_TICKER_HASH,
  sourceTokenTickerHash: USDC_TICKER_HASH,
  bridgeTag: 'stargate-amanusde',
  getConfig: (config) => config.aManUsdeRebalance,
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
  getAavePoolAddress: () => process.env.AMANUSDE_AAVE_POOL_ADDRESS,
  getDexSwapSlippageBps: () => parseInt(process.env.AMANUSDE_DEX_SWAP_SLIPPAGE_BPS ?? '', 10) || 100,
};

export const rebalanceAManUsde = (context: ProcessingContext) => rebalanceAaveToken(context, aManUsdeDescriptor);

export const executeAManUsdeCallbacks = (context: ProcessingContext) =>
  executeAaveTokenCallbacks(context, aManUsdeDescriptor);
