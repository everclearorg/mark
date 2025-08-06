export const TRON_CHAINID = '728126428';

export function isTvmChain(chainId: string): boolean {
  if (chainId === TRON_CHAINID) {
    return true;
  }
  return false;
}
