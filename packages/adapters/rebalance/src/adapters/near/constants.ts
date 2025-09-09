export const INTENTS_CONTRACT_ID = 'intents.near';
export const EOA_ADDRESS = '0xBc8988C7a4b77c1d6df7546bd876Ea4D42DF0837';

/**
 * Maps external symbols to Near internal symbols
 */
export const NEAR_IDENTIFIER_MAP = {
  $WIF: {
    101: 'nep141:sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near',
  },
  AAVE: {
    1: 'nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near',
  },
  ABG: {
    1313161554: 'nep141:abg-966.meme-cooking.near',
  },
  AURORA: {
    1: 'nep141:eth-0xaaaaaa20d9e0e2461697782ef11675f668207961.omft.near',
    1313161554: 'nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near',
  },
  ARB: {
    42161: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
  },
  BERA: {
    8888: 'nep141:bera.omft.near',
  },
  BLACKDRAGON: {
    1313161554: 'nep141:blackdragon.tkn.near',
  },
  BOME: {
    101: 'nep141:sol-57d087fd8c460f612f8701f5499ad8b2eec5ab68.omft.near',
  },
  BRRR: {
    1313161554: 'nep141:token.burrow.near',
  },
  BRETT: {
    8453: 'nep141:base-0x532f27101965dd16442e59d40670faf5ebb142e4.omft.near',
  },
  BTC: {
    500: 'nep141:btc.omft.near',
    1313161554: 'nep141:nbtc.bridge.near',
  },
  COW: {
    100: 'nep141:gnosis-0x177127622c4a00f3d409b75571e12cb3c8973d3c.omft.near',
  },
  DAI: {
    1: 'nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near',
  },
  DOGE: {
    3001: 'nep141:doge.omft.near',
  },
  ETH: {
    1: 'nep141:eth.omft.near',
    8453: 'nep141:base.omft.near',
    42161: 'nep141:arb.omft.near',
    1313161554: 'nep141:eth.bridge.near',
  },
  FMS: {
    8453: 'nep141:base-0xa5c67d8d37b88c2d88647814da5578128e2c93b2.omft.near',
  },
  FRAX: {
    1313161554: 'nep141:853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near',
  },
  GNEAR: {
    1313161554: 'nep141:gnear-229.meme-cooking.near',
  },
  GMX: {
    42161: 'nep141:arb-0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a.omft.near',
  },
  GNO: {
    100: 'nep141:gnosis-0x9c58bacc331c9aa871afd802db6379a98e80cedb.omft.near',
  },
  HAPI: {
    1: 'nep141:eth-0xd9c2d319cd7e6177336b0a9c93c21cb48d84fb54.omft.near',
    1313161554: 'nep141:d9c2d319cd7e6177336b0a9c93c21cb48d84fb54.factory.bridge.near',
  },
  KAITO: {
    8453: 'nep141:base-0x98d0baa52b2d063e780de12f615f963fe8537553.omft.near',
  },
  KNC: {
    1: 'nep141:eth-0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202.omft.near',
  },
  LINK: {
    1: 'nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near',
  },
  LOUD: {
    101: 'nep141:sol-bb27241c87aa401cc963c360c175dd7ca7035873.omft.near',
  },
  MELANIA: {
    101: 'nep141:sol-d600e625449a4d9380eaf5e3265e54c90d34e260.omft.near',
  },
  MOG: {
    1: 'nep141:eth-0xaaee1a9723aadb7afa2810263653a34ba2c21c7a.omft.near',
  },
  mpDAO: {
    1313161554: 'nep141:mpdao-token.near',
  },
  NOEAR: {
    1313161554: 'nep141:noear-324.meme-cooking.near',
  },
  PEPE: {
    1: 'nep141:eth-0x6982508145454ce325ddbe47a25d4ec3d2311933.omft.near',
  },
  PURGE: {
    1313161554: 'nep141:purge-558.meme-cooking.near',
  },
  REF: {
    1313161554: 'nep141:token.v2.ref-finance.near',
  },
  SAFE: {
    100: 'nep141:gnosis-0x4d18815d14fe5c3304e87b3fa18318baa5c23820.omft.near',
  },
  SHIB: {
    1: 'nep141:eth-0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce.omft.near',
  },
  SHITZU: {
    1313161554: 'nep141:token.0xshitzu.near',
  },
  SOL: {
    101: 'nep141:sol.omft.near',
  },
  SWEAT: {
    1: 'nep141:eth-0xb4b9dc1c77bdbb135ea907fd5a08094d98883a35.omft.near',
    8453: 'nep141:base-0x227d920e20ebac8a40e7d6431b7d724bb64d7245.omft.near',
    42161: 'nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near',
    1313161554: 'nep141:token.sweat',
  },
  TESTNEBULA: {
    1313161554: 'nep141:test-token.highdome3013.near',
  },
  TRUMP: {
    101: 'nep141:sol-c58e6539c2f2e097c251f8edf11f9c03e581f8d4.omft.near',
  },
  TRX: {
    728126428: 'nep141:tron.omft.near',
  },
  TURBO: {
    1: 'nep141:eth-0xa35923162c49cf95e6bf26623385eb431ad920d3.omft.near',
    101: 'nep141:sol-df27d7abcc1c656d4ac3b1399bbfbba1994e6d8c.omft.near',
    1313161554: 'nep141:a35923162c49cf95e6bf26623385eb431ad920d3.factory.bridge.near',
  },
  UNI: {
    1: 'nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near',
  },
  USDC: {
    1: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    8453: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    42161: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    10: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
    43114: 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o',
    1399811149: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', // Everclear Solana domain
    100: 'nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near',
    1313161554: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  },
  USDT: {
    1: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
    42161: 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near',
    10: 'nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo',
    43114: 'nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp',
    1399811149: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near', // Everclear Solana domain
    728126428: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
    1313161554: 'nep141:usdt.tether-token.near',
  },
  USD1: {
    1: 'nep141:eth-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d.omft.near',
  },
  USDf: {
    1: 'nep141:eth-0xfa2b947eec368f42195f24f36d2af29f7c24cec2.omft.near',
  },
  wBTC: {
    1313161554: 'nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near',
  },
  WETH: {
    1: 'nep141:eth.omft.near',
    8453: 'nep141:base.omft.near',
    42161: 'nep141:arb.omft.near',
    1313161554: 'nep141:eth.bridge.near',
  },
  wNEAR: {
    1313161554: 'nep141:wrap.near',
  },
  xBTC: {
    101: 'nep141:sol-91914f13d3b54f8126a2824d71632d4b078d7403.omft.near',
  },
  xDAI: {
    100: 'nep141:gnosis.omft.near',
  },
} as const;
