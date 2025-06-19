import { encodeFunctionData, isAddress as viemIsAddress, Hex } from 'viem';
import { ChainConfiguration, LoggingContext, TransactionRequest, WalletConfig, WalletType } from '@mark/core';
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

/**
 * Detects if Zodiac is enabled for a chain and returns the configuration
 */
export function detectZodiacConfiguration(chainConfig?: ChainConfiguration): WalletConfig {
  if (!chainConfig) {
    return { walletType: WalletType.EOA };
  }

  const walletType = !!(
    chainConfig.zodiacRoleModuleAddress &&
    chainConfig.zodiacRoleKey &&
    chainConfig.gnosisSafeAddress
  )
    ? WalletType.Zodiac
    : WalletType.EOA;

  if (walletType === WalletType.EOA) {
    return { walletType: WalletType.EOA };
  }

  return {
    walletType,
    moduleAddress: chainConfig.zodiacRoleModuleAddress as `0x${string}`,
    roleKey: chainConfig.zodiacRoleKey as `0x${string}`,
    safeAddress: chainConfig.gnosisSafeAddress as `0x${string}`,
  };
}

/**
 * Validates Zodiac configuration values and throws if invalid
 */
export function validateZodiacConfig(walletConfig: WalletConfig, logger?: Logger, context?: LoggingContext): void {
  if (walletConfig.walletType !== WalletType.Zodiac) {
    return;
  }

  if (!viemIsAddress(walletConfig.moduleAddress!)) {
    logger?.error('Invalid Zodiac Role Module address', {
      ...context,
      zodiacRoleModuleAddress: walletConfig.moduleAddress,
    });
    throw new Error('Invalid Zodiac Role Module address');
  }

  if (!walletConfig.roleKey!.startsWith('0x')) {
    logger?.error('Invalid Zodiac Role Key format', {
      ...context,
      zodiacRoleKey: walletConfig.roleKey,
    });
    throw new Error('Invalid Zodiac Role Key format');
  }

  validateSafeConfig(walletConfig, logger, context);
}

export function validateSafeConfig(walletConfig: WalletConfig, logger?: Logger, context?: LoggingContext) {
  if (!viemIsAddress(walletConfig.safeAddress ?? '')) {
    logger?.error('Invalid Gnosis Safe address', {
      ...context,
      gnosisSafeAddress: walletConfig.safeAddress,
    });
    throw new Error('Invalid Gnosis Safe address');
  }
}

/**
 * Wraps a transaction request to be executed through the Zodiac role module
 */
export async function wrapTransactionWithZodiac(
  txRequest: TransactionRequest,
  zodiacConfig: WalletConfig,
): Promise<TransactionRequest> {
  if (zodiacConfig.walletType !== WalletType.Zodiac) {
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
    value: '0', // Mark doesn't send native value to Zodiac module
    from: txRequest.from,
    chainId: txRequest.chainId,
  };
}

/**
 * Returns the actual owner address (Safe or EOA) based on Zodiac configuration
 */
export function getActualOwner(zodiacConfig: WalletConfig, ownAddress: string): string {
  return zodiacConfig.walletType === WalletType.EOA ? ownAddress : zodiacConfig.safeAddress!;
}

/**
 * Full Zodiac detection, validation, and configuration helper
 */
export function getValidatedZodiacConfig(
  chainConfig?: ChainConfiguration,
  logger?: Logger,
  context?: LoggingContext,
): WalletConfig {
  const zodiacConfig = detectZodiacConfiguration(chainConfig);
  validateZodiacConfig(zodiacConfig, logger, context);
  return zodiacConfig;
}
