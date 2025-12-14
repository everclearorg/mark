/**
 * TAC (Telegram App Chain) Bridge types and constants
 * Reference: https://raw.githubusercontent.com/connext/chaindata/main/everclear.json
 * TAC SDK Docs: https://docs.tac.build/build/sdk/introduction
 * TAC SDK GitHub: https://github.com/TacBuild/tac-sdk
 */

// ============================================================================
// Chain Configuration
// ============================================================================

// TAC Chain ID (mainnet)
// Reference: https://chainid.network/chain/239/
export const TAC_CHAIN_ID = 239;

// TON does not have an EVM chain ID
// We use the LayerZero endpoint ID for reference
export const TON_LZ_ENDPOINT_ID = 30826;

// ============================================================================
// TAC Contract Addresses (from everclear.json)
// ============================================================================

// TAC Everclear contract
export const TAC_EVERCLEAR_CONTRACT = '0xEFfAB7cCEBF63FbEFB4884964b12259d4374FaAa' as `0x${string}`;

// TAC Gateway contract
export const TAC_GATEWAY_CONTRACT = '0x7B435CCF350DBC773e077410e8FEFcd46A1cDfAA' as `0x${string}`;

// TAC XERC20Module contract
export const TAC_XERC20_MODULE = '0x92dcaf947DB325ac023b105591d76315743883eD' as `0x${string}`;

// USDT token on TAC
// Reference: https://raw.githubusercontent.com/connext/chaindata/main/everclear.json
export const USDT_TAC = '0xAF988C3f7CB2AceAbB15f96b19388a259b6C438f' as `0x${string}`;

// USDT Ticker Hash (consistent across all chains)
export const USDT_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';

// ============================================================================
// TAC RPC Providers
// ============================================================================

export const TAC_RPC_PROVIDERS = ['https://rpc.ankr.com/tac', 'https://rpc.tac.build'];

// ============================================================================
// TON Configuration
// ============================================================================

/**
 * USDT on TON (Tether's official USDT jetton)
 * This is the address where Stargate delivers USDT on TON.
 *
 * @deprecated Use config.ton.assets instead. This constant is kept for reference only.
 * The jetton address should be loaded from config.ton.assets[].jettonAddress
 * to allow for environment-specific configuration.
 */
export const USDT_TON_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

// TON RPC endpoints
export const TON_RPC_ENDPOINTS = ['https://toncenter.com/api/v2/jsonRPC', 'https://ton.drpc.org/rest'];

// TON API endpoints (for advanced operations)
export const TON_API_ENDPOINT = 'https://tonapi.io';

// ============================================================================
// TAC SDK Types
// Reference: https://docs.tac.build/build/sdk/introduction
// ============================================================================

/**
 * TAC SDK Network enum
 */
export enum TacNetwork {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
}

/**
 * TAC SDK simplified operation status
 */
export enum TacOperationStatus {
  PENDING = 'PENDING',
  SUCCESSFUL = 'SUCCESSFUL',
  FAILED = 'FAILED',
  NOT_FOUND = 'OPERATION_ID_NOT_FOUND',
}

/**
 * Asset specification for TAC SDK cross-chain operations
 *
 * Use either:
 * - 'amount': Human-readable amount (e.g., 1.9994) - SDK multiplies by 10^decimals
 * - 'rawAmount': Raw token units (e.g., 1999400 for 1.9994 USDT with 6 decimals)
 */
export interface TacAssetLike {
  address?: string; // Token address (omit for native TON)
  amount?: number | string | bigint; // Human-readable amount
  rawAmount?: bigint; // Raw token units (preferred for precision)
}

/**
 * EVM Proxy Message for TAC SDK
 * Defines the target EVM call details
 *
 * For simple bridging (tokens go directly to evmTargetAddress):
 * - Only set evmTargetAddress (the recipient address)
 * - Omit methodName and encodedParameters
 *
 * For calling a dApp proxy:
 * - Set evmTargetAddress to the TacProxyV1-based contract
 * - Set methodName (just the function name, not full signature)
 * - Set encodedParameters to the ABI-encoded call data
 */
export interface TacEvmProxyMsg {
  evmTargetAddress: string; // Target address on TAC EVM (recipient or proxy)
  methodName?: string; // Method to call (optional for simple bridge)
  encodedParameters?: string; // ABI-encoded parameters (optional for simple bridge)
}

/**
 * Transaction linker returned by TAC SDK
 * Used to track cross-chain operations
 */
export interface TacTransactionLinker {
  caller: string;
  shardCount: number;
  shardsKey: number;
  timestamp: number;
}

/**
 * TAC Bridge supported assets reference table.
 * Maps asset symbols to their addresses on TON and TAC.
 *
 * @deprecated Use config.ton.assets for jetton addresses instead.
 * This constant is kept for reference/documentation purposes only.
 */
export const TAC_BRIDGE_SUPPORTED_ASSETS: Record<string, { ton: string; tac: string; tickerHash: string }> = {
  USDT: {
    ton: USDT_TON_JETTON, // Should come from config.ton.assets[].jettonAddress
    tac: USDT_TAC,
    tickerHash: USDT_TICKER_HASH,
  },
};

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * TAC SDK Configuration
 */
export interface TacSdkConfig {
  network: TacNetwork;
  tonMnemonic?: string; // TON wallet mnemonic for RawSender
  tonPrivateKey?: string; // TON wallet private key (alternative to mnemonic)
  tonRpcUrl?: string; // TON RPC URL (default: toncenter mainnet) - use paid RPC for reliability
  tacRpcUrls?: string[]; // TAC EVM RPC URLs - REQUIRED to avoid rate limits on public endpoints
  apiKey?: string; // API key for paid RPC endpoints
  customSequencerEndpoints?: string[]; // Custom TAC sequencer/data endpoints for reliability
}

/**
 * Retry configuration for TAC SDK operations
 */
export interface TacRetryConfig {
  maxRetries: number; // Maximum number of retry attempts (default: 3)
  baseDelayMs: number; // Base delay in milliseconds (default: 2000)
  maxDelayMs: number; // Maximum delay in milliseconds (default: 30000)
}

/**
 * TON Wallet Configuration
 * Used for server-side TON transaction signing
 */
export interface TonWalletConfig {
  mnemonic?: string;
  privateKey?: string;
  workchain?: number; // 0 for basechain, -1 for masterchain
}
