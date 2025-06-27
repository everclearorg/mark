import { getAddressDecoder, getAddressEncoder, isAddress } from '@solana/addresses';

export { isAddress } from '@solana/addresses';

export const SOLANA_CHAINID = '1399811149';

export const SOLANA_NATIVE_ASSET_ID = '11111111111111111111111111111111';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export function isSvmChain(chainId: string): boolean {
  if (chainId === SOLANA_CHAINID) {
    return true;
  }
  return false;
}

export function hexToBase58(inputString: string): string {
  if (!inputString.startsWith('0x')) {
    throw Error('invalid hex input');
  }
  const decoder = getAddressDecoder();
  const buf = Buffer.from(inputString.slice(2), 'hex');
  return decoder.decode(buf);
}

export function base58ToHex(inputString: string): string {
  if (!isAddress(inputString)) {
    throw Error('invalid base58 input');
  }
  const encoder = getAddressEncoder();
  const buf = encoder.encode(inputString);
  return Buffer.from(buf).toString('hex');
}
