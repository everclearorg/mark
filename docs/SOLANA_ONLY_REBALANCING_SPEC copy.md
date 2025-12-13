# SOLANA_ONLY Rebalancing Adapter Specification

## Overview

Implement a new `solanaOnly` run mode for rebalancing USDC from Ethereum to ptUSDe on Solana through a three-step pipeline:
1. **Bridge**: USDC (Ethereum) → USDC (Solana) via Wormhole or Symbiosis
2. **Swap**: USDC → USDe on Solana via Jupiter
3. **Mint**: USDe → ptUSDe via Pendle

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           SOLANA_ONLY REBALANCING FLOW                               │
└─────────────────────────────────────────────────────────────────────────────────────┘

     ETHEREUM MAINNET              SOLANA                      SOLANA
     (Chain 1)                     (Chain 1399811149)          (ptUSDe)
     ─────────────────             ─────────────────           ──────────
           │                              │                         │
  ┌────────┴────────┐                     │                         │
  │     USDC        │                     │                         │
  │   (ERC-20)      │                     │                         │
  └────────┬────────┘                     │                         │
           │                              │                         │
           │   STEP 1: Wormhole/Symbiosis │                         │
           │─────────────────────────────►│                         │
           │                              │                         │
           │                    ┌─────────┴─────────┐               │
           │                    │     USDC          │               │
           │                    │   (SPL Token)     │               │
           │                    └─────────┬─────────┘               │
           │                              │                         │
           │                    STEP 2: Jupiter Swap                │
           │                              │                         │
           │                    ┌─────────┴─────────┐               │
           │                    │     USDe          │               │
           │                    │   (SPL Token)     │               │
           │                    └─────────┬─────────┘               │
           │                              │                         │
           │                    STEP 3: Pendle Mint                 │
           │                              │─────────────────────────►
           │                              │                 ┌───────┴───────┐
           │                              │                 │   ptUSDe      │
           │                              │                 │ (SPL Token)   │
           │                              │                 └───────────────┘
```

---

## Configuration

### New Config Entries (`config.ts`)

```typescript
export interface SolanaRebalanceConfig {
  enabled: boolean;
  threshold: string;              // Minimum ptUSDe balance that triggers rebalance
  targetBalance: string;          // Target ptUSDe balance after rebalance
  maxRebalanceAmount: string;     // Maximum USDC per operation
  slippageBps: number;            // Slippage for swap (default: 50 = 0.5%)
  bridgePreference: 'wormhole' | 'symbiosis';
}

// Add to MarkConfiguration
solanaRebalance?: SolanaRebalanceConfig;
```

### Config Schema (`config.json`)

```json
{
  "solanaRebalance": {
    "enabled": true,
    "threshold": "1000000000",
    "targetBalance": "5000000000",
    "maxRebalanceAmount": "10000000000",
    "slippageBps": 50,
    "bridgePreference": "wormhole"
  }
}
```

### Solana Key Management

Follow existing pattern from `config.chains[1399811149].privateKey`:

```json
{
  "chains": {
    "1399811149": {
      "providers": ["https://..."],
      "privateKey": "0x..."
    }
  }
}
```

**Key derivation**: Use existing `config.ownSolAddress` for balance checks.  
**Signing**: Use Solana private key from chain config, converted via `hexToBase58()` from `@mark/core`.

---

## New Adapters

### 1. Wormhole Bridge Adapter

**Location**: `packages/adapters/rebalance/src/adapters/wormhole/`

```typescript
// wormhole.ts
export class WormholeBridgeAdapter implements BridgeAdapter {
  type(): SupportedBridge { return SupportedBridge.Wormhole; }
  
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string>;
  async send(sender: string, recipient: string, amount: string, route: RebalanceRoute): Promise<MemoizedTransactionRequest[]>;
  async readyOnDestination(amount: string, route: RebalanceRoute, originTx: TransactionReceipt): Promise<boolean>;
  async destinationCallback(): Promise<void>;
}
```

**API References**:
- SDK: `@wormhole-foundation/sdk`
- Status check: LayerZero-style VAA verification via Wormhole Guardian network
- [Wormhole SDK Docs](https://wormhole.com/docs/tools/typescript-sdk/get-started/)

**Step Completion Detection**:
- Query Wormhole API: `https://api.wormholescan.io/api/v1/vaas/{chainId}/{emitterAddress}/{sequence}`
- Status `completed` indicates VAA signed and redeemable on Solana

### 2. Symbiosis Bridge Adapter (Alternative)

**Location**: `packages/adapters/rebalance/src/adapters/symbiosis/`

```typescript
export class SymbiosisBridgeAdapter implements BridgeAdapter {
  type(): SupportedBridge { return SupportedBridge.Symbiosis; }
}
```

**API References**:
- REST API: `https://api.symbiosis.finance/crosschain/v1`
- [Symbiosis API Docs](https://docs.symbiosis.finance/developer-tools/symbiosis-api)

**Step Completion Detection**:
- Poll: `GET /v1/revert/{hash}/status`
- Status `completed` indicates successful bridge

### 3. Jupiter Swap Adapter

**Location**: `packages/adapters/rebalance/src/adapters/jupiter/`

```typescript
export class JupiterSwapAdapter implements SwapAdapter {
  type(): SupportedBridge { return SupportedBridge.Jupiter; }
  
  async getQuote(inputMint: string, outputMint: string, amount: string): Promise<JupiterQuote>;
  async executeSwap(sender: string, quote: JupiterQuote): Promise<SolanaTransactionResult>;
}
```

**API References**:
- Quote: `GET https://quote-api.jup.ag/v6/quote`
- Swap: `POST https://quote-api.jup.ag/v6/swap`
- [Jupiter API Docs](https://dev.jup.ag/api-reference)

**Step Completion Detection**:
- Solana tx confirmation: `await connection.confirmTransaction(txHash, 'finalized')`

### 4. Pendle Mint Adapter

**Location**: `packages/adapters/rebalance/src/adapters/pendle/`

```typescript
export class PendleMintAdapter implements MintAdapter {
  type(): SupportedBridge { return SupportedBridge.Pendle; }
  
  async getMintQuote(asset: string, amount: string): Promise<PendleQuote>;
  async mint(sender: string, amount: string): Promise<SolanaTransactionResult>;
}
```

**API References**:
- REST API: `https://api-v2.pendle.finance/sdk/api/v1`
- [Pendle API Docs](https://docs.pendle.finance/pendle-v2/Developers/Backend/ApiOverview)

**Step Completion Detection**:
- Solana tx confirmation: `await connection.confirmTransaction(txHash, 'finalized')`

---

## Database Schema

Use existing `rebalance_operations` table with new bridge identifiers:

| Bridge Value | Description |
|--------------|-------------|
| `wormhole-solana` | Leg 1: USDC bridge via Wormhole |
| `symbiosis-solana` | Leg 1: USDC bridge via Symbiosis |
| `jupiter` | Leg 2: USDC → USDe swap |
| `pendle-solana` | Leg 3: USDe → ptUSDe mint |

### Operation Status Flow

```
LEG 1 (Bridge)          LEG 2 (Swap)           LEG 3 (Mint)
──────────────          ────────────           ─────────────
PENDING                      
  ↓ (VAA verified)           
AWAITING_CALLBACK            
  ↓ (callback executed)      
COMPLETED ───────────► PENDING
                          ↓ (tx confirmed)
                       COMPLETED ────────────► PENDING
                                                  ↓ (tx confirmed)
                                               COMPLETED
```

---

## Poller Implementation

### New File: `packages/poller/src/rebalance/solanaPtUsde.ts`

```typescript
export async function rebalanceSolanaPtUsde(context: ProcessingContext): Promise<RebalanceAction[]> {
  // 1. Execute pending callbacks
  await executeSolanaCallbacks(context);
  
  // 2. Check if paused
  if (await context.rebalance.isPaused()) return [];
  
  // 3. Check ptUSDe balance on Solana against threshold
  const ptUsdeBalance = await getSolanaTokenBalance(
    config.ownSolAddress,
    PTUSDE_MINT_ADDRESS,
    config.chains[SOLANA_CHAINID]
  );
  
  const threshold = BigInt(config.solanaRebalance.threshold);
  if (ptUsdeBalance >= threshold) {
    logger.info('ptUSDe balance above threshold, skipping rebalance');
    return [];
  }
  
  // 4. Calculate rebalance amount
  const target = BigInt(config.solanaRebalance.targetBalance);
  const shortfall = target - ptUsdeBalance;
  const amountToRebalance = min(shortfall, BigInt(config.solanaRebalance.maxRebalanceAmount));
  
  // 5. Execute Leg 1: Bridge USDC to Solana
  // ... (similar pattern to tacUsdt.ts)
}

export async function executeSolanaCallbacks(context: ProcessingContext): Promise<void> {
  // Handle state transitions for each leg
  // Trigger next leg when previous completes
}
```

### Run Mode

Add to `packages/poller/src/init.ts`:

```typescript
if (process.env.RUN_MODE === 'solanaOnly') {
  const ops = await rebalanceSolanaPtUsde(context);
  return { statusCode: 200, body: JSON.stringify({ rebalanceOperations: ops }) };
}
```

---

## Token Addresses

| Token | Chain | Address |
|-------|-------|---------|
| USDC | Ethereum (1) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| USDC | Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDe | Solana | *TBD - get from Pendle/Ethena* |
| ptUSDe | Solana | *TBD - get from Pendle* |

---

## Step Completion Detection Summary

| Step | API/Method | Success Condition |
|------|------------|-------------------|
| Wormhole Bridge | `GET /vaas/{chain}/{emitter}/{seq}` | VAA exists with guardianSignatures |
| Symbiosis Bridge | `GET /revert/{hash}/status` | `status === 'completed'` |
| Jupiter Swap | `connection.confirmTransaction()` | `finalized` confirmation |
| Pendle Mint | `connection.confirmTransaction()` | `finalized` confirmation |

---

## Error Handling

1. **Bridge Timeout**: Mark operation as `ORPHANED` after 24 hours in `PENDING`
2. **Swap Failure**: Retry up to 3 times with exponential backoff
3. **Mint Failure**: Funds remain as USDe; manual intervention or retry
4. **Insufficient Balance**: Log and skip cycle

---

## Testing

1. **Unit Tests**: Each adapter in isolation with mocked APIs
2. **Integration Tests**: Full flow on devnet/testnet
3. **E2E**: Small amount (<$10) on mainnet

---

## Implementation Order

1. Add `SupportedBridge.Wormhole`, `SupportedBridge.Jupiter`, `SupportedBridge.Pendle` to enum
2. Implement `WormholeBridgeAdapter` with Wormhole SDK
3. Implement `JupiterSwapAdapter` with Jupiter API
4. Implement `PendleMintAdapter` with Pendle API
5. Create `solanaPtUsde.ts` poller with three-leg orchestration
6. Add `solanaOnly` run mode to `init.ts`
7. Add config schema and validation
8. Write tests

---

## Dependencies

```json
{
  "@wormhole-foundation/sdk": "^1.0.0",
  "@solana/web3.js": "^1.95.0"
}
```

---

## References

- [Wormhole TypeScript SDK](https://wormhole.com/docs/tools/typescript-sdk/get-started/)
- [Symbiosis API](https://docs.symbiosis.finance/developer-tools/symbiosis-api)
- [Jupiter API](https://dev.jup.ag/api-reference)
- [Pendle API](https://docs.pendle.finance/pendle-v2/Developers/Backend/ApiOverview)
- Existing adapters: `tacUsdt.ts`, `mantleEth.ts`, `stargate.ts`

