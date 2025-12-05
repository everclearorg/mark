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

export const TAC_RPC_PROVIDERS = [
  'https://rpc.ankr.com/tac',
  'https://rpc.tac.build',
];

// ============================================================================
// TON Configuration
// ============================================================================

// USDT on TON (Tether's official USDT jetton)
// This is the address where Stargate delivers USDT on TON
export const USDT_TON_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

// TON RPC endpoints
export const TON_RPC_ENDPOINTS = [
  'https://toncenter.com/api/v2/jsonRPC',
  'https://ton.drpc.org/rest',
];

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
 */
export interface TacAssetLike {
  address?: string;  // Token address (omit for native TON)
  amount: number | string | bigint;
}

/**
 * EVM Proxy Message for TAC SDK
 * Defines the target EVM call details
 */
export interface TacEvmProxyMsg {
  evmTargetAddress: string;      // Target contract on TAC EVM
  methodName: string;            // Method to call
  encodedParameters: string;     // ABI-encoded parameters
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
 * TAC Bridge supported assets
 * Maps asset symbols to their addresses on TON and TAC
 */
export const TAC_BRIDGE_SUPPORTED_ASSETS: Record<string, { ton: string; tac: string; tickerHash: string }> = {
  USDT: {
    ton: USDT_TON_JETTON,
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
  tonMnemonic?: string;      // TON wallet mnemonic for RawSender
  tonPrivateKey?: string;    // TON wallet private key (alternative to mnemonic)
}

/**
 * TON Wallet Configuration
 * Used for server-side TON transaction signing
 */
export interface TonWalletConfig {
  mnemonic?: string;
  privateKey?: string;
  workchain?: number;  // 0 for basechain, -1 for masterchain
}
