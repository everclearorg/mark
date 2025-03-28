import { encodeFunctionData } from 'viem';
import { getMulticallAddress, multicallAbi } from './contracts';
import { MarkConfiguration } from '@mark/core';

/**
 * Prepares a multicall transaction to batch multiple intent creation calls
 * @param calls - Array of transaction data objects from createNewIntent calls
 * @param sendValues - Whether the calls include ETH values
 * @param chainId - The chain ID to get the correct Multicall3 address
 * @param config - The MarkConfiguration object
 * @returns The multicall transaction data
 */
export const prepareMulticall = (
  calls: Array<{
    to: string;
    data: string;
    value?: string;
  }>,
  sendValues = false,
  chainId: string,
  config: MarkConfiguration,
): {
  to: string;
  data: string;
  value?: string;
} => {
  let calldata: string;
  let totalValue = BigInt(0);

  if (sendValues) {
    // Format the calls for the multicall contract with values
    const multicallCalls = calls.map((call) => {
      const value = BigInt(call.value || '0');
      totalValue += value;

      return {
        target: call.to as `0x${string}`,
        allowFailure: false,
        value: value,
        callData: call.data as `0x${string}`,
      };
    });

    // Encode the multicall function call using aggregate3Value
    calldata = encodeFunctionData({
      abi: multicallAbi,
      functionName: 'aggregate3Value',
      args: [multicallCalls],
    });
  } else {
    // Format the calls for the multicall contract without values
    const multicallCalls = calls.map((call) => {
      return {
        target: call.to as `0x${string}`,
        allowFailure: false,
        callData: call.data as `0x${string}`,
      };
    });

    // Encode the multicall function call using aggregate3
    calldata = encodeFunctionData({
      abi: multicallAbi,
      functionName: 'aggregate3',
      args: [multicallCalls],
    });
  }

  // Get the chain-specific Multicall3 address
  const multicallAddress = getMulticallAddress(chainId, config);

  return {
    to: multicallAddress,
    data: calldata,
    value: totalValue.toString(),
  };
};
