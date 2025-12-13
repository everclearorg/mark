# SOLANA_ONLY Rebalancing Adapter Specification

**Status**: Draft v2  
**Author**: Mark Team  
**Reviewers**: TBD

---

## 1. Objective

Rebalance solver inventory to maintain ptUSDe on Solana by:
1. Bridging USDC from Ethereum → Solana (Wormhole or Symbiosis)
2. Swapping USDC → USDe on Solana (Jupiter)
3. Minting USDe → ptUSDe (Pendle)

**Trigger**: ptUSDe balance on `config.ownSolAddress` falls below configured threshold.

---

## 2. Architecture

```
ETHEREUM (Chain 1)           SOLANA (Chain 1399811149)
──────────────────           ─────────────────────────
       │                              │
  ┌────┴────┐                         │
  │  USDC   │                         │
  └────┬────┘                         │
       │                              │
       │  ══ LEG 1: BRIDGE ══         │
       │  Wormhole: send + redeem     │
       │  ─────────────────────────►  │
       │                         ┌────┴────┐
       │                         │  USDC   │
       │                         └────┬────┘
       │                              │
       │                    ══ LEG 2: SWAP ══
       │                    Jupiter v6 API
       │                              │
       │                         ┌────┴────┐
       │                         │  USDe   │
       │                         └────┬────┘
       │                              │
       │                    ══ LEG 3: MINT ══
       │                    Pendle API
       │                              │
       │                         ┌────┴────┐
       │                         │ ptUSDe  │
       │                         └─────────┘
```

---

## 3. Prerequisites (MUST VERIFY BEFORE IMPLEMENTATION)

| Item | Status | Action Required |
|------|--------|-----------------|
| Pendle supports ptUSDe on Solana | ⚠️ TBD | Verify via Pendle docs/team |
| USDe SPL token mint address | ⚠️ TBD | Get from Ethena |
| ptUSDe SPL token mint address | ⚠️ TBD | Get from Pendle |
| Wormhole USDC route Eth→Sol works | ⚠️ TBD | Test with SDK |
| Jupiter has USDe/USDC liquidity | ⚠️ TBD | Check Jupiter UI |

---

## 4. Configuration

### 4.1 New Types (`packages/core/src/types/config.ts`)

```typescript
export interface SolanaRebalanceConfig {
  enabled: boolean;
  threshold: string;                // Min ptUSDe to trigger (6 decimals)
  targetBalance: string;            // Target after rebalance
  maxRebalanceAmount: string;       // Max USDC per operation (6 decimals)
  bridgePreference: 'wormhole' | 'symbiosis';
  slippage: {
    bridge: number;                 // dbps for bridge (default: 100 = 1%)
    swap: number;                   // dbps for Jupiter (default: 50 = 0.5%)  
    mint: number;                   // dbps for Pendle (default: 50 = 0.5%)
  };
}

// Add to SupportedBridge enum
export enum SupportedBridge {
  // ... existing
  Wormhole = 'wormhole',
  Symbiosis = 'symbiosis',
  Jupiter = 'jupiter',
  PendleSolana = 'pendle-solana',
}
```

### 4.2 Config Example

```json
{
  "solanaRebalance": {
    "enabled": true,
    "threshold": "1000000000",
    "targetBalance": "5000000000",
    "maxRebalanceAmount": "2000000000",
    "bridgePreference": "wormhole",
    "slippage": {
      "bridge": 100,
      "swap": 50,
      "mint": 50
    }
  }
}
```

### 4.3 Key Management

**Critical**: Solana signing requires different handling than EVM.

```typescript
// Existing pattern (chains[SOLANA_CHAINID].privateKey)
// Private key stored as hex: "0x..."
// Convert to Keypair for signing:
import { Keypair } from '@solana/web3.js';
const secretKey = Buffer.from(privateKeyHex.slice(2), 'hex');
const keypair = Keypair.fromSecretKey(secretKey);
```

**Security**: Follow existing pattern - key loaded from environment/config, never logged.

---

## 5. Adapters

### 5.1 Wormhole Bridge Adapter

**Location**: `packages/adapters/rebalance/src/adapters/wormhole/`

**Files**:
- `wormhole.ts` - Main adapter
- `types.ts` - Wormhole-specific types
- `index.ts` - Exports

```typescript
export class WormholeBridgeAdapter implements BridgeAdapter {
  constructor(
    private readonly chains: Record<string, ChainConfiguration>,
    private readonly logger: Logger,
    private readonly solanaKeypair: Keypair, // Required for redemption
  ) {}

  type(): SupportedBridge { return SupportedBridge.Wormhole; }
  
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    // Wormhole USDC is 1:1 minus relayer fee (~0.1%)
    // Use SDK to get exact quote
  }
  
  async getMinimumAmount(route: RebalanceRoute): Promise<string | null> {
    return '1000000'; // 1 USDC minimum
  }
  
  async send(
    sender: string,    // EVM address
    recipient: string, // Solana address (base58)
    amount: string,
    route: RebalanceRoute
  ): Promise<MemoizedTransactionRequest[]> {
    // Returns EVM transaction to initiate transfer
    // Uses Wormhole SDK TokenBridge
  }
  
  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTx: TransactionReceipt
  ): Promise<boolean> {
    // Check if VAA is available AND funds are redeemed on Solana
    // Query: https://api.wormholescan.io/api/v1/vaas/{chainId}/{emitter}/{seq}
  }
  
  async destinationCallback(
    route: RebalanceRoute,
    originTx: TransactionReceipt
  ): Promise<MemoizedTransactionRequest | void> {
    // CRITICAL: Wormhole requires redemption tx on Solana
    // This returns a Solana transaction (not EVM!)
    // Must be handled differently in callback executor
  }
  
  // New method for Solana-specific redemption
  async redeemOnSolana(vaa: Uint8Array): Promise<string> {
    // Submit redemption transaction to Solana
    // Returns Solana tx signature
  }
}
```

**Wormhole Flow (2 steps)**:
1. `send()` → EVM tx locks USDC, emits message
2. Wait for Guardian signatures (VAA)
3. `redeemOnSolana()` → Solana tx claims USDC

**Completion Detection**:
```typescript
// 1. Check VAA exists
const vaaResponse = await fetch(
  `https://api.wormholescan.io/api/v1/vaas/${ethChainId}/${emitterAddress}/${sequence}`
);
// 2. Check if already redeemed (query Solana token account balance)
```

### 5.2 Jupiter Swap Adapter

**Location**: `packages/adapters/rebalance/src/adapters/jupiter/`

**Note**: Does NOT implement `BridgeAdapter` - creates new `SolanaSwapAdapter` interface.

```typescript
export interface SolanaSwapAdapter {
  type(): SupportedBridge;
  getQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number): Promise<JupiterQuote>;
  buildSwapTransaction(quote: JupiterQuote, userPublicKey: string): Promise<VersionedTransaction>;
  executeSwap(tx: VersionedTransaction, keypair: Keypair): Promise<string>; // Returns tx signature
}

export class JupiterSwapAdapter implements SolanaSwapAdapter {
  private readonly baseUrl = 'https://quote-api.jup.ag/v6';
  
  async getQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number): Promise<JupiterQuote> {
    // GET /quote?inputMint=...&outputMint=...&amount=...&slippageBps=...
  }
  
  async buildSwapTransaction(quote: JupiterQuote, userPublicKey: string): Promise<VersionedTransaction> {
    // POST /swap with quote and user pubkey
    // Returns serialized transaction
  }
  
  async executeSwap(tx: VersionedTransaction, keypair: Keypair): Promise<string> {
    tx.sign([keypair]);
    const connection = new Connection(rpcUrl);
    return await connection.sendTransaction(tx);
  }
}
```

**Completion Detection**: 
```typescript
await connection.confirmTransaction(signature, 'finalized');
```

### 5.3 Pendle Mint Adapter

**Location**: `packages/adapters/rebalance/src/adapters/pendle/`

```typescript
export interface SolanaMintAdapter {
  type(): SupportedBridge;
  getMintQuote(inputToken: string, amount: string): Promise<PendleQuote>;
  buildMintTransaction(quote: PendleQuote, userPublicKey: string): Promise<VersionedTransaction>;
  executeMint(tx: VersionedTransaction, keypair: Keypair): Promise<string>;
}

export class PendleSolanaMintAdapter implements SolanaMintAdapter {
  // Pendle API: https://api-v2.pendle.finance/sdk/api/v1
  // VERIFY: Pendle Solana support for ptUSDe
}
```

---

## 6. Database Operations

### 6.1 Bridge Identifiers

| Bridge Value | Leg | Description |
|--------------|-----|-------------|
| `wormhole-solana` | 1 | USDC bridge initiation |
| `wormhole-solana-redeem` | 1b | VAA redemption on Solana |
| `jupiter-solana` | 2 | USDC → USDe swap |
| `pendle-solana` | 3 | USDe → ptUSDe mint |

### 6.2 State Machine

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SOLANA REBALANCE STATE FLOW                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  LEG 1a: BRIDGE SEND         LEG 1b: REDEEM          LEG 2: SWAP                │
│  (wormhole-solana)           (wormhole-solana-redeem) (jupiter-solana)          │
│                                                                                  │
│  ┌────────────────┐                                                             │
│  │ PENDING        │  EVM tx sent, waiting for VAA                               │
│  └───────┬────────┘                                                             │
│          │ VAA available                                                        │
│          ▼                                                                      │
│  ┌────────────────┐                                                             │
│  │ AWAITING_CB    │  Ready for redemption                                       │
│  └───────┬────────┘                                                             │
│          │ Redeem tx executed                                                   │
│          ▼                                                                      │
│  ┌────────────────┐         ┌────────────────┐                                  │
│  │ COMPLETED      │────────►│ PENDING        │  Swap initiated                  │
│  └────────────────┘         └───────┬────────┘                                  │
│                                     │ Swap confirmed                            │
│                                     ▼                                           │
│  LEG 3: MINT                ┌────────────────┐                                  │
│  (pendle-solana)            │ COMPLETED      │                                  │
│                             └───────┬────────┘                                  │
│  ┌────────────────┐                 │                                           │
│  │ PENDING        │◄────────────────┘  Mint initiated                           │
│  └───────┬────────┘                                                             │
│          │ Mint confirmed                                                       │
│          ▼                                                                      │
│  ┌────────────────┐                                                             │
│  │ COMPLETED      │  ✓ ptUSDe available                                         │
│  └────────────────┘                                                             │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Earmark Usage

**Decision**: NO earmarks for Solana rebalancing.

Rationale: Earmarks are for invoice-triggered rebalancing (TAC, mETH). Solana flow is balance-threshold triggered without invoice linkage.

Set `earmarkId: null` in all operations.

---

## 7. Poller Implementation

### 7.1 File: `packages/poller/src/rebalance/solanaPtUsde.ts`

```typescript
import { SOLANA_CHAINID } from '@mark/core';

// Token addresses (MUST BE VERIFIED)
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDE_SOL = 'TODO'; // Get from Ethena
const PTUSDE_SOL = 'TODO'; // Get from Pendle

export async function rebalanceSolanaPtUsde(context: ProcessingContext): Promise<RebalanceAction[]> {
  const { logger, requestId, config, rebalance } = context;
  
  // 1. Process pending operations first
  await executeSolanaCallbacks(context);
  
  // 2. Check pause state
  if (await rebalance.isPaused()) {
    logger.warn('Solana rebalance paused', { requestId });
    return [];
  }
  
  // 3. Validate config
  if (!config.solanaRebalance?.enabled) {
    logger.debug('Solana rebalance not enabled');
    return [];
  }
  
  // 4. Check for in-flight operations (avoid concurrent rebalances)
  const { operations } = await context.database.getRebalanceOperations(undefined, undefined, {
    status: [RebalanceOperationStatus.PENDING, RebalanceOperationStatus.AWAITING_CALLBACK],
  });
  const activeSolanaOps = operations.filter(op => 
    op.bridge?.includes('solana') || op.bridge?.includes('jupiter') || op.bridge?.includes('pendle')
  );
  if (activeSolanaOps.length > 0) {
    logger.info('Active Solana rebalance in progress, skipping new initiation', {
      requestId,
      activeOps: activeSolanaOps.length,
    });
    return [];
  }
  
  // 5. Check ptUSDe balance
  const ptUsdeBalance = await getSolanaTokenBalance(
    config.ownSolAddress,
    PTUSDE_SOL,
    config.chains[SOLANA_CHAINID],
  );
  
  const threshold = BigInt(config.solanaRebalance.threshold);
  if (ptUsdeBalance >= threshold) {
    logger.debug('ptUSDe balance above threshold', {
      balance: ptUsdeBalance.toString(),
      threshold: threshold.toString(),
    });
    return [];
  }
  
  // 6. Check USDC balance on Ethereum
  const ethUsdcBalance = await getEthTokenBalance(
    config.ownAddress,
    USDC_ETH,
    config.chains['1'],
  );
  
  const minRebalanceAmount = 1000000n; // 1 USDC
  if (ethUsdcBalance < minRebalanceAmount) {
    logger.warn('Insufficient USDC on Ethereum for rebalance', {
      balance: ethUsdcBalance.toString(),
    });
    return [];
  }
  
  // 7. Calculate amount to rebalance
  const target = BigInt(config.solanaRebalance.targetBalance);
  const shortfall = target - ptUsdeBalance;
  const maxAmount = BigInt(config.solanaRebalance.maxRebalanceAmount);
  const amountToRebalance = min(shortfall, maxAmount, ethUsdcBalance);
  
  logger.info('Initiating Solana ptUSDe rebalance', {
    requestId,
    ptUsdeBalance: ptUsdeBalance.toString(),
    threshold: threshold.toString(),
    amountToRebalance: amountToRebalance.toString(),
  });
  
  // 8. Execute Leg 1: Bridge USDC to Solana
  return await executeBridgeLeg(context, amountToRebalance);
}

async function executeBridgeLeg(
  context: ProcessingContext,
  amount: bigint,
): Promise<RebalanceAction[]> {
  const { config, rebalance, logger, requestId, chainService } = context;
  
  const bridgeType = config.solanaRebalance!.bridgePreference === 'wormhole'
    ? SupportedBridge.Wormhole
    : SupportedBridge.Symbiosis;
  
  const adapter = rebalance.getAdapter(bridgeType);
  
  const route = {
    origin: 1,
    destination: Number(SOLANA_CHAINID),
    asset: USDC_ETH,
  };
  
  // Get quote
  const receivedAmount = await adapter.getReceivedAmount(amount.toString(), route);
  
  // Check slippage
  const slippageDbps = BigInt(config.solanaRebalance!.slippage.bridge);
  const minAcceptable = amount - (amount * slippageDbps) / 10000n;
  if (BigInt(receivedAmount) < minAcceptable) {
    logger.warn('Bridge quote exceeds slippage tolerance', {
      amount: amount.toString(),
      received: receivedAmount,
      minAcceptable: minAcceptable.toString(),
    });
    return [];
  }
  
  // Build and submit bridge transaction
  const sender = config.ownAddress;
  const recipient = config.ownSolAddress;
  
  const txRequests = await adapter.send(sender, recipient, amount.toString(), route);
  
  // Submit EVM transactions
  for (const { transaction, memo } of txRequests) {
    await submitTransactionWithLogging({
      chainService,
      logger,
      chainId: '1',
      txRequest: {
        to: transaction.to!,
        data: transaction.data!,
        value: (transaction.value || 0).toString(),
        chainId: 1,
        from: sender,
        funcSig: transaction.funcSig || '',
      },
      zodiacConfig: { walletType: WalletType.EOA },
      context: { requestId, bridgeType, transactionType: memo },
    });
  }
  
  // Create operation record
  await createRebalanceOperation({
    earmarkId: null, // No earmark for balance-threshold rebalancing
    originChainId: 1,
    destinationChainId: Number(SOLANA_CHAINID),
    tickerHash: USDC_TICKER_HASH,
    amount: amount.toString(),
    slippage: config.solanaRebalance!.slippage.bridge,
    status: RebalanceOperationStatus.PENDING,
    bridge: `${bridgeType}-solana`,
    recipient,
  });
  
  return [{
    bridge: bridgeType,
    amount: amount.toString(),
    origin: 1,
    destination: Number(SOLANA_CHAINID),
    asset: USDC_ETH,
    transaction: '', // Populated after confirmation
    recipient,
  }];
}

export async function executeSolanaCallbacks(context: ProcessingContext): Promise<void> {
  // Implementation follows tacUsdt.ts pattern
  // Handle each leg's state transitions
  // CRITICAL: Solana txs require different submission path than EVM
}
```

### 7.2 Run Mode (`packages/poller/src/init.ts`)

```typescript
if (process.env.RUN_MODE === 'solanaOnly') {
  logger.info('Starting Solana ptUSDe rebalancing', { addresses });
  
  const ops = await rebalanceSolanaPtUsde(context);
  
  return {
    statusCode: 200,
    body: JSON.stringify({ rebalanceOperations: ops }),
  };
}
```

---

## 8. Solana Transaction Handling

**Critical Gap**: Existing `submitTransactionWithLogging` is EVM-only.

### 8.1 New Helper: `packages/poller/src/helpers/solana.ts`

```typescript
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

export async function submitSolanaTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  keypair: Keypair,
  logger: Logger,
  context: Record<string, unknown>,
): Promise<{ signature: string; confirmed: boolean }> {
  transaction.sign([keypair]);
  
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });
  
  logger.info('Submitted Solana transaction', { ...context, signature });
  
  const confirmation = await connection.confirmTransaction(signature, 'finalized');
  
  if (confirmation.value.err) {
    throw new Error(`Solana tx failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  return { signature, confirmed: true };
}

export async function getSolanaTokenBalance(
  owner: string,
  mint: string,
  chainConfig: ChainConfiguration,
): Promise<bigint> {
  const connection = new Connection(chainConfig.providers[0]);
  // Query token account and return balance
}

export function getSolanaKeypair(config: MarkConfiguration): Keypair {
  const hexKey = config.chains[SOLANA_CHAINID]?.privateKey;
  if (!hexKey) throw new Error('Solana private key not configured');
  return Keypair.fromSecretKey(Buffer.from(hexKey.slice(2), 'hex'));
}
```

---

## 9. Token Addresses

| Token | Chain | Address | Decimals |
|-------|-------|---------|----------|
| USDC | Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| USDC | Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| USDe | Solana | **TBD** | 6 |
| ptUSDe | Solana | **TBD** | 6 |

**Action Required**: Verify addresses before implementation.

---

## 10. Error Handling & Recovery

| Scenario | Handling | Recovery |
|----------|----------|----------|
| Bridge VAA timeout (>1hr) | Log warning, continue polling | Auto-retry on next cycle |
| Bridge redemption fails | Mark PENDING, retry next cycle | Manual if 3+ failures |
| Swap fails (slippage) | Mark CANCELLED | USDC remains on Solana |
| Mint fails | Mark CANCELLED | USDe remains on Solana |
| Insufficient gas (ETH) | Skip cycle, log error | Fund wallet |
| Insufficient gas (SOL) | Skip cycle, log error | Fund wallet |
| RPC timeout | Retry with backoff | Use fallback RPC |

### 10.1 Stuck Operation Cleanup

Add to `cleanupExpiredRegularRebalanceOps`:
```typescript
// Mark Solana operations as ORPHANED after 24 hours in PENDING
```

---

## 11. Testing Strategy

| Level | Scope | Environment |
|-------|-------|-------------|
| Unit | Each adapter method | Mocked APIs |
| Integration | Single leg execution | Devnet |
| E2E | Full 3-leg flow | Testnet |
| Smoke | Small amount (~$1) | Mainnet |

### 11.1 Test Cases

- [ ] Wormhole: VAA generation and redemption
- [ ] Jupiter: Quote accuracy within slippage
- [ ] Pendle: Mint rate matches API quote
- [ ] Callback: Correct leg transitions
- [ ] Concurrency: No duplicate operations
- [ ] Recovery: Resume from any failed state

---

## 12. Implementation Checklist

1. [ ] Verify Pendle Solana support for ptUSDe
2. [ ] Get USDe and ptUSDe mint addresses
3. [ ] Add enums to `SupportedBridge`
4. [ ] Create `SolanaSwapAdapter` interface
5. [ ] Implement `WormholeBridgeAdapter`
6. [ ] Implement `JupiterSwapAdapter`
7. [ ] Implement `PendleSolanaMintAdapter`
8. [ ] Add Solana helpers (`solana.ts`)
9. [ ] Create `solanaPtUsde.ts` poller
10. [ ] Register adapters in factory
11. [ ] Add `solanaOnly` run mode
12. [ ] Add config types and validation
13. [ ] Write unit tests
14. [ ] Integration test on devnet
15. [ ] E2E test on testnet

---

## 13. Dependencies

```json
{
  "@wormhole-foundation/sdk": "^1.0.0",
  "@solana/web3.js": "^1.95.0",
  "@solana/spl-token": "^0.4.0"
}
```

---

## 14. Open Questions

1. **Pendle Solana**: Does Pendle API support ptUSDe minting on Solana? Need verification.
2. **ATA Creation**: Who creates Associated Token Accounts for new tokens?
3. **Priority Fees**: Should we use priority fees for Solana txs during congestion?
4. **Fallback**: If Wormhole fails, should we auto-fallback to Symbiosis?

---

## 15. References

- [Wormhole SDK Docs](https://wormhole.com/docs/tools/typescript-sdk/get-started/)
- [Wormholescan API](https://docs.wormholescan.io/)
- [Jupiter API](https://dev.jup.ag/api-reference)
- [Pendle API](https://docs.pendle.finance/pendle-v2/Developers/Backend/ApiOverview)
- [Symbiosis API](https://docs.symbiosis.finance/developer-tools/symbiosis-api)
- Existing patterns: `tacUsdt.ts`, `mantleEth.ts`, `stargate.ts`
