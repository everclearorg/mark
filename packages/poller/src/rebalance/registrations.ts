import { registerRebalancer } from './registry';
import { rebalanceMantleEth } from './mantleEth';
import { rebalanceTacUsdt } from './tacUsdt';
import { rebalanceAManUsde } from './aManUsde';
import { rebalanceAMansyrupUsdt } from './aMansyrupUsdt';
import { rebalanceSolanaUsdc } from './solanaUsdc';

registerRebalancer({
  runMode: 'methOnly',
  displayName: 'meth',
  handler: rebalanceMantleEth,
  bridgeTags: ['mantle', 'across-mantle'],
});
registerRebalancer({
  runMode: 'tacOnly',
  displayName: 'TAC USDT',
  handler: rebalanceTacUsdt,
  bridgeTags: ['stargate-tac', 'tac-inner'],
});
registerRebalancer({
  runMode: 'aManUsdeOnly',
  displayName: 'aManUSDe',
  handler: rebalanceAManUsde,
  bridgeTags: ['stargate-amanusde'],
});
registerRebalancer({
  runMode: 'aMansyrupUsdtOnly',
  displayName: 'aMansyrupUSDT',
  handler: rebalanceAMansyrupUsdt,
  bridgeTags: ['stargate-amansyrupusdt'],
});
registerRebalancer({
  runMode: 'solanaUsdcOnly',
  displayName: 'Solana USDC → ptUSDe',
  handler: rebalanceSolanaUsdc,
  bridgeTags: ['ccip-solana-mainnet'],
});
