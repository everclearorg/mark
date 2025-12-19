# PR #418: mETH (Mantle ETH) Rebalancing - Architecture & Design Document

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [System Overview](#system-overview)
3. [Architecture Diagrams](#architecture-diagrams)
4. [Package Structure](#package-structure)
5. [Bridge Adapter Pattern](#bridge-adapter-pattern)
6. [mETH Rebalancing Workflow](#meth-rebalancing-workflow)
7. [External Services & Integrations](#external-services--integrations)
8. [Data Models](#data-models)
9. [State Machine](#state-machine)
10. [Key Implementation Details](#key-implementation-details)

---

## Executive Summary

PR #418 introduces **mETH (Mantle ETH) Rebalancing** functionality to the Mark system. This feature enables automated rebalancing of WETH to mETH (Mantle's liquid staking ETH derivative) by:

1. Detecting settled intents destined for Mantle chain with mETH output
2. Bridging WETH from the hub settlement domain to Ethereum mainnet
3. Staking WETH on Ethereum mainnet to receive mETH via the Mantle staking contract
4. Bridging mETH from Ethereum mainnet to Mantle L2 via the official Mantle bridge

This is a **two-leg rebalancing operation** that involves multiple chains and protocols.

---

## System Overview

The Mark system is a **solver/market maker** for the Everclear protocol. It:
- Polls for invoices (intents) from the Everclear API
- Fills intents by purchasing on destination chains
- Rebalances inventory across chains using various bridge adapters

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MARK POLLER SERVICE                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Invoice    │    │  Rebalance   │    │   mETH       │    │  Callbacks   │  │
│  │  Processing  │    │  Inventory   │    │ Rebalancing  │    │  Execution   │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │                   │          │
│         └───────────────────┴───────────────────┴───────────────────┘          │
│                                      │                                          │
│                         ┌────────────┴────────────┐                             │
│                         │   Processing Context    │                             │
│                         │ (Config, Adapters, DB)  │                             │
│                         └────────────┬────────────┘                             │
│                                      │                                          │
├──────────────────────────────────────┼──────────────────────────────────────────┤
│                                      │                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                        ADAPTER LAYER                                     │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────┐  │   │
│  │  │ Across  │ │ Binance │ │ Coinbase│ │  CCTP   │ │  Near   │ │Mantle │  │   │
│  │  │ Bridge  │ │   CEX   │ │   CEX   │ │ Bridge  │ │ Bridge  │ │Bridge │  │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └───────┘  │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
          ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
          │   PostgreSQL    │ │     Redis       │ │  External APIs  │
          │   (Earmarks,    │ │  (Purchase      │ │  (Everclear,    │
          │   Operations)   │ │   Cache)        │ │  Bridges, CEXs) │
          └─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## Architecture Diagrams

### mETH Rebalancing Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         mETH REBALANCING WORKFLOW                                    │
└─────────────────────────────────────────────────────────────────────────────────────┘

          ORIGIN CHAIN                    ETHEREUM                     MANTLE L2
        (Settlement Domain)               MAINNET                      (Chain 5000)
        ─────────────────                ─────────                    ─────────────
              │                              │                              │
              │                              │                              │
    ┌─────────┴──────────┐                   │                              │
    │ 1. Detect Intent   │                   │                              │
    │    (WETH → mETH)   │                   │                              │
    │    to Mantle       │                   │                              │
    └─────────┬──────────┘                   │                              │
              │                              │                              │
              ▼                              │                              │
    ┌─────────────────────┐                  │                              │
    │ 2. Create Earmark   │                  │                              │
    │    in Database      │                  │                              │
    └─────────┬───────────┘                  │                              │
              │                              │                              │
              ▼                              │                              │
    ┌─────────────────────┐                  │                              │
    │ 3. LEG 1: Bridge    │                  │                              │
    │    WETH to Mainnet  │─────────────────►│                              │
    │    (Across/Binance/ │                  │                              │
    │     Coinbase)       │                  │                              │
    └─────────┬───────────┘                  │                              │
              │                              │                              │
              │  Status: PENDING             ▼                              │
              │             ┌────────────────────────────────┐              │
              │             │ 4. Wait for Bridge Completion  │              │
              │             │    (Callback monitors status)  │              │
              │             └────────────────┬───────────────┘              │
              │                              │                              │
              │  Status: AWAITING_CALLBACK   ▼                              │
              │             ┌────────────────────────────────┐              │
              │             │ 5. LEG 2: Mantle Bridge        │              │
              │             │    a) Unwrap WETH → ETH        │              │
              │             │    b) Stake ETH → mETH         │              │
              │             │    c) Approve mETH             │              │
              │             │    d) Bridge mETH to Mantle    │──────────────►
              │             └────────────────┬───────────────┘              │
              │                              │                              │
              │                              │  Status: PENDING             │
              │                              │                              │
              │                              ▼                              │
              │             ┌────────────────────────────────┐              │
              │             │ 6. Wait for L2 Finalization    │              │
              │             │    (readyOnDestination check)  │              │
              │             └────────────────┬───────────────┘              │
              │                              │                              │
              │                              │                              ▼
              │                              │             ┌─────────────────────────┐
              │                              │             │ 7. mETH Available       │
              │                              │             │    on Mantle L2         │
              │                              │             └─────────────────────────┘
              │                              │                              │
              │  Status: COMPLETED           │                              │
              └──────────────────────────────┴──────────────────────────────┘
```

### Adapter Interface Pattern

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BridgeAdapter Interface                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ interface BridgeAdapter {                                               │ │
│  │   type(): SupportedBridge;                                              │ │
│  │   getReceivedAmount(amount, route): Promise<string>;                    │ │
│  │   send(sender, recipient, amount, route): Promise<TxRequest[]>;         │ │
│  │   destinationCallback(route, originTx): Promise<TxRequest | void>;      │ │
│  │   readyOnDestination(amount, route, originTx): Promise<boolean>;        │ │
│  │ }                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                     │                                        │
│                 ┌───────────────────┼───────────────────┐                   │
│                 │                   │                   │                   │
│                 ▼                   ▼                   ▼                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │ AcrossBridge     │  │ BinanceBridge    │  │ MantleBridge     │          │
│  │ Adapter          │  │ Adapter          │  │ Adapter          │          │
│  ├──────────────────┤  ├──────────────────┤  ├──────────────────┤          │
│  │ - Across API     │  │ - Binance API    │  │ - Mantle Staking │          │
│  │ - SpokePool      │  │ - CEX Deposits   │  │ - L1 Bridge      │          │
│  │ - V3 Deposits    │  │ - Withdrawals    │  │ - L2 Messenger   │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Package Structure

```
mark/
├── packages/
│   ├── core/                           # Shared types, utilities, constants
│   │   └── src/
│   │       ├── constants.ts            # MAINNET_CHAIN_ID, MANTLE_CHAIN_ID
│   │       └── types/
│   │           ├── config.ts           # SupportedBridge enum, Route configs
│   │           ├── intent.ts           # Intent, Invoice types
│   │           └── rebalance.ts        # RebalanceAction type
│   │
│   ├── adapters/
│   │   ├── rebalance/                  # Bridge adapters
│   │   │   └── src/
│   │   │       ├── types.ts            # BridgeAdapter interface
│   │   │       ├── adapters/
│   │   │       │   ├── index.ts        # RebalanceAdapter factory
│   │   │       │   ├── across/         # Across Protocol integration
│   │   │       │   ├── binance/        # Binance CEX integration
│   │   │       │   ├── coinbase/       # Coinbase CEX integration
│   │   │       │   ├── cctp/           # Circle CCTP bridge
│   │   │       │   ├── near/           # Near Protocol integration
│   │   │       │   └── mantle/         # ✨ NEW: Mantle Bridge adapter
│   │   │       │       ├── abi.ts      # Contract ABIs
│   │   │       │       ├── mantle.ts   # MantleBridgeAdapter class
│   │   │       │       └── types.ts    # Contract addresses
│   │   │       └── shared/
│   │   │           └── asset.ts        # Asset matching utilities
│   │   │
│   │   ├── everclear/                  # Everclear API client
│   │   │   └── src/
│   │   │       └── index.ts            # fetchIntents, fetchInvoices
│   │   │
│   │   └── database/                   # PostgreSQL persistence
│   │       └── src/
│   │           └── db.ts               # Earmarks, RebalanceOperations
│   │
│   └── poller/                         # Main processing service
│       └── src/
│           ├── init.ts                 # Entry point, adapter initialization
│           ├── helpers/
│           │   └── balance.ts          # getMarkBalancesForTicker (new helper)
│           └── rebalance/
│               ├── rebalance.ts        # Standard inventory rebalancing
│               ├── callbacks.ts        # Destination callback execution
│               └── mantleEth.ts        # ✨ NEW: mETH rebalancing logic
```

---

## Bridge Adapter Pattern

### Interface Definition

All bridge adapters implement the `BridgeAdapter` interface:

```typescript
export interface BridgeAdapter {
  // Returns the adapter type identifier
  type(): SupportedBridge;
  
  // Get quote: how much will be received after fees/slippage
  getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string>;
  
  // Build transactions needed to execute the bridge
  send(
    sender: string, 
    recipient: string, 
    amount: string, 
    route: RebalanceRoute
  ): Promise<MemoizedTransactionRequest[]>;
  
  // Get callback transaction needed on destination (e.g., wrap ETH)
  destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt
  ): Promise<MemoizedTransactionRequest | void>;
  
  // Check if funds have arrived on destination chain
  readyOnDestination(
    amount: string, 
    route: RebalanceRoute, 
    originTransaction: TransactionReceipt
  ): Promise<boolean>;
}
```

### Transaction Memos

Transactions are tagged with memos to identify their purpose:

```typescript
export enum RebalanceTransactionMemo {
  Rebalance = 'Rebalance',   // The main bridge transaction
  Approval = 'Approval',      // ERC20 approve
  Wrap = 'Wrap',              // Wrap ETH to WETH
  Unwrap = 'Unwrap',          // Unwrap WETH to ETH
  Mint = 'Mint',              // Mint operations
  Stake = 'Stake',            // Stake ETH to get mETH
}
```

### Adapter Factory

The `RebalanceAdapter` class acts as a factory for bridge adapters:

```typescript
class RebalanceAdapter {
  getAdapter(type: SupportedBridge): BridgeAdapter {
    switch (type) {
      case SupportedBridge.Across:
        return new AcrossBridgeAdapter(url, chains, logger);
      case SupportedBridge.Mantle:
        return new MantleBridgeAdapter(chains, logger);
      // ... other adapters
    }
  }
}
```

---

## mETH Rebalancing Workflow

### Phase 1: Intent Detection & Earmarking

```typescript
// 1. Fetch settled intents going to Mantle with mETH output
const intents = await everclear.fetchIntents({
  statuses: [IntentStatus.SETTLED_AND_COMPLETED],
  destinations: [MANTLE_CHAIN_ID],        // 5000
  outputAsset: METH_ON_MANTLE_ADDRESS,    // 0xcda86a272531e8640cd7f1a92c01839911b90bb0
  tickerHash: WETH_TICKER_HASH,
  isFastPath: true,
});

// 2. For each valid intent, create an earmark to reserve funds
const earmark = await createEarmark({
  invoiceId: intent.intent_id,
  designatedPurchaseChain: MANTLE_CHAIN_ID,
  tickerHash: WETH_TICKER_HASH,
  minAmount: amountToBridge.toString(),
  status: EarmarkStatus.PENDING,
});
```

### Phase 2: Leg 1 - Bridge to Mainnet

```typescript
// Bridge WETH from settlement domain → Mainnet using preferred bridges
const preferences = [SupportedBridge.Across, SupportedBridge.Binance, SupportedBridge.Coinbase];

for (const bridgeType of preferences) {
  const adapter = rebalance.getAdapter(bridgeType);
  
  // Get quote
  const receivedAmount = await adapter.getReceivedAmount(amount, route);
  
  // Check slippage
  if (receivedAmount < minimumAcceptableAmount) continue;
  
  // Get and execute transactions
  const txRequests = await adapter.send(sender, sender, amount, route);
  for (const { transaction, memo } of txRequests) {
    await submitTransaction(transaction);
  }
  
  // Create rebalance operation record
  await createRebalanceOperation({
    earmarkId: earmark.id,
    originChainId: route.origin,
    destinationChainId: MAINNET_CHAIN_ID,
    bridge: `${bridgeType}-mantle`,  // Tagged for mETH flow
    status: RebalanceOperationStatus.PENDING,
  });
  
  break; // Success, exit loop
}
```

### Phase 3: Callback Processing (Leg 2 - Stake & Bridge)

```typescript
// Executed in executeMethCallbacks() polling loop

// 1. Check if Leg 1 bridge is complete
if (operation.status === RebalanceOperationStatus.PENDING) {
  const ready = await adapter.readyOnDestination(amount, route, receipt);
  if (ready) {
    await db.updateRebalanceOperation(operation.id, {
      status: RebalanceOperationStatus.AWAITING_CALLBACK,
    });
  }
}

// 2. Execute Leg 2: Stake and Bridge to Mantle
if (operation.status === RebalanceOperationStatus.AWAITING_CALLBACK) {
  const mantleAdapter = rebalance.getAdapter(SupportedBridge.Mantle);
  
  // Build transactions: Unwrap → Stake → Approve → Bridge
  const bridgeTxRequests = await mantleAdapter.send(sender, sender, amount, route);
  
  // Execute all transactions
  for (const { transaction, memo } of bridgeTxRequests) {
    await submitTransaction(transaction);
  }
  
  // Create new operation for Leg 2 tracking
  await createRebalanceOperation({
    originChainId: MAINNET_CHAIN_ID,
    destinationChainId: MANTLE_CHAIN_ID,
    bridge: SupportedBridge.Mantle,
    status: RebalanceOperationStatus.PENDING,
  });
}
```

---

## External Services & Integrations

### 1. Everclear API

| Endpoint | Purpose |
|----------|---------|
| `GET /intents` | Fetch settled intents for mETH rebalancing |
| `GET /invoices` | Fetch invoices for standard processing |
| `GET /intents/:id` | Get intent status |

### 2. Mantle Network Contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| **mETH Staking** | `0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f` | Stake ETH → mETH |
| **mETH (L1)** | `0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa` | mETH token on Ethereum |
| **mETH (L2)** | `0xcda86a272531e8640cd7f1a92c01839911b90bb0` | mETH token on Mantle |
| **L1 Bridge** | `0x95fC37A27a2f68e3A647CDc081F0A89bb47c3012` | Standard Bridge |
| **L1 Messenger** | `0x676A795fe6E43C17c668de16730c3F690FEB7120` | Cross-chain messaging |
| **L2 Messenger** | `0x4200000000000000000000000000000000000007` | L2 message relay |

### 3. Bridge Adapters

| Bridge | Type | Use Case |
|--------|------|----------|
| **Across** | Decentralized | Fast cross-chain transfers |
| **Binance** | CEX | High liquidity, competitive fees |
| **Coinbase** | CEX | Alternative CEX route |
| **CCTP** | Native | USDC transfers |
| **Near** | Bridge | Near ecosystem |
| **Mantle** | Native | ETH ↔ Mantle L2 |

### 4. Across Protocol API

| Endpoint | Purpose |
|----------|---------|
| `GET /suggested-fees` | Get quote for bridge |
| `GET /deposit/status` | Check deposit fill status |

---

## Data Models

### Earmark

Tracks funds reserved for specific intents:

```typescript
interface Earmark {
  id: string;                      // UUID
  invoiceId: string;               // Intent ID being fulfilled
  designatedPurchaseChain: number; // Destination chain
  tickerHash: string;              // Asset identifier
  minAmount: string;               // Amount reserved
  status: EarmarkStatus;           // pending | ready | completed | expired
  createdAt: Date;
  updatedAt: Date;
}
```

### Rebalance Operation

Tracks individual bridge operations:

```typescript
interface RebalanceOperation {
  id: string;                      // UUID
  earmarkId: string | null;        // Linked earmark (null for regular rebalancing)
  originChainId: number;
  destinationChainId: number;
  tickerHash: string;
  amount: string;
  slippage: number;                // In decibasis points
  status: RebalanceOperationStatus;
  bridge: string;                  // e.g., "across-mantle", "mantle"
  recipient: string;
  isOrphaned: boolean;
  transactions: Record<string, TransactionEntry>;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## State Machine

### Rebalance Operation States

```
                                    ┌─────────────────┐
                                    │     CREATED     │
                                    └────────┬────────┘
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │     PENDING     │
                                    │  (Bridge sent)  │
                                    └────────┬────────┘
                                             │
                              readyOnDestination() = true
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │    AWAITING     │
                                    │    CALLBACK     │
                                    └────────┬────────┘
                                             │
                              Callback executed OR
                              No callback needed
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │    COMPLETED    │
                                    └─────────────────┘
```

### mETH Two-Leg Flow State Transitions

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           mETH REBALANCING STATE FLOW                           │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  LEG 1 OPERATION                        LEG 2 OPERATION                        │
│  ──────────────                         ──────────────                         │
│                                                                                 │
│  ┌─────────────────┐                                                           │
│  │ Create Earmark  │                                                           │
│  │ (PENDING)       │                                                           │
│  └────────┬────────┘                                                           │
│           │                                                                     │
│           ▼                                                                     │
│  ┌─────────────────────────┐                                                   │
│  │ Op1: PENDING            │                                                   │
│  │ bridge: "across-mantle" │                                                   │
│  │ origin: settlement      │                                                   │
│  │ dest: mainnet           │                                                   │
│  └────────┬────────────────┘                                                   │
│           │                                                                     │
│           │ Bridge fills on mainnet                                            │
│           ▼                                                                     │
│  ┌─────────────────────────┐                                                   │
│  │ Op1: AWAITING_CALLBACK  │                                                   │
│  └────────┬────────────────┘                                                   │
│           │                                                                     │
│           │ Execute Mantle stake + bridge         ┌─────────────────────────┐  │
│           │ ─────────────────────────────────────►│ Op2: PENDING            │  │
│           │                                        │ bridge: "mantle"        │  │
│           │                                        │ origin: mainnet         │  │
│           │                                        │ dest: mantle            │  │
│           │                                        └────────┬────────────────┘  │
│           │                                                 │                   │
│           ▼                                                 │ L2 finalized      │
│  ┌─────────────────────────┐                                ▼                   │
│  │ Op1: COMPLETED          │                     ┌─────────────────────────┐   │
│  │ Earmark: COMPLETED      │                     │ Op2: COMPLETED          │   │
│  └─────────────────────────┘                     └─────────────────────────┘   │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Implementation Details

### 1. Mantle Bridge Adapter Transaction Sequence

The `MantleBridgeAdapter.send()` method returns 4 transactions:

```typescript
async send(sender, recipient, amount, route): Promise<MemoizedTransactionRequest[]> {
  // 1. Unwrap WETH → ETH
  const unwrapTx = {
    memo: RebalanceTransactionMemo.Unwrap,
    transaction: {
      to: WETH_ADDRESS,
      data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [amount] }),
      value: 0n,
    },
  };

  // 2. Stake ETH → mETH  
  const stakeTx = {
    memo: RebalanceTransactionMemo.Stake,
    transaction: {
      to: METH_STAKING_CONTRACT_ADDRESS,
      data: encodeFunctionData({ abi: MANTLE_STAKING_ABI, functionName: 'stake', args: [minMeth] }),
      value: amount,  // ETH value
    },
  };

  // 3. Approve mETH for bridge (if needed)
  const approvalTx = allowance < mEthAmount ? {
    memo: RebalanceTransactionMemo.Approval,
    transaction: {
      to: METH_ON_ETH_ADDRESS,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [BRIDGE, mEthAmount] }),
    },
  } : undefined;

  // 4. Bridge mETH to Mantle L2
  const bridgeTx = {
    memo: RebalanceTransactionMemo.Rebalance,
    transaction: {
      to: MANTLE_BRIDGE_CONTRACT_ADDRESS,
      data: encodeFunctionData({
        abi: MANTLE_BRIDGE_ABI,
        functionName: 'depositERC20To',
        args: [METH_L1, METH_L2, recipient, mEthAmount, 200000n, '0x'],
      }),
    },
  };

  return [unwrapTx, stakeTx, approvalTx, bridgeTx].filter(Boolean);
}
```

### 2. Message Hash Verification

The Mantle bridge uses cross-domain messaging. The adapter verifies bridge completion by:

1. Extracting `SentMessage` event from L1 transaction
2. Computing message hash using `relayMessage` encoding
3. Checking `successfulMessages` mapping on L2 messenger

```typescript
protected async getDepositStatus(route, originTransaction) {
  const message = this.extractMantleMessage(originTransaction, messengerAddress);
  const messageHash = this.computeMessageHash(message);
  
  const wasRelayed = await l2Client.readContract({
    address: L2_MESSENGER,
    functionName: 'successfulMessages',
    args: [messageHash],
  });
  
  if (wasRelayed) return { status: 'filled' };
  
  const failed = await this.wasMessageFailed(l2Client, L2_MESSENGER, messageHash);
  return { status: failed ? 'unfilled' : 'pending' };
}
```

### 3. Minimum Staking Amount

The mETH staking contract has a minimum stake bound:

```typescript
const MIN_STAKING_AMOUNT = 20000000000000000n; // 0.02 ETH

// Check against staking contract
const minimumStakeBound = await client.readContract({
  address: METH_STAKING_CONTRACT_ADDRESS,
  functionName: 'minimumStakeBound',
});
```

### 4. Bridge Identification

Operations are tagged to distinguish mETH flow from regular rebalancing:

```typescript
// Leg 1: Bridge to mainnet (tagged with "-mantle" suffix)
bridge: `${bridgeType}-mantle`  // e.g., "across-mantle", "binance-mantle"

// Leg 2: Mantle native bridge
bridge: SupportedBridge.Mantle  // "mantle"
```

### 5. Run Mode

The poller supports a dedicated mETH-only mode:

```typescript
if (process.env.RUN_MODE === 'methOnly') {
  const rebalanceOperations = await rebalanceMantleEth(context);
  // Only execute mETH rebalancing, skip invoice processing
}
```

---

## Configuration

### Chain IDs

```typescript
export const MAINNET_CHAIN_ID = '1';
export const MANTLE_CHAIN_ID = '5000';
```

### SupportedBridge Enum

```typescript
export enum SupportedBridge {
  Across = 'across',
  Binance = 'binance',
  CCTPV1 = 'cctpv1',
  CCTPV2 = 'cctpv2',
  Coinbase = 'coinbase',
  CowSwap = 'cowswap',
  Kraken = 'kraken',
  Near = 'near',
  Mantle = 'mantle',  // ✨ NEW
}
```

---

## Error Handling & Recovery

1. **Bridge Failure**: Falls back to next preference in list
2. **Slippage Exceeded**: Logs warning, tries next bridge
3. **Duplicate Earmark**: Unique constraint prevents double-processing
4. **Callback Timeout**: Operations remain in PENDING/AWAITING_CALLBACK for retry
5. **L2 Message Failure**: Detected via `FailedRelayedMessage` event logs

---

## Monitoring & Observability

- **Prometheus Metrics**: Balance tracking, operation counts
- **Structured Logging**: All operations logged with requestId, context
- **Database State**: Full audit trail in earmarks, rebalance_operations tables

---

## References

- [PR #418](https://github.com/everclearorg/mark/pull/418)
- [Mantle Bridge Documentation](https://docs.mantle.xyz/network/how-to/bridge)
- [mETH Staking](https://docs.mantle.xyz/meth/introduction)
- [Across Protocol Docs](https://docs.across.to/)

