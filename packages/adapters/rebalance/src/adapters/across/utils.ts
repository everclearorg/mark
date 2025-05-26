import { Address, Hash, Hex, isAddress, isHex, Log, parseEventLogs, TransactionReceipt, pad } from 'viem';
import { ACROSS_SPOKE_ABI } from './abi';

// https://github.com/across-protocol/toolkit/blob/c5010eb07312a936b6f59123afb4a7293bf2436b/packages/sdk/src/actions/getDepositFromLogs.ts#L6
type GetDepositLogsParams = {
  originChainId: number;
  receipt: TransactionReceipt;
  filter?: Partial<{
    inputToken: Address;
    outputToken: Address;
    destinationChainId: bigint;
    inputAmount: bigint;
    outputAmount: bigint;
  }>;
};

// https://github.com/across-protocol/toolkit/blob/master/packages/sdk/src/types/index.ts#L61
type DepositLog = {
  inputToken: Address;
  outputToken: Address;
  inputAmount: bigint;
  outputAmount: bigint;
  destinationChainId: number;
  depositId: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  depositor: Address;
  recipient: Address;
  exclusiveRelayer: Address;
  message: Hex;
  status: 'pending' | 'filled';
  depositTxHash: Hash;
  depositTxBlock: bigint;
};

// https://github.com/across-protocol/toolkit/blob/master/packages/sdk/src/types/index.ts#L61
type Deposit = DepositLog & {
  originChainId: number;
  fillTxHash?: Hash;
  fillTxBlock?: bigint;
  actionSuccess?: boolean;
};

// https://github.com/across-protocol/toolkit/blob/c5010eb07312a936b6f59123afb4a7293bf2436b/packages/sdk/src/actions/getDepositFromLogs.ts#L6
export function parseDepositLogs(
  logs: Log[],
  filter?: Partial<{
    inputToken: Address;
    outputToken: Address;
    destinationChainId: bigint;
    inputAmount: bigint;
    outputAmount: bigint;
  }>,
): DepositLog | undefined {
  const blockData = {
    depositTxHash: logs[0]!.blockHash!,
    depositTxBlock: logs[0]!.blockNumber!,
  };
  // Parse V3_5 Logs
  const parsedV3_5Logs = parseEventLogs({
    abi: ACROSS_SPOKE_ABI,
    eventName: 'FundsDeposited',
    logs,
    args: filter,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v3_5Log = parsedV3_5Logs?.[0] as any;
  if (v3_5Log) {
    return {
      ...blockData,
      depositId: v3_5Log.args.depositId,
      inputToken: bytes32ToAddress(v3_5Log.args.inputToken),
      outputToken: bytes32ToAddress(v3_5Log.args.outputToken),
      inputAmount: v3_5Log.args.inputAmount,
      outputAmount: v3_5Log.args.outputAmount,
      destinationChainId: Number(v3_5Log.args.destinationChainId),
      message: v3_5Log.args.message,
      depositor: bytes32ToAddress(v3_5Log.args.depositor),
      recipient: bytes32ToAddress(v3_5Log.args.recipient),
      exclusiveRelayer: bytes32ToAddress(v3_5Log.args.exclusiveRelayer),
      quoteTimestamp: v3_5Log.args.quoteTimestamp,
      fillDeadline: v3_5Log.args.fillDeadline,
      exclusivityDeadline: v3_5Log.args.exclusivityDeadline,
      status: 'pending',
    };
  }

  // Parse V3 Logs
  const parsedV3Logs = parseEventLogs({
    abi: ACROSS_SPOKE_ABI,
    eventName: 'V3FundsDeposited',
    logs,
    args: filter,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v3Log = parsedV3Logs?.[0] as any;
  if (v3Log) {
    return {
      ...blockData,
      depositId: BigInt(v3Log.args.depositId),
      inputToken: v3Log.args.inputToken,
      outputToken: v3Log.args.outputToken,
      inputAmount: v3Log.args.inputAmount,
      outputAmount: v3Log.args.outputAmount,
      destinationChainId: Number(v3Log.args.destinationChainId),
      message: v3Log.args.message,
      depositor: v3Log.args.depositor,
      recipient: v3Log.args.recipient,
      exclusiveRelayer: v3Log.args.exclusiveRelayer,
      quoteTimestamp: v3Log.args.quoteTimestamp,
      fillDeadline: v3Log.args.fillDeadline,
      exclusivityDeadline: v3Log.args.exclusivityDeadline,
      status: 'pending',
    };
  }

  return undefined;
}

// src: https://github.com/across-protocol/toolkit/blob/c5010eb07312a936b6f59123afb4a7293bf2436b/packages/sdk/src/actions/getDepositFromLogs.ts#L94
export function getDepositFromLogs(params: GetDepositLogsParams): Deposit {
  const { originChainId, receipt, filter } = params;
  const standardizedDeposit = parseDepositLogs(receipt.logs, filter);

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

// pulled from: https://github.com/across-protocol/toolkit/blob/c5010eb07312a936b6f59123afb4a7293bf2436b/packages/sdk/src/actions/waitForFillTx.ts#L152
export function parseFillLogs(
  logs: Log[],
  filter?: Partial<{
    inputToken: Address;
    outputToken: Address;
    originChainId: bigint;
    inputAmount: bigint;
    outputAmount: bigint;
    depositor: Address;
    depositId: bigint | number;
  }>,
) {
  if (!logs || logs.length === 0) {
    return undefined;
  }

  const blockData = {
    depositTxHash: logs[0]!.blockHash!,
    depositTxBlock: logs[0]!.blockNumber!,
  };

  // Parse V3_5 Logs
  // Convert address filters to bytes32 format for FilledRelay event
  const v3_5Filter = filter ? {
    ...filter,
    inputToken: filter.inputToken ? pad(filter.inputToken, { size: 32 }) : undefined,
    outputToken: filter.outputToken ? pad(filter.outputToken, { size: 32 }) : undefined,
    depositor: filter.depositor ? pad(filter.depositor, { size: 32 }) : undefined,
    depositId: filter?.depositId ? BigInt(filter?.depositId) : undefined,
  } : undefined;

  const parsedV3_5Logs = parseEventLogs({
    abi: ACROSS_SPOKE_ABI,
    eventName: 'FilledRelay',
    logs,
    args: v3_5Filter,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v3_5Log = parsedV3_5Logs?.[0] as any;

  if (v3_5Log) {
    return {
      ...blockData,
      inputToken: bytes32ToAddress(v3_5Log.args.inputToken),
      outputToken: bytes32ToAddress(v3_5Log.args.outputToken),
      inputAmount: v3_5Log.args.inputAmount,
      outputAmount: v3_5Log.args.outputAmount,
      repaymentChainId: v3_5Log.args.repaymentChainId,
      originChainId: v3_5Log.args.originChainId,
      depositId: v3_5Log.args.depositId,
      fillDeadline: v3_5Log.args.fillDeadline,
      exclusivityDeadline: v3_5Log.args.exclusivityDeadline,
      exclusiveRelayer: bytes32ToAddress(v3_5Log.args.exclusiveRelayer),
      relayer: bytes32ToAddress(v3_5Log.args.relayer),
      depositor: bytes32ToAddress(v3_5Log.args.depositor),
      recipient: bytes32ToAddress(v3_5Log.args.recipient),
      messageHash: v3_5Log.args.messageHash,
      relayExecutionInfo: {
        ...v3_5Log.args.relayExecutionInfo,
        updatedRecipient: bytes32ToAddress(v3_5Log.args.relayExecutionInfo.updatedRecipient),
        fillType: FillType?.[v3_5Log.args.relayExecutionInfo.fillType],
      },
    };
  }

  // Parse V3 Logs
  const parsedV3Logs = parseEventLogs({
    abi: ACROSS_SPOKE_ABI,
    eventName: 'FilledV3Relay',
    logs,
    args: { ...filter, depositId: Number(filter?.depositId) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v3Log = parsedV3Logs?.[0] as any;

  if (v3Log) {
    return {
      ...blockData,
      inputToken: v3Log.args.inputToken,
      outputToken: v3Log.args.outputToken,
      inputAmount: v3Log.args.inputAmount,
      outputAmount: v3Log.args.outputAmount,
      repaymentChainId: v3Log.args.repaymentChainId,
      originChainId: v3Log.args.originChainId,
      depositId: v3Log.args.depositId,
      fillDeadline: v3Log.args.fillDeadline,
      exclusivityDeadline: v3Log.args.exclusivityDeadline,
      exclusiveRelayer: v3Log.args.exclusiveRelayer,
      relayer: v3Log.args.relayer,
      depositor: v3Log.args.depositor,
      recipient: v3Log.args.recipient,
      message: v3Log.args.message,
      relayExecutionInfo: {
        ...v3Log.args.relayExecutionInfo,
        fillType: FillType?.[v3Log.args.relayExecutionInfo.fillType],
      },
    };
  }

  return undefined;
}

const FillType: { [key: number]: string } = {
  // Fast fills are normal fills that do not replace a slow fill request.
  0: 'FastFill',
  // Replaced slow fills are fast fills that replace a slow fill request. This type is used by the Dataworker
  // to know when to send excess funds from the SpokePool to the HubPool because they can no longer be used
  // for a slow fill execution.
  1: 'ReplacedSlowFill',
  2: 'SlowFill',
};

// src: https://github.com/across-protocol/toolkit/blob/master/packages/sdk/src/utils/hex.ts#L58
export function bytes32ToAddress(hex: Hex): Address | Hex {
  if (!isHex(hex)) {
    throw new Error('Invalid hex input');
  }

  //  already address
  if (hex.length === 42) {
    return hex as unknown as Address;
  }

  // Check if the first 12 bytes (24 hex characters) are padding (zeros)
  const padding = hex.slice(2, 26);
  const isPadded = /^0{24}$/.test(padding);

  if (isPadded) {
    const addressHex = `0x${hex.slice(-40)}`;

    if (!isAddress(addressHex)) {
      throw new Error('Invalid address extracted from bytes32');
    }

    return addressHex;
  }

  // Return the full bytes32 if not padded (SVM addresses)
  return hex;
}
