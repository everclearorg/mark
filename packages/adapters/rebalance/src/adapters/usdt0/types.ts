/**
 * USDT0 Legacy Mesh contract addresses and constants
 *
 * USDT0 is Tether's official omnichain USDT built on LayerZero OFT standard.
 * For TON, it uses the "Legacy Mesh" — a credit/debit pool mechanism that
 * releases canonical USDT (same jetton as EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs)
 * on TON. The pool currently holds ~9.2B USDT.
 *
 * Reference:
 * - USDT0 Docs: https://docs.usdt0.to/
 * - Deployments: https://docs.usdt0.to/api/deployments
 * - Legacy Mesh: https://docs.usdt0.to/overview/the-legacy-mesh
 */

// ============================================================================
// Contract Addresses
// ============================================================================

/**
 * USDT0 Legacy Mesh OFT contract on Ethereum mainnet
 * Used for sending USDT to legacy chains (TON, Tron)
 * Uses credit/debit pool mechanism (not mint/burn)
 */
export const USDT0_LEGACY_MESH_ETH = '0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0' as `0x${string}`;

/**
 * USDT ERC-20 on Ethereum mainnet
 * Must be approved to the Legacy Mesh OFT contract before sending
 */
export const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as `0x${string}`;

// ============================================================================
// LayerZero Endpoint IDs (USDT0-specific)
// ============================================================================

/**
 * TON LayerZero Endpoint ID for USDT0 Legacy Mesh
 * Note: This differs from Stargate's TON endpoint (30826).
 * USDT0 uses its own endpoint for the Legacy Mesh routing.
 */
export const USDT0_LZ_ENDPOINT_TON = 30343;

/**
 * Ethereum LayerZero Endpoint ID
 */
export const USDT0_LZ_ENDPOINT_ETH = 30101;

// ============================================================================
// Fee Constants
// ============================================================================

/**
 * USDT0 Legacy Mesh transfer fee: 0.03% (3 basis points)
 * Used for fee estimation when on-chain quoteOFT is unavailable
 */
export const USDT0_LEGACY_MESH_FEE_BPS = 3n;
