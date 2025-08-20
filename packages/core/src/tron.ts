import { isSvmChain } from './solana';

export const TRON_CHAINID = '728126428';

export function isTvmChain(chainId: string): boolean {
  if (chainId === TRON_CHAINID) {
    return true;
  }
  return false;
}

export function isEvmChain(chainId: string): boolean {
  return !isTvmChain(chainId) && !isSvmChain(chainId);
}

export function prependHexPrefix(str: string): string {
  return str.startsWith(`0x`) ? str : `0x${str}`;
}

export function removeHexPrefix(str: string): string {
  return str.startsWith(`0x`) ? str.slice(2) : str;
}
