/**
 * Stargate V2 contract addresses and types
 * Reference: https://stargateprotocol.gitbook.io/stargate/v2/deployments
 * API Reference: https://docs.stargate.finance/developers/api-docs/overview
 */

// ============================================================================
// Contract Addresses
// ============================================================================

// Stargate V2 Router contract on Ethereum mainnet
export const STARGATE_ROUTER_ETH = '0xeCc19E177d24551aA7ed6Bc6FE566eCa726CC8a9' as `0x${string}`;

// Stargate USDT Pool on Ethereum mainnet (OFT)
// Reference: https://stargateprotocol.gitbook.io/stargate/v2/deployments
export const STARGATE_USDT_POOL_ETH = '0x933597a323Eb81cAe705C5bC29985172fd5A3973' as `0x${string}`;

// USDT token on Ethereum mainnet
export const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as `0x${string}`;

// ============================================================================
// LayerZero V2 Endpoint IDs
// Reference: https://docs.layerzero.network/v2/deployments/chains
// ============================================================================

export const LZ_ENDPOINT_ID_ETH = 30101;      // Ethereum mainnet
export const LZ_ENDPOINT_ID_TON = 30826;       // TON mainnet

// ============================================================================
// Chain IDs
// ============================================================================

// TAC Chain ID (mainnet)
export const TAC_CHAIN_ID = 239;

// TON does not have an EVM chain ID, we use LayerZero endpoint ID
export const TON_CHAIN_ID = 30826;

// ============================================================================
// Stargate API Configuration
// Reference: https://stargate.finance/api/v1/quotes
// ============================================================================

// Stargate Frontend API - used for quotes and transaction building
export const STARGATE_API_URL = 'https://stargate.finance/api/v1';

/**
 * Stargate API Quote Request
 */
export interface StargateApiQuoteRequest {
  srcChain: string;       // Source chain name (e.g., "ethereum")
  dstChain: string;       // Destination chain name (e.g., "ton")
  srcToken: string;       // Source token address
  dstToken: string;       // Destination token address
  amount: string;         // Amount in wei/smallest unit
  slippage?: number;      // Slippage tolerance in basis points (optional)
}

/**
 * Stargate API Transaction Step
 */
export interface StargateApiTransactionStep {
  type: 'approve' | 'bridge';
  sender: string;
  chainKey: string;
  transaction: {
    data: string;
    to: string;
    from: string;
    value?: string;
  };
}

/**
 * Stargate API Fee
 */
export interface StargateApiFee {
  token: string;
  chainKey: string;
  amount: string;
  type: string;
}

/**
 * Stargate API Quote Response (from /api/v1/quotes)
 * Reference: https://stargate.finance/api/v1/quotes
 */
export interface StargateApiQuoteResponse {
  quotes: Array<{
    route: string | null;
    error: { message: string } | null;
    srcAmount: string;
    dstAmount: string;
    srcAmountMax: string;
    dstAmountMin: string;
    srcToken: string;
    dstToken: string;
    srcAddress: string;
    dstAddress: string;
    srcChainKey: string;
    dstChainKey: string;
    dstNativeAmount: string;
    duration: {
      estimated: number;
    };
    fees: StargateApiFee[];
    steps: StargateApiTransactionStep[];
  }>;
  error?: {
    message: string;
  };
}

/**
 * TON USDT address for Stargate bridging
 * This is the hex-encoded address format used by Stargate API
 */
export const USDT_TON_STARGATE = '0xb113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

/**
 * Chain name mapping for Stargate API
 */
export const STARGATE_CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum',
  30826: 'ton',
  239: 'tac',
};

// ============================================================================
// Contract Types
// ============================================================================

/**
 * SendParam structure for Stargate V2 OFT send
 */
export interface StargateSendParam {
  dstEid: number;                    // Destination endpoint ID
  to: `0x${string}`;                 // Recipient address (bytes32)
  amountLD: bigint;                  // Amount in local decimals
  minAmountLD: bigint;               // Minimum amount after slippage
  extraOptions: `0x${string}`;       // Extra LayerZero options
  composeMsg: `0x${string}`;         // Compose message (empty for simple transfers)
  oftCmd: `0x${string}`;             // OFT command (empty for simple transfers)
}

/**
 * MessagingFee structure returned by quoteSend
 */
export interface StargateMessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

/**
 * MessagingReceipt returned by sendToken
 */
export interface StargateMessagingReceipt {
  guid: `0x${string}`;
  nonce: bigint;
  fee: StargateMessagingFee;
}

/**
 * OFTReceipt returned by send
 */
export interface StargateOftReceipt {
  amountSentLD: bigint;
  amountReceivedLD: bigint;
}

/**
 * Quote response from Stargate contract
 */
export interface StargateQuoteResponse {
  amountReceived: bigint;
  fee: StargateMessagingFee;
}

// ============================================================================
// LayerZero Message Types
// ============================================================================

/**
 * LayerZero message status
 */
export enum LzMessageStatus {
  INFLIGHT = 'INFLIGHT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  PAYLOAD_STORED = 'PAYLOAD_STORED',
  BLOCKED = 'BLOCKED',
}

/**
 * LayerZero scan API response for message status
 */
export interface LzScanMessageResponse {
  status: LzMessageStatus;
  srcTxHash: string;
  dstTxHash?: string;
  srcChainId: number;
  dstChainId: number;
  srcBlockNumber: number;
  dstBlockNumber?: number;
}

// ============================================================================
// TON Address Types
// ============================================================================

/**
 * TON Address representation for Stargate
 * TON uses a different address format than EVM
 */
export interface TonAddressInfo {
  raw: string;           // Raw TON address (workchain:hash format)
  bounceable: string;    // Bounceable base64 address
  nonBounceable: string; // Non-bounceable base64 address
}

/**
 * USDT on TON (Tether's official USDT jetton)
 * This is the address where Stargate delivers USDT on TON.
 * 
 * @deprecated Use config.ton.assets instead. This constant is kept for reference only.
 * The jetton address should be loaded from config.ton.assets[].jettonAddress
 * to allow for environment-specific configuration.
 */
export const USDT_TON_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

/**
 * Convert TON address to bytes32 for LayerZero
 * 
 * TON addresses come in different formats:
 * - Raw: workchain:hash (e.g., "0:abc123...")
 * - Bounceable base64: starts with "EQ" (mainnet) or "kQ" (testnet)
 * - Non-bounceable base64: starts with "UQ" (mainnet) or "0Q" (testnet)
 * 
 * For LayerZero, we need to convert to a 32-byte representation.
 * The TON address hash is already 32 bytes, so we extract and use it.
 */
export function tonAddressToBytes32(tonAddress: string): `0x${string}` {
  // If it's already a hex address (0x prefixed), just pad it
  if (tonAddress.startsWith('0x')) {
    const cleanHex = tonAddress.slice(2).toLowerCase();
    return `0x${cleanHex.padStart(64, '0')}` as `0x${string}`;
  }

  // If it's a raw TON address format (workchain:hash)
  if (tonAddress.includes(':')) {
    const [, hash] = tonAddress.split(':');
    // The hash part is already hex, pad to 32 bytes
    return `0x${hash.toLowerCase().padStart(64, '0')}` as `0x${string}`;
  }

  // If it's a base64 TON address (EQ..., UQ..., kQ..., 0Q...)
  // Decode base64 and extract the address hash (last 32 bytes after removing tag and workchain)
  try {
    // TON base64 addresses use URL-safe base64 encoding
    const base64Standard = tonAddress.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(base64Standard, 'base64');
    
    // TON address format: [1 byte tag][1 byte workchain][32 bytes hash][2 bytes CRC16]
    // Total: 36 bytes. We want the 32-byte hash (bytes 2-33)
    if (decoded.length >= 34) {
      const addressHash = decoded.slice(2, 34);
      return `0x${addressHash.toString('hex').padStart(64, '0')}` as `0x${string}`;
    }
    
    // Fallback: use the entire decoded buffer as hex
    return `0x${decoded.toString('hex').padStart(64, '0')}` as `0x${string}`;
  } catch {
    // If decoding fails, hash the address string as a fallback
    // This should not happen with valid TON addresses
    const hex = Buffer.from(tonAddress, 'utf-8').toString('hex');
    return `0x${hex.padStart(64, '0').slice(0, 64)}` as `0x${string}`;
  }
}

/**
 * Validate if a string looks like a TON address
 */
export function isValidTonAddress(address: string): boolean {
  // Raw format: workchain:hash
  if (address.includes(':')) {
    const parts = address.split(':');
    return parts.length === 2 && /^-?\d+$/.test(parts[0]) && /^[a-fA-F0-9]{64}$/.test(parts[1]);
  }
  
  // Base64 format: EQ/UQ/kQ/0Q followed by 46 chars
  if (/^[EUk0]Q[A-Za-z0-9_-]{46}$/.test(address)) {
    return true;
  }
  
  return false;
}
