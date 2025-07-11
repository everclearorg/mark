import {
  GetExecutionStatusResponse,
  OneClickService,
  Quote,
  ApiError,
  QuoteRequest,
  TokenResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import assert from 'assert';
import { Address, Hash, Log, TransactionReceipt, Transaction } from 'viem';
import { parseEventLogs, erc20Abi, zeroAddress } from 'viem';

type GetDepositLogsParams = {
  originChainId: number;
  receipt: TransactionReceipt;
  value: bigint;
  filter?: Partial<{
    inputToken: Address;
    inputAmount: bigint;
  }>;
};

type DepositLog = {
  tokenAddress: Address;
  receiverAddress: Address;
  amount: bigint;
};

type Deposit = DepositLog & {
  originChainId: number;
  depositTxHash?: Hash;
  depositTxBlock?: bigint;
  actionSuccess?: boolean;
};

function logOneClickApiError(error: unknown, context: string): void {
  if (error instanceof ApiError) {
    console.error(`${context}: HTTP ${error.status} - ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`${context}: ${error.message}`);
  } else {
    console.error(`${context}: ${JSON.stringify(error)}`);
  }
}

export async function waitUntilQuoteExecutionCompletes(quote: Quote): Promise<void> {
  assert(quote.depositAddress, `Missing required field 'depositAddress'`);

  console.log(`Waiting for quote execution to complete ...`);

  let attempts = 20;

  while (attempts > 0) {
    try {
      const result = await OneClickService.getExecutionStatus(quote.depositAddress!);

      if (result.status === GetExecutionStatusResponse.status.SUCCESS) return;

      console.log(`Current quote status is ${result.status}`);
    } catch (error: unknown) {
      logOneClickApiError(error, `Failed to query execution status of deposit address ${quote.depositAddress!}`);
    } finally {
      // wait three seconds for the next attempt
      await new Promise((res) => setTimeout(res, 3_000));
      attempts -= 1;
    }
  }

  throw new Error(`Quote hasn't been settled after 60 seconds`);
}

async function safeGetQuote(requestBody: QuoteRequest): Promise<Quote | undefined> {
  try {
    const { quote } = await OneClickService.getQuote(requestBody);

    return quote;
  } catch (error: unknown) {
    logOneClickApiError(error, `Failed to get a quote`);

    return undefined;
  }
}

export async function getQuote(requestBody: QuoteRequest): Promise<Quote> {
  console.log('Querying a quote from 1Click API');

  const quote = await safeGetQuote(requestBody);

  if (!quote) {
    throw new Error(`No quote received!`);
  }

  if (!quote.depositAddress) {
    throw new Error(
      `Quote missing 'depositAddress' field. If this wasn't intended, ensure the 'dry' parameter is set to false when requesting a quote.`,
    );
  }

  console.log(`[>] Sending: ${quote.amountInFormatted} of ${requestBody.originAsset}`);
  console.log(`[<] Receiving: ${quote.amountOutFormatted} of ${requestBody.destinationAsset}`);

  return quote;
}

async function safeGetSupportedTokens(): Promise<TokenResponse[]> {
  try {
    return await OneClickService.getTokens();
  } catch (error) {
    logOneClickApiError(error, `Failed to get supported tokens`);

    return [];
  }
}

export async function getSupportedTokens(): Promise<TokenResponse[]> {
  const tokens = await safeGetSupportedTokens();

  if (tokens.length === 0) {
    throw new Error(`No tokens found!`);
  }

  return tokens;
}

export function getDepositFromLogs(params: GetDepositLogsParams): Deposit {
  const { originChainId, receipt, value, filter } = params;
  const standardizedDeposit = parseDepositLogs(receipt, value, filter);

  if (!standardizedDeposit) {
    throw new Error('No deposit log found.');
  }

  return {
    ...standardizedDeposit,
    depositTxHash: receipt.transactionHash,
    depositTxBlock: receipt.blockNumber,
    originChainId: originChainId,
  };
}

export function parseDepositLogs(
  fillReceipt: TransactionReceipt,
  value: bigint,
  filter?: Partial<{
    depositAddress: Address;
    inputAmount: bigint;
  }>,
): DepositLog | undefined {
    const logs = fillReceipt.logs;
    
    // Handle case where logs might be empty or not have expected structure
    const blockData = {
      depositTxHash: logs.length > 0 && logs[0]?.blockHash ? logs[0].blockHash : fillReceipt.blockHash,
      depositTxBlock: logs.length > 0 && logs[0]?.blockNumber ? logs[0].blockNumber : fillReceipt.blockNumber,
    };
    
  // Parse Transfer Logs
  const parsedTransferLog = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs,
    args: filter
      ? {
          to: filter.depositAddress as Address | undefined, // adjust as needed
          value: filter.inputAmount,
        }
      : undefined,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transferLog = parsedTransferLog?.[0] as any;
  if (transferLog) {
    return {
      ...blockData,
      tokenAddress: logs[0]?.address || zeroAddress,
      receiverAddress: transferLog.args.to,
      amount: transferLog.args.value,
    };
  } else {
    return {
        ...blockData,
        tokenAddress: zeroAddress,
        receiverAddress: fillReceipt.to as Address,
        amount: value
    }
  }
}
