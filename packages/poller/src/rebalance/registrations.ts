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
});
registerRebalancer({
  runMode: 'tacOnly',
  displayName: 'TAC USDT',
  handler: rebalanceTacUsdt,
});
registerRebalancer({
  runMode: 'aManUsdeOnly',
  displayName: 'aManUSDe',
  handler: rebalanceAManUsde,
});
registerRebalancer({
  runMode: 'aMansyrupUsdtOnly',
  displayName: 'aMansyrupUSDT',
  handler: rebalanceAMansyrupUsdt,
});
registerRebalancer({
  runMode: 'solanaUsdcOnly',
  displayName: 'Solana USDC → ptUSDe',
  handler: rebalanceSolanaUsdc,
});
