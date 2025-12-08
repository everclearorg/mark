/**
 * Basis points multiplier (10000 = 100%)
 * Used for percentage calculations where 1 basis point = 0.01%
 */
export const BPS_MULTIPLIER = 10000n;

/**
 * Decibasis points multiplier (100000 = 100%)
 * Used for percentage calculations where 1 basis point = 0.001%
 */
export const DBPS_MULTIPLIER = 100000n;

/**
 * Mainnet chain ID
 */
export const MAINNET_CHAIN_ID = '1';

/**
 * Mantle chain ID
 */
export const MANTLE_CHAIN_ID = '5000';

/**
 * TAC (Telegram App Chain) chain ID
 * Reference: https://chainid.network/chain/239/
 */
export const TAC_CHAIN_ID = '239';

/**
 * TON chain ID (LayerZero V2 endpoint ID)
 * Used for Stargate bridging to TON
 */
export const TON_LZ_CHAIN_ID = '30826';

/**
 * USDT ticker hash
 * Reference: https://raw.githubusercontent.com/connext/chaindata/main/everclear.json
 */
export const USDT_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';
