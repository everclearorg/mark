import { encodeFunctionData, isAddress as viemIsAddress, Hex } from 'viem';
import { ChainConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';

// ABI for the Zodiac RoleModule's execTransactionWithRole function
export const ZODIAC_ROLE_MODULE_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
      { internalType: 'uint8', name: 'operation', type: 'uint8' },
      { internalType: 'bytes32', name: 'roleKey', type: 'bytes32' },
      { internalType: 'bool', name: 'shouldRevert', type: 'bool' },
    ],
    name: 'execTransactionWithRole',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export interface ZodiacConfig {
  isEnabled: boolean;
  moduleAddress?: string;
  roleKey?: string;
  safeAddress?: string;
}

export interface TransactionRequest {
  to: string;
  data: string;
  value?: bigint | string | number;
  from?: string;
}

/**
 * Detects if Zodiac is enabled for a chain and returns the configuration
 */
export function detectZodiacConfiguration(chainConfig?: ChainConfiguration): ZodiacConfig {
  if (!chainConfig) {
    return { isEnabled: false };
  }

  const isEnabled = !!(
    chainConfig.zodiacRoleModuleAddress &&
    chainConfig.zodiacRoleKey &&
    chainConfig.gnosisSafeAddress
  );

  if (!isEnabled) {
    return { isEnabled: false };
  }

  return {
    isEnabled: true,
    moduleAddress: chainConfig.zodiacRoleModuleAddress,
    roleKey: chainConfig.zodiacRoleKey,
    safeAddress: chainConfig.gnosisSafeAddress,
  };
}

/**
 * Validates Zodiac configuration values and throws if invalid
 */
export function validateZodiacConfig(zodiacConfig: ZodiacConfig, logger?: Logger, context?: any): void {
  if (!zodiacConfig.isEnabled) {
    return;
  }

  if (!viemIsAddress(zodiacConfig.moduleAddress!)) {
    logger?.error('Invalid Zodiac Role Module address', {
      ...context,
      zodiacRoleModuleAddress: zodiacConfig.moduleAddress,
    });
    throw new Error('Invalid Zodiac Role Module address');
  }

  if (!zodiacConfig.roleKey!.startsWith('0x')) {
    logger?.error('Invalid Zodiac Role Key format', {
      ...context,
      zodiacRoleKey: zodiacConfig.roleKey,
    });
    throw new Error('Invalid Zodiac Role Key format');
  }

  if (!viemIsAddress(zodiacConfig.safeAddress!)) {
    logger?.error('Invalid Gnosis Safe address', {
      ...context,
      gnosisSafeAddress: zodiacConfig.safeAddress,
    });
    throw new Error('Invalid Gnosis Safe address');
  }
}

/**
 * Wraps a transaction request to be executed through the Zodiac role module
 */
export function wrapTransactionWithZodiac(
  txRequest: TransactionRequest,
  zodiacConfig: ZodiacConfig,
): TransactionRequest {
  if (!zodiacConfig.isEnabled) {
    return txRequest;
  }

  const wrappedData = encodeFunctionData({
    abi: ZODIAC_ROLE_MODULE_ABI,
    functionName: 'execTransactionWithRole',
    args: [
      txRequest.to as `0x${string}`, // Bridge contract address
      BigInt(txRequest.value || 0), // Native value to send to bridge
      txRequest.data as Hex, // Bridge call data
      0, // operation (CALL)
      zodiacConfig.roleKey as Hex, // roleKey
      true, // shouldRevert
    ],
  });

  return {
    to: zodiacConfig.moduleAddress!,
    data: wrappedData,
    value: 0, // Mark doesn't send native value to Zodiac module
    from: txRequest.from,
  };
}

/**
 * Returns the actual owner address (Safe or EOA) based on Zodiac configuration
 */
export function getActualOwner(zodiacConfig: ZodiacConfig, ownAddress: string): string {
  return zodiacConfig.isEnabled ? zodiacConfig.safeAddress! : ownAddress;
}

/**
 * Full Zodiac detection, validation, and configuration helper
 */
export function getValidatedZodiacConfig(
  chainConfig?: ChainConfiguration,
  logger?: Logger,
  context?: any,
): ZodiacConfig {
  const zodiacConfig = detectZodiacConfiguration(chainConfig);
  validateZodiacConfig(zodiacConfig, logger, context);
  return zodiacConfig;
}
