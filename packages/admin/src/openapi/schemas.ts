import { z } from 'zod/v4';

const Uuid = z.uuid();
const HexString = z.string().regex(/^0x[0-9a-fA-F]*$/, 'Expected a hex string');
const DigitsString = z.string().regex(/^\d+$/, 'Expected a digits string');
const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, 'Expected a decimal string');

export const BigIntString = DigitsString.describe('A string representation of a bigint');
export const AmountDecimalString = DecimalString.describe('A decimal string');
export const ChainId = z.number().int().describe('Chain ID');

export const ErrorResponse = z
  .object({
    message: z.string().describe('Human-readable error message'),
    error: z
      .union([z.string(), z.record(z.string(), z.any())])
      .optional()
      .describe('Optional error details'),
  })
  .catchall(z.unknown())
  .describe('Generic error response');

export const SuccessResponse = z
  .object({
    message: z.string(),
  })
  .describe('Generic success response');

export const ForbiddenResponse = z
  .object({
    message: z.string(),
    recipient: z.string().optional(),
  })
  .catchall(z.unknown())
  .describe('Forbidden response');

export const EarmarkStatus = z.enum(['pending', 'ready', 'completed', 'cancelled', 'failed', 'expired']);
export const RebalanceOperationStatus = z.enum(['pending', 'awaiting_callback', 'completed', 'expired', 'cancelled']);

export const Earmark = z.object({
  id: Uuid,
  invoiceId: z.string(),
  designatedPurchaseChain: z.number().int(),
  tickerHash: z.string(),
  minAmount: z.string().describe('Amount (18-decimals string)'),
  status: EarmarkStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const TransactionEntry = z
  .object({
    id: Uuid,
    rebalanceOperationId: Uuid.nullable().optional(),
    transactionHash: z.string(),
    chainId: z.string(),
    cumulativeGasUsed: z.string(),
    effectiveGasPrice: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
    metadata: z.record(z.string(), z.any()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .catchall(z.unknown());

export const TransactionsByChain = z.record(z.string(), TransactionEntry);

export const RebalanceOperation = z
  .object({
    id: Uuid,
    earmarkId: Uuid.nullable().optional(),
    originChainId: z.number().int(),
    destinationChainId: z.number().int(),
    tickerHash: z.string(),
    amount: z.string().describe('Amount (18-decimals string)'),
    slippage: z.number().int().describe('Basis points'),
    bridge: z.string().nullable().optional(),
    status: RebalanceOperationStatus,
    recipient: z.string().nullable().optional(),
    isOrphaned: z.boolean().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    transactions: TransactionsByChain.optional(),
  })
  .catchall(z.unknown());

export const RebalanceOperationSummary = z
  .object({
    id: Uuid,
    status: RebalanceOperationStatus,
    originChainId: z.number().int(),
    destinationChainId: z.number().int(),
    tickerHash: z.string(),
    amount: z.string(),
    slippage: z.number().int(),
    bridge: z.string().nullable(),
    recipient: z.string().nullable(),
    isOrphaned: z.boolean().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .catchall(z.unknown());

export const EarmarkWithOperations = Earmark.extend({
  operations: z.array(RebalanceOperationSummary).optional(),
});

export const CancelEarmarkRequest = z.object({
  earmarkId: Uuid,
});

export const CancelRebalanceOperationRequest = z.object({
  operationId: Uuid,
});

export const TriggerSendRequest = z.object({
  chainId: ChainId,
  asset: z.string().describe('Token identifier as expected by Mark config (e.g. tickerHash or symbol)'),
  recipient: z.string().describe('Recipient address'),
  amount: BigIntString.describe('Amount in native units as a bigint string'),
  memo: z.string().optional(),
});

export const TriggerSendResponse = z.object({
  message: z.string(),
  transactionHash: z.string(),
  chainId: z.number().int(),
  asset: z.string(),
  recipient: z.string(),
  amount: z.string(),
  memo: z.string().optional(),
});

export const TriggerRebalanceRequest = z.object({
  originChain: ChainId,
  destinationChain: ChainId,
  asset: z.string().describe('Token identifier as expected by Mark config (e.g. tickerHash or symbol)'),
  amount: AmountDecimalString.describe('Human-readable amount (18-decimals string)'),
  bridge: z.string().describe('Bridge adapter type'),
  slippage: z.number().int().optional().describe('Basis points (e.g. 500 = 5%)'),
  earmarkId: Uuid.optional().describe('Optional earmark ID to attach this operation to'),
});

export const TriggerRebalanceResponse = z.object({
  message: z.string(),
  operation: z.object({
    id: Uuid,
    originChain: z.number().int(),
    destinationChain: z.number().int(),
    asset: z.string(),
    ticker: z.string(),
    amount: z.string().describe('Human-readable amount (18-decimals string)'),
    bridge: z.string(),
    status: RebalanceOperationStatus,
    transactionHashes: z.array(z.string()),
  }),
});

export const TriggerIntentRequest = z.object({
  origin: ChainId.describe('Origin chain ID'),
  destinations: z.array(ChainId).min(1).describe('Destination chain IDs'),
  to: z.string().describe('Receiver address (must be Mark ownAddress)'),
  inputAsset: z.string().describe('Token address on origin chain'),
  amount: z.union([DigitsString, z.number().int()]).describe('Amount in native units'),
  maxFee: z.union([DigitsString, z.number().int()]).describe('Max fee (must be 0 for safety)'),
  callData: HexString.optional().describe('Must be 0x for safety'),
  user: z.string().optional().describe('SVM-only user public key'),
});

export const TriggerIntentResponse = z.object({
  message: z.string(),
  transactionHash: z.string(),
  intentId: z.string().optional(),
  chainId: z.number().int(),
  blockNumber: z.number().int(),
});

export const TriggerSwapRequest = z.object({
  chainId: ChainId,
  inputAsset: z.string().describe('TickerHash, symbol, or address'),
  outputAsset: z.string().describe('TickerHash, symbol, or address'),
  amount: AmountDecimalString.describe('Human-readable amount (18-decimals string)'),
  slippage: z.number().int().optional().describe('Basis points (e.g. 500 = 5%)'),
  swapAdapter: z.string().optional().describe('Swap adapter name (defaults to cowswap)'),
  recipient: z.string().optional().describe('Recipient address (defaults to Mark ownAddress)'),
});

export const TriggerSwapResponse = z.object({
  message: z.string(),
  swap: z
    .object({
      orderUid: z.string(),
      chainId: z.number().int(),
      inputAsset: z.string(),
      outputAsset: z.string(),
      inputTicker: z.string(),
      outputTicker: z.string(),
      sellAmount: z.string(),
      buyAmount: z.string(),
      executedSellAmount: z.string().optional(),
      executedBuyAmount: z.string().optional(),
      slippage: z.string().optional().describe('Actual slippage in BPS, when available'),
      status: z.string().optional().describe('Optional status (e.g. pending_settlement)'),
      note: z.string().optional(),
    })
    .catchall(z.unknown()),
});

export const GetEarmarksResponse = z.object({
  earmarks: z.array(EarmarkWithOperations),
  total: z.number().int(),
});

export const GetRebalanceOperationsResponse = z.object({
  operations: z.array(RebalanceOperation),
  total: z.number().int(),
});

export const GetEarmarkDetailsResponse = z.object({
  earmark: Earmark,
  operations: z.array(RebalanceOperation),
});

export const GetRebalanceOperationDetailsResponse = z.object({
  operation: RebalanceOperation,
});
