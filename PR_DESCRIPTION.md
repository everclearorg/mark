# PR Description: `pendle-ptsusde` Branch

## Overview

This branch introduces a **multi-leg rebalancing system for Solana USDC → ptUSDe** and adds two new bridge adapters: **CCIP (Chainlink Cross-Chain Interoperability Protocol)** and **Pendle**. The implementation enables sophisticated cross-chain asset management by bridging USDC from Solana, swapping to ptUSDe (Pendle's Principal Token for USDe), and bridging the ptUSDe back to Solana.

---

## Summary of Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/adapters/rebalance/src/adapters/ccip/ccip.ts` | **NEW** | CCIP bridge adapter implementation |
| `packages/adapters/rebalance/src/adapters/ccip/types.ts` | **NEW** | CCIP types, chain selectors, router addresses |
| `packages/adapters/rebalance/src/adapters/ccip/index.ts` | **NEW** | CCIP adapter exports |
| `packages/adapters/rebalance/src/adapters/pendle/pendle.ts` | **NEW** | Pendle swap adapter implementation |
| `packages/adapters/rebalance/src/adapters/pendle/types.ts` | **NEW** | Pendle types and USDC/ptUSDe pairs |
| `packages/adapters/rebalance/src/adapters/pendle/index.ts` | **NEW** | Pendle adapter exports |
| `packages/adapters/rebalance/src/adapters/index.ts` | **MODIFIED** | Register new CCIP and Pendle adapters |
| `packages/core/src/types/config.ts` | **MODIFIED** | Add `Pendle` and `CCIP` to `SupportedBridge` enum |
| `packages/poller/src/rebalance/solanaUsdc.ts` | **NEW** | 3-leg Solana USDC rebalancing orchestration |
| `packages/poller/package.json` | **MODIFIED** | Add `@chainlink/ccip-js` and `bs58` dependencies |
| `yarn.lock` | **MODIFIED** | Lock file updates for new dependencies |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        SOLANA USDC → ptUSDe REBALANCING                         │
└─────────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────────────┐
                              │     Solana Chain     │
                              │   ┌──────────────┐   │
                              │   │   Solver     │   │
                              │   │   Wallet     │   │
                              │   │  (USDC SPL)  │   │
                              │   └──────┬───────┘   │
                              └──────────┼───────────┘
                                         │
                        ╔════════════════╧════════════════╗
                        ║          LEG 1: CCIP             ║
                        ║    Solana → Ethereum Mainnet     ║
                        ║       (~20 min finality)         ║
                        ╚════════════════╤════════════════╝
                                         │
                              ┌──────────▼───────────┐
                              │   Ethereum Mainnet   │
                              │   ┌──────────────┐   │
                              │   │   Solver     │   │
                              │   │   Wallet     │   │
                              │   │    (USDC)    │   │
                              │   └──────┬───────┘   │
                              └──────────┼───────────┘
                                         │
                        ╔════════════════╧════════════════╗
                        ║          LEG 2: PENDLE           ║
                        ║      USDC → ptUSDe (Same Chain)  ║
                        ║        via Pendle Convert API    ║
                        ╚════════════════╤════════════════╝
                                         │
                              ┌──────────▼───────────┐
                              │   Ethereum Mainnet   │
                              │   ┌──────────────┐   │
                              │   │   Solver     │   │
                              │   │   Wallet     │   │
                              │   │   (ptUSDe)   │   │
                              │   └──────┬───────┘   │
                              └──────────┼───────────┘
                                         │
                        ╔════════════════╧════════════════╗
                        ║          LEG 3: CCIP             ║
                        ║   Ethereum Mainnet → Solana      ║
                        ║       (~20 min finality)         ║
                        ╚════════════════╤════════════════╝
                                         │
                              ┌──────────▼───────────┐
                              │     Solana Chain     │
                              │   ┌──────────────┐   │
                              │   │   Solver     │   │
                              │   │   Wallet     │   │
                              │   │   (ptUSDe)   │   │
                              │   └──────────────┘   │
                              └──────────────────────┘
```

---

## Flow Chart: Rebalancing Process

```
┌─────────────────────────────────────────────────────────────────────┐
│                    rebalanceSolanaUsdc() Entry Point                │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │ Execute pending callbacks     │
                    │ (executeSolanaUsdcCallbacks)  │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │     Check if paused?          │
                    └───────────────┬───────────────┘
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                     YES │                     │ NO
                         ▼                     ▼
                    ┌─────────┐      ┌─────────────────────┐
                    │ RETURN  │      │ Get Solana ptUSDe   │
                    │  EMPTY  │      │ balance (threshold) │
                    └─────────┘      └──────────┬──────────┘
                                               │
                                               ▼
                                 ┌─────────────────────────┐
                                 │ Get Solana USDC balance │
                                 │   (available to bridge) │
                                 └──────────┬──────────────┘
                                            │
                                            ▼
                                 ┌──────────────────────────┐
                                 │ Fetch settled intents    │
                                 │   destined for Solana    │
                                 │   with USDC ticker       │
                                 └──────────┬───────────────┘
                                            │
                          ┌─────────────────┴─────────────────┐
                          │       FOR EACH INTENT             │
                          └─────────────────┬─────────────────┘
                                            │
                                            ▼
                          ┌─────────────────────────────────┐
                          │ Check if active earmark exists  │
                          │        for this intent          │
                          └──────────────┬──────────────────┘
                                         │
                              ┌──────────┴──────────┐
                         EXISTS                 NONE
                              │                     │
                              ▼                     ▼
                         ┌─────────┐   ┌────────────────────────┐
                         │  SKIP   │   │ Is ptUSDe balance      │
                         │ INTENT  │   │ below threshold?       │
                         └─────────┘   └──────────┬─────────────┘
                                                  │
                                        ┌─────────┴────────┐
                                    NO  │                  │ YES
                                        ▼                  ▼
                                   ┌─────────┐   ┌─────────────────────┐
                                   │  SKIP   │   │ Calculate bridge    │
                                   │ INTENT  │   │ amount based on     │
                                   └─────────┘   │ deficit & balance   │
                                                 └──────────┬──────────┘
                                                            │
                                                            ▼
                                                 ┌──────────────────────┐
                                                 │   Create Earmark     │
                                                 │   for this intent    │
                                                 └──────────┬───────────┘
                                                            │
                                                            ▼
                                    ╔════════════════════════════════════╗
                                    ║           EXECUTE LEG 1            ║
                                    ║   Solana → Mainnet via CCIP        ║
                                    ╚═══════════════╤════════════════════╝
                                                    │
                                                    ▼
                                    ┌───────────────────────────────────┐
                                    │  Create RebalanceOperation record │
                                    │  status: PENDING                  │
                                    │  bridge: 'ccip-solana-mainnet'    │
                                    └───────────────────────────────────┘
```

---

## Flow Chart: Callback Execution (Legs 2 & 3)

```
┌─────────────────────────────────────────────────────────────────────┐
│                   executeSolanaUsdcCallbacks()                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────────────┐
                    │  Get PENDING operations with bridge   │
                    │       = 'ccip-solana-mainnet'         │
                    └───────────────────┬───────────────────┘
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              │              FOR EACH OPERATION                   │
              └─────────────────────────┬─────────────────────────┘
                                        │
                                        ▼
                      ┌─────────────────────────────────────┐
                      │  Check CCIP transfer status         │
                      │  (using CCIP SDK getTransferStatus) │
                      └─────────────────┬───────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                SUCCESS              PENDING             FAILURE
                    │                   │                   │
                    ▼                   ▼                   ▼
    ┌───────────────────────┐  ┌─────────────┐  ┌─────────────────┐
    │ Update status to      │  │ Check if    │  │   Log error     │
    │ AWAITING_CALLBACK     │  │ > 20 min?   │  │                 │
    └───────────┬───────────┘  │ Log warning │  └─────────────────┘
                │              └─────────────┘
                ▼
    ╔═══════════════════════════════════════════╗
    ║              EXECUTE LEG 2                ║
    ║     USDC → ptUSDe via Pendle adapter      ║
    ╚═══════════════════╤═══════════════════════╝
                        │
                        ▼
        ┌───────────────────────────────────┐
        │  1. Get Pendle quote              │
        │  2. Execute approval (if needed)  │
        │  3. Execute swap transaction      │
        └───────────────┬───────────────────┘
                        │
                        ▼
    ╔═══════════════════════════════════════════╗
    ║              EXECUTE LEG 3                ║
    ║   ptUSDe → Solana via CCIP adapter        ║
    ╚═══════════════════╤═══════════════════════╝
                        │
                        ▼
        ┌───────────────────────────────────┐
        │  1. Execute approval (if needed)  │
        │  2. Execute CCIP send transaction │
        │  3. Store Leg 3 tx hash           │
        └───────────────────────────────────┘
                        │
                        │
       ┌────────────────┴────────────────────────┐
       │   SECOND PASS: Check AWAITING_CALLBACK  │
       │   operations for Leg 3 completion       │
       └────────────────┬────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────┐
        │  Check if Leg 3 CCIP is ready     │
        │  on Solana destination            │
        └───────────────┬───────────────────┘
                        │
              ┌─────────┴─────────┐
          READY               NOT READY
              │                   │
              ▼                   ▼
    ┌──────────────────┐  ┌────────────────┐
    │ Update status to │  │ Keep waiting   │
    │ COMPLETED        │  │ (next cycle)   │
    └──────────────────┘  └────────────────┘
```

---

## New Bridge Adapters

### 1. CCIP Bridge Adapter (`CCIPBridgeAdapter`)

**Purpose:** Cross-chain token transfers using Chainlink's CCIP protocol.

**Key Features:**
- Supports EVM chains: Ethereum, Arbitrum, Optimism, Polygon, Base
- Supports Solana as destination (special handling)
- Uses `@chainlink/ccip-js` SDK for status tracking
- Pays fees in native token (ETH/SOL)

**Supported Chains & Selectors:**

```typescript
export const CHAIN_SELECTORS = {
  ETHEREUM: '5009297550715157269',
  ARBITRUM: '4949039107694359620', 
  OPTIMISM: '3734403246176062136',
  POLYGON: '4051577828743386545',
  BASE: '15971525489660198786',
  SOLANA: '124615329519749607',
};
```

**Router Addresses:**

| Chain | Address |
|-------|---------|
| Ethereum | `0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D` |
| Arbitrum | `0x141fa059441E0ca23ce184B6A78bafD2A517DdE8` |
| Optimism | `0x261c05167db67B2b619f9d312e0753f3721ad6E8` |
| Polygon | `0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe` |
| Base | `0x881e3A65B4d4a04dD529061dd0071cf975F58bCD` |

---

### 2. Pendle Bridge Adapter (`PendleBridgeAdapter`)

**Purpose:** Same-chain swaps between USDC and ptUSDe using Pendle's Convert API.

**Key Features:**
- Same-chain only (origin === destination)
- Uses Pendle V2 SDK API for quotes and transactions
- Supports USDC ↔ ptUSDe bidirectional swaps
- Uses KyberSwap as aggregator

**API Endpoint:** `https://api-v2.pendle.finance/core/v2/sdk/{chainId}/convert`

**Supported Pairs:**

```typescript
export const USDC_PTUSDE_PAIRS: Record<number, { usdc: string; ptUSDe: string }> = {
  1: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',  // Ethereum USDC
    ptUSDe: '0xE8483517077afa11A9B07f849cee2552f040d7b2', // Ethereum ptUSDe
  }
};
```

---

## Dependencies Added

```json
{
  "@chainlink/ccip-js": "^0.2.6",  // CCIP SDK for transfer status tracking
  "bs58": "^6.0.0"                  // Base58 encoding for Solana addresses
}
```

---

## Configuration Changes

Added to `SupportedBridge` enum in `packages/core/src/types/config.ts`:

```typescript
export enum SupportedBridge {
  // ... existing bridges
  Pendle = 'pendle',
  CCIP = 'chainlink-ccip'
}
```

---

## State Machine: Rebalance Operation Lifecycle

```
┌──────────────┐
│   PENDING    │──────────────────────────────────────────┐
│              │  Leg 1 CCIP submitted, waiting 20min     │
└──────┬───────┘                                          │
       │                                                  │
       │ Leg 1 CCIP SUCCESS                               │ Leg 1 CCIP FAILURE
       ▼                                                  ▼
┌──────────────────────┐                          ┌──────────────┐
│ AWAITING_CALLBACK    │                          │    FAILED    │
│                      │                          └──────────────┘
│ Legs 2+3 executing   │
└──────────┬───────────┘
           │
           │ Leg 3 CCIP arrives on Solana
           ▼
    ┌──────────────┐
    │  COMPLETED   │
    │              │
    │ All 3 legs ✓ │
    └──────────────┘
```

---

## Timing Considerations

| Operation | Expected Duration |
|-----------|-------------------|
| Leg 1 (Solana → Mainnet CCIP) | ~20 minutes |
| Leg 2 (USDC → ptUSDe Pendle swap) | ~30 seconds |
| Leg 3 (Mainnet → Solana CCIP) | ~20 minutes |
| **Total End-to-End** | **~40-45 minutes** |

---

## Review Checklist

### CCIP Adapter
- [ ] Chain selector mappings are correct
- [ ] Router addresses match official CCIP documentation
- [ ] Solana address encoding is properly handled
- [ ] Fee calculation uses native token correctly
- [ ] Transfer status tracking handles all status values

### Pendle Adapter
- [ ] API endpoint is correct for production
- [ ] Slippage handling (0.5% configured)
- [ ] ptUSDe token address is verified on mainnet
- [ ] Quote response parsing handles edge cases

### Solana USDC Rebalancing
- [ ] SPL token operations use correct mints
- [ ] Keypair derivation from mnemonic is secure
- [ ] ptUSDe threshold calculation is reasonable
- [ ] Earmark creation prevents duplicate operations
- [ ] All 3 legs are properly sequenced

### TODOs in Code
- [ ] `PTUSDE_SOLANA_MINT` placeholder needs actual SPL token address
- [ ] Integration with main poller flow (`rebalanceSolanaUsdc` not yet exported/called)

---

## Testing Recommendations

1. **Unit Tests:** Mock CCIP and Pendle API responses
2. **Integration Tests:** Use testnet with small amounts
3. **Timing Tests:** Verify callback polling handles 20+ minute CCIP delays
4. **Error Recovery:** Test behavior when any leg fails mid-operation

---

## Security Considerations

1. **Private Key Handling:** Solana mnemonic loaded from config securely
2. **Amount Validation:** Minimum rebalancing thresholds enforced
3. **Recipient Validation:** EVM addresses validated for format
4. **Slippage Protection:** 0.5% slippage on Pendle swaps

---

## Key Code References

### CCIP Adapter Entry Point

```typescript:73:86:packages/adapters/rebalance/src/adapters/ccip/ccip.ts
export class CCIPBridgeAdapter implements BridgeAdapter {
  private ccipClient: any;

  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing CCIPBridgeAdapter');
    this.ccipClient = CCIP.createClient();
  }

  type(): SupportedBridge {
    return SupportedBridge.CCIP;
  }
```

### Pendle Adapter Entry Point

```typescript:12:22:packages/adapters/rebalance/src/adapters/pendle/pendle.ts
export class PendleBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing PendleBridgeAdapter');
  }

  type(): SupportedBridge {
    return SupportedBridge.Pendle;
  }
```

### Solana USDC Rebalancing Main Function

```typescript:268:273:packages/poller/src/rebalance/solanaUsdc.ts
export async function rebalanceSolanaUsdc(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, chainService, rebalance, everclear } = context;
  const rebalanceOperations: RebalanceAction[] = [];

  // Always check destination callbacks to ensure operations complete
  await executeSolanaUsdcCallbacks(context);
```

---

## Questions for Reviewers

1. Is the 20-minute CCIP timeout appropriate, or should we increase it for mainnet?
2. Should we add retry logic for failed Pendle swaps?
3. How should we handle partial failures (e.g., Leg 1 succeeds but Leg 2 fails)?
4. Is the ptUSDe threshold (10x minimum amount) reasonable for production?

