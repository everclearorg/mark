# TAC Rebalancing Refactor Specification

**Status**: Draft  
**Version**: 1.0

---

## 1. Objective

Refactor TAC rebalancing to:
1. Support **two receiver types**: Market Maker (MM) and Fill Service (FS)
2. Handle **on-demand** (invoice-triggered) + **threshold-based** rebalancing → MM receiver
3. Handle **threshold-based** rebalancing only → FS receiver
4. Unify both paths in a single `TAC_ONLY` lambda loop

---

## 2. Current Architecture (Summary)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      CURRENT TAC REBALANCING                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  tacUsdt.ts (TAC_ONLY mode)                                        │
│  ├─ executeTacCallbacks()     → Process pending Leg1/Leg2 ops      │
│  └─ rebalanceTacUsdt()        → On-demand only (intent-triggered)  │
│                                                                     │
│  Two-Leg Flow:                                                      │
│  ├─ Leg 1: Stargate (ETH USDT → TON USDT)                          │
│  └─ Leg 2: TAC Inner Bridge (TON USDT → TAC USDT)                  │
│                                                                     │
│  Recipient: config.ownAddress (single address)                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Gap**: No threshold-based rebalancing for TAC. No support for multiple receivers.

---

## 3. Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       NEW TAC REBALANCING                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  tacUsdt.ts (TAC_ONLY mode) - Single Entry Point                       │
│  │                                                                      │
│  ├─ executeTacCallbacks()          → Process all pending ops           │
│  │                                                                      │
│  ├─ evaluateMarketMakerRebalance() → MM Receiver Path                  │
│  │   ├─ On-demand (invoice-triggered with MM as receiver)             │
│  │   └─ Threshold-based (balance < threshold for MM routes)           │
│  │                                                                      │
│  └─ evaluateFillServiceRebalance() → FS Receiver Path                  │
│       └─ Threshold-based only (balance < threshold for FS routes)      │
│                                                                         │
│  Both paths → Same two-leg bridge flow (Stargate + TAC Inner)          │
│  Differentiated by: recipient address in operation record              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Configuration Changes

### 4.1 New Config Types

```typescript
// packages/core/src/types/config.ts

export interface TacRebalanceConfig {
  enabled: boolean;
  
  // Market Maker receiver configuration
  marketMaker: {
    address: string;                    // EVM address on TAC for MM
    onDemandEnabled: boolean;           // Enable invoice-triggered rebalancing
    thresholdEnabled: boolean;          // Enable balance-threshold rebalancing
    threshold?: string;                 // Min USDT balance (6 decimals)
    targetBalance?: string;             // Target after threshold-triggered rebalance
  };
  
  // Fill Service receiver configuration
  fillService: {
    address: string;                    // EVM address on TAC for FS
    thresholdEnabled: boolean;          // Enable balance-threshold rebalancing
    threshold: string;                  // Min USDT balance (6 decimals)
    targetBalance: string;              // Target after threshold-triggered rebalance
  };
  
  // Shared bridge configuration
  bridge: {
    slippageDbps: number;               // Slippage for Stargate (default: 50 = 0.5%)
    minRebalanceAmount: string;         // Min amount per operation (6 decimals)
    maxRebalanceAmount?: string;        // Max amount per operation (optional cap)
  };
}

// Add to MarkConfiguration
export interface MarkConfiguration {
  // ... existing fields
  tacRebalance?: TacRebalanceConfig;
}
```

### 4.2 Config Example

```json
{
  "tacRebalance": {
    "enabled": true,
    "marketMaker": {
      "address": "0x1234...abcd",
      "onDemandEnabled": true,
      "thresholdEnabled": true,
      "threshold": "100000000",
      "targetBalance": "500000000"
    },
    "fillService": {
      "address": "0x5678...efgh",
      "thresholdEnabled": true,
      "threshold": "50000000",
      "targetBalance": "200000000"
    },
    "bridge": {
      "slippageDbps": 50,
      "minRebalanceAmount": "1000000",
      "maxRebalanceAmount": "10000000000"
    }
  }
}
```

---

## 5. Implementation Changes

### 5.1 File: `packages/poller/src/rebalance/tacUsdt.ts`

Refactor into distinct evaluation paths:

```typescript
export async function rebalanceTacUsdt(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, rebalance } = context;
  const actions: RebalanceAction[] = [];

  // 1. Always process pending callbacks first
  await executeTacCallbacks(context);

  // 2. Check pause state
  if (await rebalance.isPaused()) {
    logger.warn('TAC rebalance paused', { requestId });
    return actions;
  }

  const tacConfig = config.tacRebalance;
  if (!tacConfig?.enabled) {
    return actions;
  }

  // 3. Evaluate Market Maker path
  const mmActions = await evaluateMarketMakerRebalance(context);
  actions.push(...mmActions);

  // 4. Evaluate Fill Service path
  const fsActions = await evaluateFillServiceRebalance(context);
  actions.push(...fsActions);

  return actions;
}
```

### 5.2 Market Maker Evaluation

```typescript
async function evaluateMarketMakerRebalance(
  context: ProcessingContext
): Promise<RebalanceAction[]> {
  const { config, logger, requestId } = context;
  const mmConfig = config.tacRebalance!.marketMaker;
  const actions: RebalanceAction[] = [];

  // A) On-demand: Invoice-triggered (existing logic, modified)
  if (mmConfig.onDemandEnabled) {
    const invoiceActions = await processOnDemandRebalancing(
      context,
      mmConfig.address,  // MM as recipient
    );
    actions.push(...invoiceActions);
  }

  // B) Threshold-based: Balance check
  if (mmConfig.thresholdEnabled) {
    const thresholdActions = await processThresholdRebalancing(
      context,
      mmConfig.address,
      BigInt(mmConfig.threshold!),
      BigInt(mmConfig.targetBalance!),
    );
    actions.push(...thresholdActions);
  }

  return actions;
}
```

### 5.3 Fill Service Evaluation

```typescript
async function evaluateFillServiceRebalance(
  context: ProcessingContext
): Promise<RebalanceAction[]> {
  const { config } = context;
  const fsConfig = config.tacRebalance!.fillService;

  // FS only supports threshold-based rebalancing
  if (!fsConfig.thresholdEnabled) {
    return [];
  }

  return processThresholdRebalancing(
    context,
    fsConfig.address,
    BigInt(fsConfig.threshold),
    BigInt(fsConfig.targetBalance),
  );
}
```

### 5.4 Shared: Threshold-Based Rebalancing

```typescript
async function processThresholdRebalancing(
  context: ProcessingContext,
  recipientAddress: string,
  threshold: bigint,
  targetBalance: bigint,
): Promise<RebalanceAction[]> {
  const { config, chainService, logger, requestId, prometheus } = context;
  const bridgeConfig = config.tacRebalance!.bridge;

  // 1. Get current USDT balance on TAC for this recipient
  const tacBalance = await getTacUsdtBalance(recipientAddress, context);
  
  if (tacBalance >= threshold) {
    logger.debug('TAC balance above threshold, skipping', {
      requestId,
      recipient: recipientAddress,
      balance: tacBalance.toString(),
      threshold: threshold.toString(),
    });
    return [];
  }

  // 2. Check for in-flight operations to this recipient
  const pendingOps = await getPendingOpsForRecipient(recipientAddress, context);
  if (pendingOps.length > 0) {
    logger.info('Active rebalance in progress for recipient', {
      requestId,
      recipient: recipientAddress,
      pendingOps: pendingOps.length,
    });
    return [];
  }

  // 3. Calculate amount needed
  const shortfall = targetBalance - tacBalance;
  const minAmount = BigInt(bridgeConfig.minRebalanceAmount);
  const maxAmount = bridgeConfig.maxRebalanceAmount 
    ? BigInt(bridgeConfig.maxRebalanceAmount) 
    : shortfall;

  if (shortfall < minAmount) {
    logger.debug('Shortfall below minimum, skipping', { requestId, shortfall: shortfall.toString() });
    return [];
  }

  // 4. Check origin (ETH) balance
  const ethUsdtBalance = await getEthUsdtBalance(config.ownAddress, context);
  const amountToBridge = min(shortfall, maxAmount, ethUsdtBalance);

  if (amountToBridge < minAmount) {
    logger.warn('Insufficient origin balance for threshold rebalance', {
      requestId,
      ethBalance: ethUsdtBalance.toString(),
      needed: amountToBridge.toString(),
    });
    return [];
  }

  // 5. Execute bridge (no earmark for threshold-based)
  return executeTacBridge(context, recipientAddress, amountToBridge, null);
}
```

### 5.5 Shared: On-Demand Rebalancing (Existing, Modified)

```typescript
async function processOnDemandRebalancing(
  context: ProcessingContext,
  recipientAddress: string,  // Now parameterized
): Promise<RebalanceAction[]> {
  // Existing intent-fetching logic from current tacUsdt.ts
  // Key change: use recipientAddress instead of config.ownAddress
  // Create earmark linked to invoice
  // Execute bridge with earmarkId
}
```

### 5.6 Unified Bridge Execution

```typescript
async function executeTacBridge(
  context: ProcessingContext,
  recipientAddress: string,     // Final TAC recipient
  amount: bigint,
  earmarkId: string | null,     // null for threshold-based
): Promise<RebalanceAction[]> {
  // Existing Stargate bridge logic
  // Store recipientAddress in operation.recipient
  // Store earmarkId (null for threshold-based)
  
  await createRebalanceOperation({
    earmarkId,                            // null for threshold, uuid for on-demand
    originChainId: MAINNET_CHAIN_ID,
    destinationChainId: TON_LZ_CHAIN_ID,
    tickerHash: USDT_TICKER_HASH,
    amount: amount.toString(),
    slippage: config.tacRebalance!.bridge.slippageDbps,
    status: RebalanceOperationStatus.PENDING,
    bridge: 'stargate-tac',
    recipient: recipientAddress,          // MM or FS address
    transactions: { [MAINNET_CHAIN_ID]: receipt },
  });
}
```

---

## 6. Callback Processing Changes

### 6.1 Modified `executeTacCallbacks`

No structural changes needed. The existing callback logic:
- Monitors `stargate-tac` operations (Leg 1)
- Executes `tac-inner` operations (Leg 2)
- Uses `operation.recipient` for final TAC destination

The `recipient` field already stores the target address. Callbacks will correctly route to MM or FS based on this stored value.

---

## 7. Earmark Handling (Critical)

### 7.1 Earmark Decision Matrix

| Trigger | Receiver | Earmark | Rationale |
|---------|----------|---------|-----------|
| Invoice (on-demand) | MM | **Yes** - linked to `invoiceId` | Track funds reserved for specific invoice fulfillment |
| Threshold | MM | **No** (`null`) | No invoice association; pure inventory management |
| Threshold | FS | **No** (`null`) | No invoice association; pure inventory management |

### 7.2 On-Demand Flow (with Earmark)

```typescript
// 1. Create earmark BEFORE bridge (current tacUsdt.ts pattern)
earmark = await createEarmark({
  invoiceId: intent.intent_id,
  designatedPurchaseChain: TAC_CHAIN_ID,
  tickerHash: USDT_TICKER_HASH,
  minAmount: amountToBridge.toString(),
  status: EarmarkStatus.PENDING,
});

// 2. Execute Leg 1 bridge
const receipt = await executeStargateBridge(...);

// 3. Create Leg 1 operation linked to earmark
await createRebalanceOperation({
  earmarkId: earmark.id,        // ← Linked
  bridge: 'stargate-tac',
  recipient: mmAddress,
  ...
});

// 4. In callback (Leg 2), inherit earmarkId
await createRebalanceOperation({
  earmarkId: operation.earmarkId,  // ← Same as Leg 1
  bridge: SupportedBridge.TacInner,
  recipient: mmAddress,           // ← Same recipient
  ...
});

// 5. When Leg 2 completes, update earmark status
await db.updateEarmarkStatus(earmarkId, EarmarkStatus.READY);
```

### 7.3 Threshold-Based Flow (no Earmark)

```typescript
// 1. No earmark creation - directly execute bridge
const receipt = await executeStargateBridge(...);

// 2. Create Leg 1 operation with null earmarkId
await createRebalanceOperation({
  earmarkId: null,              // ← No earmark
  bridge: 'stargate-tac',
  recipient: fsAddress,         // Could be MM or FS
  ...
});

// 3. In callback (Leg 2), also null earmarkId
await createRebalanceOperation({
  earmarkId: null,              // ← Still no earmark
  bridge: SupportedBridge.TacInner,
  recipient: fsAddress,
  ...
});
```

### 7.4 Earmark Status Transitions

```
ON-DEMAND (with earmark):
  PENDING → (Leg 1 complete) → PENDING → (Leg 2 complete) → READY → (invoice purchased) → COMPLETED

THRESHOLD (no earmark):
  N/A - Operations tracked solely by status in rebalance_operations table
```

### 7.5 Callback Handling

Both paths use the same callback logic. Differentiation is by:
1. `operation.earmarkId` - null check determines if earmark needs status update
2. `operation.recipient` - determines final TAC destination address

```typescript
// In executeTacCallbacks():
if (operation.status === RebalanceOperationStatus.COMPLETED) {
  // If this is Leg 2 and has an earmark, mark it ready
  if (operation.bridge === SupportedBridge.TacInner && operation.earmarkId) {
    await db.updateEarmarkStatus(operation.earmarkId, EarmarkStatus.READY);
  }
}
```

---

## 8. Database Schema

No schema changes required. Existing fields handle the requirements:

| Field | Usage |
|-------|-------|
| `earmark_id` | `NULL` for threshold-based, UUID for on-demand |
| `recipient` | MM or FS TAC address |
| `bridge` | `stargate-tac` (Leg 1) or `tac-inner` (Leg 2) |

---

## 9. State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TAC REBALANCING STATE FLOW                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TRIGGER                                                                    │
│  ├─ Invoice (on-demand) ───► createEarmark() ──┐                            │
│  │                                             │                            │
│  └─ Balance < Threshold ───► (no earmark) ─────┼──► executeTacBridge()      │
│                                                │                            │
│                                                ▼                            │
│  ┌─────────────────────────────────────────────────┐                        │
│  │ LEG 1: stargate-tac                             │                        │
│  │ Status: PENDING → AWAITING_CALLBACK → COMPLETED │                        │
│  │ recipient: MM_ADDRESS or FS_ADDRESS             │                        │
│  │ earmarkId: null (threshold) | uuid (on-demand)  │                        │
│  └─────────────────────┬───────────────────────────┘                        │
│                        │                                                    │
│                        │ Stargate delivers to TON                           │
│                        ▼                                                    │
│  ┌─────────────────────────────────────────────────┐                        │
│  │ LEG 2: tac-inner                                │                        │
│  │ Status: PENDING → COMPLETED                     │                        │
│  │ recipient: (inherited from Leg 1)               │                        │
│  │ earmarkId: (inherited from Leg 1)               │                        │
│  └─────────────────────┬───────────────────────────┘                        │
│                        │                                                    │
│                        │ TAC Inner Bridge mints on TAC                      │
│                        ▼                                                    │
│  ┌─────────────────────────────────────────────────┐                        │
│  │ COMPLETION                                      │                        │
│  │ IF earmarkId != null:                           │                        │
│  │   → updateEarmarkStatus(READY)                  │                        │
│  │ ENDIF                                           │                        │
│  │                                                 │                        │
│  │ ✓ USDT on TAC (at recipient)                    │                        │
│  └─────────────────────────────────────────────────┘                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Decision Logic Summary

| Condition | Receiver | Trigger | earmarkId | Purpose |
|-----------|----------|---------|-----------|---------|
| Invoice with MM receiver + insufficient TAC balance | MM | On-demand | UUID | Reserve funds for invoice |
| MM TAC balance < MM threshold (no pending invoice) | MM | Threshold | `NULL` | Inventory top-up |
| FS TAC balance < FS threshold | FS | Threshold | `NULL` | Fill service inventory |

---

## 11. Testing Requirements

### 11.1 Unit Tests

| Test Case | Scope |
|-----------|-------|
| MM on-demand triggers with valid invoice | `processOnDemandRebalancing` |
| MM on-demand skips when balance sufficient | `processOnDemandRebalancing` |
| MM on-demand skips when active earmark exists | `processOnDemandRebalancing` |
| MM threshold triggers when balance < threshold | `processThresholdRebalancing` |
| MM threshold skips when balance >= threshold | `processThresholdRebalancing` |
| FS threshold triggers when balance < threshold | `evaluateFillServiceRebalance` |
| FS threshold skips when pending ops exist | `processThresholdRebalancing` |
| Correct recipient stored in operation | `executeTacBridge` |

### 11.2 Earmark Tests

| Test Case | Expected Behavior |
|-----------|-------------------|
| On-demand: earmark created BEFORE bridge | `createEarmark()` called first |
| On-demand: operation.earmarkId = earmark.id | Leg 1 linked to earmark |
| On-demand: Leg 2 inherits earmarkId from Leg 1 | Same earmarkId in Leg 2 |
| On-demand: earmark → READY after Leg 2 completes | `updateEarmarkStatus(READY)` |
| Threshold: earmarkId = null | No earmark created |
| Threshold: callback skips earmark update | No `updateEarmarkStatus` call |

### 11.3 Integration Tests

| Test Case | Coverage |
|-----------|----------|
| Full flow: MM on-demand Leg1 → Leg2 → earmark READY | End-to-end with earmark |
| Full flow: MM threshold Leg1 → Leg2 (no earmark) | End-to-end without earmark |
| Full flow: FS threshold Leg1 → Leg2 → complete | End-to-end |
| Concurrent MM + FS rebalances execute independently | Isolation |
| Callback correctly routes to stored recipient | Callback logic |
| On-demand failure: earmark not created if Leg 1 fails | Failure handling |

---

## 12. Migration Notes

1. **Config**: Add `tacRebalance` config section
2. **Backwards Compat**: If `tacRebalance` not present, fall back to current behavior using `ownAddress`
3. **Existing Ops**: Existing operations use `recipient = ownAddress`; callbacks work unchanged

---

## 13. Files Changed

| File | Change |
|------|--------|
| `packages/core/src/types/config.ts` | Add `TacRebalanceConfig` |
| `packages/poller/src/rebalance/tacUsdt.ts` | Refactor into MM/FS paths |
| `packages/poller/config.json` | Add `tacRebalance` section |

---

## 14. Open Questions

1. **Balance Query**: How to query TAC USDT balance for a specific address (MM vs FS)?
   - Current: Uses generic `getMarkBalancesForTicker`
   - Needed: Per-address balance check on TAC

2. **Gas Funding**: Who funds TON gas for Leg 2 if MM and FS are different addresses?
   - Current: Single TON wallet (`config.ton.mnemonic`)
   - Confirm: Same TON wallet bridges to both MM and FS

---

## 15. References

- Existing: `tacUsdt.ts`, `rebalance.ts`, `onDemand.ts`
- Architecture: `TAC-ADAPTER-ARCHITECTURE.md`
- Pattern: `PR-418-METH-REBALANCING-ARCHITECTURE.md`

