export const SOLANA_CHAINID = '1399811149';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export function isSvmChain(chainId: string): boolean {
  if (chainId === SOLANA_CHAINID) {
    return true;
  }
  return false;
}
