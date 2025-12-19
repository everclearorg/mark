# TAC Adapter Architecture & Design Document

## Executive Summary

This document describes the architecture for the **TAC (Telegram App Chain) Adapter**, which enables the Mark solver to:
1. Settle USDT invoices on TAC chain
2. Rebalance USDT inventory from Ethereum Mainnet to TAC via a two-leg bridging process

TAC is an EVM-compatible blockchain designed to connect Ethereum and TON ecosystems, enabling DeFi applications within Telegram.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [TAC Network Overview](#tac-network-overview)
3. [Architecture Overview](#architecture-overview)
4. [Bridging Routes](#bridging-routes)
5. [Two-Leg Rebalancing Flow](#two-leg-rebalancing-flow)
6. [Component Design](#component-design)
7. [External Services & Integrations](#external-services--integrations)
8. [Implementation Plan](#implementation-plan)
9. [Data Models](#data-models)
10. [State Machine](#state-machine)

---

## Problem Statement

The Mark solver needs to:
1. **Detect USDT invoices** destined for TAC chain
2. **Settle invoices** using USDT holdings on TAC
3. **Rebalance inventory** when TAC USDT balance is insufficient

### Constraints
- USDT is native to TON, not TAC
- No direct USDT bridge from Ethereum to TAC exists
- Must bridge through TON as an intermediary

---

## TAC Network Overview

### Chain Details

| Property | Value |
|----------|-------|
| **Name** | TAC (Telegram App Chain) |
| **Chain ID** | `239` (mainnet) |
| **VM** | EVM-compatible |
| **Native Token** | $TAC |
| **Block Explorer** | https://tac.build/explorer |
| **Bridge UI** | https://bridge.tac.build |

### Supported Assets on TAC

| Asset | Native Chain | TAC Address | Bridging Route |
|-------|--------------|-------------|----------------|
| USDT | TON | TBD | ETH → TON → TAC |
| WETH | Ethereum | TBD | ETH → TAC (direct via Stargate) |
| wstETH | Ethereum | TBD | ETH → TAC (direct via Stargate) |
| cbBTC | Ethereum | TBD | ETH → TAC (direct via Stargate) |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              TAC ADAPTER ARCHITECTURE                                │
└─────────────────────────────────────────────────────────────────────────────────────┘

                              ┌───────────────────────┐
                              │   TAC Rebalancing     │
                              │       Poller          │
                              │  (tacUsdt.ts)         │
                              └───────────┬───────────┘
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │   TAC Combined        │
                              │      Adapter          │
                              │  (Orchestrator)       │
                              └───────────┬───────────┘
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    │                                           │
                    ▼                                           ▼
         ┌─────────────────────┐                   ┌─────────────────────┐
         │  Stargate Adapter   │                   │  TAC Inner Bridge   │
         │  (Ethereum → TON)   │                   │    Adapter          │
         │                     │                   │  (TON → TAC)        │
         └──────────┬──────────┘                   └──────────┬──────────┘
                    │                                          │
                    ▼                                          ▼
         ┌─────────────────────┐                   ┌─────────────────────┐
         │  Stargate Router    │                   │  TAC Bridge         │
         │  Contract           │                   │  Contract           │
         │  (LayerZero V2)     │                   │  (Lock & Mint)      │
         └─────────────────────┘                   └─────────────────────┘
```

---

## Bridging Routes

### USDT: Two-Leg Bridge (Ethereum → TON → TAC)

Since USDT is native to TON, a direct bridge from Ethereum to TAC doesn't exist. We must use a two-step process:

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         USDT BRIDGING ROUTE                                          │
└─────────────────────────────────────────────────────────────────────────────────────┘

     ETHEREUM MAINNET              TON NETWORK                 TAC CHAIN
     ─────────────────             ───────────                 ─────────
            │                          │                          │
            │                          │                          │
   ┌────────┴────────┐                 │                          │
   │     USDT        │                 │                          │
   │   (ERC-20)      │                 │                          │
   └────────┬────────┘                 │                          │
            │                          │                          │
            │    LEG 1: Stargate       │                          │
            │    (LayerZero OFT)       │                          │
            │─────────────────────────►│                          │
            │                          │                          │
            │                 ┌────────┴────────┐                 │
            │                 │     USDT        │                 │
            │                 │   (Native)      │                 │
            │                 └────────┬────────┘                 │
            │                          │                          │
            │                          │    LEG 2: TAC Inner      │
            │                          │    Bridge (Lock & Mint)  │
            │                          │─────────────────────────►│
            │                          │                          │
            │                          │                 ┌────────┴────────┐
            │                          │                 │     USDT        │
            │                          │                 │   (Wrapped)     │
            │                          │                 └─────────────────┘
            │                          │                          │
```

### Direct Routes via Stargate (WETH, wstETH, cbBTC)

For these assets, direct bridging is available:

```
     ETHEREUM MAINNET              TAC CHAIN
     ─────────────────             ─────────
            │                          │
   ┌────────┴────────┐                 │
   │  WETH/wstETH/   │                 │
   │    cbBTC        │                 │
   └────────┬────────┘                 │
            │                          │
            │   Direct via Stargate    │
            │─────────────────────────►│
            │                          │
            │                 ┌────────┴────────┐
            │                 │  WETH/wstETH/   │
            │                 │    cbBTC        │
            │                 └─────────────────┘
```

---

## Two-Leg Rebalancing Flow

### Complete USDT Rebalancing Workflow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           USDT → TAC REBALANCING WORKFLOW                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘

          ETHEREUM MAINNET              TON NETWORK                  TAC CHAIN
          ────────────────              ───────────                  ─────────
                │                            │                            │
      ┌─────────┴──────────┐                 │                            │
      │ 1. Detect Invoice  │                 │                            │
      │    (USDT → TAC)    │                 │                            │
      └─────────┬──────────┘                 │                            │
                │                            │                            │
                ▼                            │                            │
      ┌─────────────────────┐                │                            │
      │ 2. Check TAC        │                │                            │
      │    USDT Balance     │────────────────┼───────────────────────────►│
      └─────────┬───────────┘                │                            │
                │                            │                            │
                │   Balance Sufficient?      │                            │
                ├───────────────────────────────────────────────────────► YES: Settle directly
                │                            │                            │
                │ NO: Need Rebalancing       │                            │
                ▼                            │                            │
      ┌─────────────────────┐                │                            │
      │ 3. Create Earmark   │                │                            │
      │    in Database      │                │                            │
      └─────────┬───────────┘                │                            │
                │                            │                            │
                ▼                            │                            │
      ┌─────────────────────┐                │                            │
      │ 4. LEG 1: Bridge    │                │                            │
      │    USDT to TON      │───────────────►│                            │
      │    via Stargate     │                │                            │
      └─────────┬───────────┘                │                            │
                │                            │                            │
                │  Status: PENDING           │                            │
                │                            ▼                            │
                │             ┌────────────────────────────────┐          │
                │             │ 5. Wait for Stargate Delivery  │          │
                │             │    (Check OFT confirmation)    │          │
                │             └────────────────┬───────────────┘          │
                │                              │                          │
                │  Status: AWAITING_CALLBACK   │                          │
                │                              ▼                          │
                │             ┌────────────────────────────────┐          │
                │             │ 6. LEG 2: Bridge USDT          │          │
                │             │    to TAC via TAC Inner Bridge │─────────►│
                │             └────────────────┬───────────────┘          │
                │                              │                          │
                │                              │  Status: PENDING         │
                │                              │                          │
                │                              ▼                          │
                │             ┌────────────────────────────────┐          │
                │             │ 7. Wait for TAC Inner Bridge   │          │
                │             │    (Check mint confirmation)   │          │
                │             └────────────────┬───────────────┘          │
                │                              │                          │
                │                              │                          ▼
                │                              │          ┌─────────────────────────┐
                │                              │          │ 8. USDT Available       │
                │                              │          │    on TAC               │
                │                              │          └─────────────────────────┘
                │                              │                          │
                │  Status: COMPLETED           │                          │
                └──────────────────────────────┴──────────────────────────┘
```

---

## Component Design

### 1. Stargate Adapter

Handles Ethereum → TON bridging via LayerZero OFT.

```typescript
class StargateBridgeAdapter implements BridgeAdapter {
  // Stargate Router V2 contract
  private readonly STARGATE_ROUTER = '0xeCc19E177d24551aA7ed6Bc6FE566eCa726CC8a9';
  
  // TON endpoint ID in LayerZero
  private readonly TON_ENDPOINT_ID = 30826; // LayerZero V2 TON chain ID
  
  type(): SupportedBridge {
    return SupportedBridge.Stargate;
  }
  
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    // Query Stargate for quote
    // Uses quoteSend to get expected output
  }
  
  async send(
    sender: string,
    recipient: string, 
    amount: string,
    route: RebalanceRoute
  ): Promise<MemoizedTransactionRequest[]> {
    // 1. Approve USDT for Stargate Router
    // 2. Call sendToken on Stargate Router
    // Returns array of transaction requests
  }
  
  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt
  ): Promise<boolean> {
    // Check LayerZero message delivery status
    // Query TON balance to confirm arrival
  }
  
  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt
  ): Promise<MemoizedTransactionRequest | void> {
    // No callback needed for OFT bridges
    return undefined;
  }
}
```

### 2. TAC Inner Bridge Adapter

Handles TON → TAC bridging via the official TAC bridge.

```typescript
class TacInnerBridgeAdapter implements BridgeAdapter {
  // TAC Bridge contract on TON
  private readonly TAC_BRIDGE_TON = '...'; // TON contract address
  
  // TAC Bridge contract on TAC EVM
  private readonly TAC_BRIDGE_TAC = '...'; // TAC EVM contract address
  
  type(): SupportedBridge {
    return SupportedBridge.TacInner;
  }
  
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    // TAC Inner Bridge is 1:1 (lock and mint)
    // May have small fee
    return amount;
  }
  
  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute
  ): Promise<MemoizedTransactionRequest[]> {
    // 1. Approve USDT for TAC Bridge (on TON)
    // 2. Call deposit/lock on TAC Bridge
    // Returns transaction request for TON network
  }
  
  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt
  ): Promise<boolean> {
    // Check if TAC EVM balance reflects the bridged amount
    // Or check bridge completion event on TAC
  }
}
```

### 3. TAC Combined Adapter (Orchestrator)

Orchestrates the two-leg bridging process.

```typescript
class TacCombinedAdapter implements BridgeAdapter {
  constructor(
    private readonly stargateAdapter: StargateBridgeAdapter,
    private readonly tacInnerBridgeAdapter: TacInnerBridgeAdapter,
    private readonly logger: Logger,
  ) {}
  
  type(): SupportedBridge {
    return SupportedBridge.TacCombined;
  }
  
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    // Calculate total output considering both legs
    const legOneOutput = await this.stargateAdapter.getReceivedAmount(amount, {
      ...route,
      destination: TON_CHAIN_ID,
    });
    
    const legTwoOutput = await this.tacInnerBridgeAdapter.getReceivedAmount(legOneOutput, {
      origin: TON_CHAIN_ID,
      destination: route.destination,
      asset: route.asset,
    });
    
    return legTwoOutput;
  }
  
  // Note: send() only handles Leg 1
  // Leg 2 is handled via callbacks in the rebalancing poller
  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute
  ): Promise<MemoizedTransactionRequest[]> {
    // Execute Leg 1 only: Ethereum → TON
    return this.stargateAdapter.send(sender, recipient, amount, {
      ...route,
      destination: TON_CHAIN_ID,
    });
  }
}
```

### 4. TAC USDT Rebalancing Poller

Similar to `mantleEth.ts`, orchestrates the complete flow.

```typescript
// packages/poller/src/rebalance/tacUsdt.ts

export async function rebalanceTacUsdt(context: ProcessingContext): Promise<RebalanceAction[]> {
  // 1. Execute pending callbacks for existing operations
  await executeTacCallbacks(context);
  
  // 2. Check if paused
  if (await context.rebalance.isPaused()) return [];
  
  // 3. Fetch USDT invoices destined for TAC
  const invoices = await context.everclear.fetchInvoices({
    destinations: [TAC_CHAIN_ID],
    tickerHash: USDT_TICKER_HASH,
  });
  
  // 4. For each invoice, check if rebalancing is needed
  for (const invoice of invoices) {
    // Check TAC USDT balance
    const tacBalance = await getMarkBalancesForTicker(USDT_TICKER_HASH, ...);
    
    if (tacBalance >= invoice.amount) {
      // Sufficient balance, skip
      continue;
    }
    
    // Create earmark
    const earmark = await createEarmark({...});
    
    // Execute Leg 1: Ethereum → TON
    const adapter = context.rebalance.getAdapter(SupportedBridge.Stargate);
    const txRequests = await adapter.send(...);
    
    // Submit transactions
    for (const tx of txRequests) {
      await submitTransaction(...);
    }
    
    // Create rebalance operation record
    await createRebalanceOperation({
      bridge: 'stargate-tac',
      status: RebalanceOperationStatus.PENDING,
      ...
    });
  }
}

export async function executeTacCallbacks(context: ProcessingContext): Promise<void> {
  // Get pending operations
  const operations = await db.getRebalanceOperations({
    status: [PENDING, AWAITING_CALLBACK],
    bridge: ['stargate-tac', 'tac-inner'],
  });
  
  for (const operation of operations) {
    if (operation.status === PENDING) {
      // Check if Leg 1 (Stargate) is complete
      const ready = await stargateAdapter.readyOnDestination(...);
      if (ready) {
        await db.updateRebalanceOperation(operation.id, {
          status: AWAITING_CALLBACK,
        });
        operation.status = AWAITING_CALLBACK;
      }
    }
    
    if (operation.status === AWAITING_CALLBACK) {
      // Execute Leg 2: TON → TAC
      const tacInnerAdapter = context.rebalance.getAdapter(SupportedBridge.TacInner);
      const txRequests = await tacInnerAdapter.send(...);
      
      // Submit Leg 2 transactions
      for (const tx of txRequests) {
        await submitTransaction(...);
      }
      
      // Create new operation for Leg 2
      await createRebalanceOperation({
        bridge: 'tac-inner',
        status: PENDING,
        ...
      });
      
      // Mark Leg 1 as completed
      await db.updateRebalanceOperation(operation.id, {
        status: COMPLETED,
      });
    }
  }
}
```

---

## External Services & Integrations

### 1. Stargate Finance (LayerZero)

| Component | Details |
|-----------|---------|
| **Protocol** | LayerZero V2 OFT |
| **Router Contract** | `0xeCc19E177d24551aA7ed6Bc6FE566eCa726CC8a9` (Ethereum) |
| **USDT Pool** | Asset-specific pool contract |
| **TON Chain ID** | `30826` (LayerZero V2) |
| **API** | https://api.stargate.finance |

**Contract Functions:**
```solidity
// Quote
function quoteSend(
  SendParam calldata _sendParam,
  bool _payInLzToken
) external view returns (MessagingFee memory);

// Send
function sendToken(
  SendParam calldata _sendParam,
  MessagingFee calldata _fee,
  address _refundAddress
) external payable returns (MessagingReceipt memory);
```

### 2. TAC Inner Bridge

| Component | Details |
|-----------|---------|
| **Type** | Lock & Mint Bridge |
| **Bridge UI** | https://bridge.tac.build |
| **TON Contract** | TBD |
| **TAC Contract** | TBD |
| **API** | https://bridge.tac.build/api |

**Flow:**
1. Lock USDT on TON (call bridge contract)
2. Wait for confirmation
3. Mint equivalent USDT on TAC

### 3. TON Network

| Component | Details |
|-----------|---------|
| **Chain Type** | TON (not EVM) |
| **SDK** | @ton/ton, tonweb |
| **RPC** | https://toncenter.com/api/v2 |
| **Explorer** | https://tonscan.org |

---

## Implementation Plan

### Phase 1: Constants & Types (Core Package)

```typescript
// packages/core/src/constants.ts
export const TAC_CHAIN_ID = '239';
export const TON_LZ_CHAIN_ID = '30826'; // LayerZero chain ID
export const USDT_TICKER_HASH = '0x8b1a1d9c2b109e527c9134b25b1a1833b16b6594f92daa9f6d9b7a6024bce9d0';

// packages/core/src/types/config.ts
export enum SupportedBridge {
  // ... existing
  Stargate = 'stargate',
  TacInner = 'tac-inner',
  TacCombined = 'tac-combined',
}
```

### Phase 2: Stargate Adapter

1. Create `packages/adapters/rebalance/src/adapters/stargate/`
2. Implement ABI definitions
3. Implement `StargateBridgeAdapter` class
4. Add tests

### Phase 3: TAC Inner Bridge Adapter

1. Create `packages/adapters/rebalance/src/adapters/tac/`
2. Implement TON interaction logic
3. Implement `TacInnerBridgeAdapter` class
4. Add tests

### Phase 4: TAC Combined Adapter

1. Create orchestrator adapter
2. Implement two-leg quote calculation
3. Add tests

### Phase 5: TAC USDT Rebalancing Poller

1. Create `packages/poller/src/rebalance/tacUsdt.ts`
2. Implement invoice detection
3. Implement callback processing
4. Add `tacOnly` run mode

### Phase 6: Integration & Registration

1. Register adapters in factory
2. Add configuration support
3. Integration testing

---

## Data Models

### Rebalance Operation (TAC Flow)

```typescript
// Leg 1: Ethereum → TON via Stargate
{
  id: 'uuid',
  earmarkId: 'uuid',
  originChainId: 1,           // Ethereum
  destinationChainId: 30826,  // TON (LayerZero)
  tickerHash: USDT_TICKER_HASH,
  amount: '1000000000',       // 1000 USDT
  slippage: 100,              // 0.1%
  status: 'pending' | 'awaiting_callback' | 'completed',
  bridge: 'stargate-tac',
  recipient: '0x...',
  transactions: { '1': { transactionHash: '0x...' } },
}

// Leg 2: TON → TAC via TAC Inner Bridge
{
  id: 'uuid',
  earmarkId: null,            // New operation, no earmark
  originChainId: 30826,       // TON
  destinationChainId: 239,    // TAC
  tickerHash: USDT_TICKER_HASH,
  amount: '999000000',        // After fees
  slippage: 0,                // 1:1 bridge
  status: 'pending' | 'completed',
  bridge: 'tac-inner',
  recipient: '0x...',
  transactions: { '30826': { ... } },
}
```

---

## State Machine

### TAC USDT Rebalancing State Flow

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                       TAC USDT REBALANCING STATE FLOW                           │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  LEG 1 OPERATION                        LEG 2 OPERATION                        │
│  (Stargate: ETH→TON)                    (TAC Inner: TON→TAC)                   │
│  ──────────────────                     ────────────────────                   │
│                                                                                 │
│  ┌─────────────────┐                                                           │
│  │ Create Earmark  │                                                           │
│  │ (PENDING)       │                                                           │
│  └────────┬────────┘                                                           │
│           │                                                                     │
│           ▼                                                                     │
│  ┌─────────────────────────┐                                                   │
│  │ Op1: PENDING            │                                                   │
│  │ bridge: "stargate-tac"  │                                                   │
│  │ origin: ethereum        │                                                   │
│  │ dest: ton               │                                                   │
│  └────────┬────────────────┘                                                   │
│           │                                                                     │
│           │ LayerZero OFT delivered to TON                                     │
│           ▼                                                                     │
│  ┌─────────────────────────┐                                                   │
│  │ Op1: AWAITING_CALLBACK  │                                                   │
│  └────────┬────────────────┘                                                   │
│           │                                                                     │
│           │ Execute TAC Inner Bridge        ┌─────────────────────────┐        │
│           │ ───────────────────────────────►│ Op2: PENDING            │        │
│           │                                  │ bridge: "tac-inner"     │        │
│           │                                  │ origin: ton             │        │
│           │                                  │ dest: tac               │        │
│           │                                  └────────┬────────────────┘        │
│           │                                           │                         │
│           ▼                                           │ TAC bridge confirmed    │
│  ┌─────────────────────────┐                          ▼                         │
│  │ Op1: COMPLETED          │               ┌─────────────────────────┐         │
│  │ Earmark: COMPLETED      │               │ Op2: COMPLETED          │         │
│  └─────────────────────────┘               └─────────────────────────┘         │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Technical Challenges

### 1. TON Network Integration

TON is not EVM-compatible, requiring:
- TON SDK integration (`@ton/ton`)
- Different transaction signing mechanism
- Different address format

**Solution:** Create a TON-specific chain service or adapter that handles TON transactions separately.

### 2. Cross-Chain Message Verification

Need to verify:
- LayerZero message delivery (Stargate)
- TAC bridge mint confirmation

**Solution:** Use LayerZero scan API for Stargate, TAC bridge API for inner bridge.

### 3. Multi-Network Transaction Coordination

Coordinating transactions across 3 networks (Ethereum, TON, TAC).

**Solution:** Use database-backed state machine similar to mETH rebalancing.

---

## References

- [TAC Bridging Guide](https://tac.build/blog/bridging-to-tac-move-liquidity-seamlessly)
- [Stargate Finance Docs](https://stargateprotocol.gitbook.io/stargate/)
- [LayerZero V2 Docs](https://docs.layerzero.network/)
- [TAC Inner Bridge](https://bridge.tac.build)
- [TON Developer Docs](https://docs.ton.org/)
- [PR #418 - mETH Rebalancing](https://github.com/everclearorg/mark/pull/418) (reference implementation)

---

## Implementation Summary

### Files Created/Modified

| File | Purpose |
|------|---------|
| `packages/core/src/constants.ts` | Added `TAC_CHAIN_ID`, `TON_LZ_CHAIN_ID`, `USDT_TICKER_HASH` |
| `packages/core/src/types/config.ts` | Added `Stargate`, `TacInner` to `SupportedBridge` enum; Added `stargate` and `tac` config sections |
| `packages/adapters/rebalance/src/adapters/stargate/` | New Stargate bridge adapter directory |
| `packages/adapters/rebalance/src/adapters/stargate/types.ts` | Stargate types, contract addresses, LayerZero types |
| `packages/adapters/rebalance/src/adapters/stargate/abi.ts` | Stargate V2 OFT and LayerZero endpoint ABIs |
| `packages/adapters/rebalance/src/adapters/stargate/stargate.ts` | `StargateBridgeAdapter` implementation |
| `packages/adapters/rebalance/src/adapters/stargate/index.ts` | Exports |
| `packages/adapters/rebalance/src/adapters/tac/` | New TAC Inner Bridge adapter directory |
| `packages/adapters/rebalance/src/adapters/tac/types.ts` | TAC bridge types, API types |
| `packages/adapters/rebalance/src/adapters/tac/tac-inner-bridge.ts` | `TacInnerBridgeAdapter` implementation |
| `packages/adapters/rebalance/src/adapters/tac/index.ts` | Exports |
| `packages/adapters/rebalance/src/adapters/index.ts` | Registered new adapters in factory |
| `packages/poller/src/rebalance/tacUsdt.ts` | TAC USDT rebalancing poller (two-leg orchestration) |
| `packages/poller/src/init.ts` | Added `tacOnly` run mode |

### Run Modes

| Mode | Environment Variable | Description |
|------|---------------------|-------------|
| Default | - | Process invoices and standard rebalancing |
| Rebalance Only | `RUN_MODE=rebalanceOnly` | Skip invoice processing, only rebalance |
| mETH Only | `RUN_MODE=methOnly` | mETH (WETH→mETH) rebalancing only |
| **TAC Only** | `RUN_MODE=tacOnly` | **TAC USDT rebalancing only** |

### Configuration

Add to your Mark configuration:

```yaml
stargate:
  apiUrl: "https://api.stargate.finance"  # Optional

tac:
  bridgeApiUrl: "https://bridge.tac.build/api"  # Optional
  tonRpcUrl: "https://toncenter.com/api/v2"     # Optional
```

