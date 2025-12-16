import { Address } from 'viem';

export interface CCIPMessage {
  receiver: `0x${string}`;
  data: `0x${string}`;
  tokenAmounts: Array<{
    token: Address;
    amount: bigint;
  }>;
  extraArgs: `0x${string}`;
  feeToken: Address;
}

export interface CCIPTransferStatus {
  status: 'PENDING' | 'SUCCESS' | 'FAILURE';
  message: string;
  destinationTransactionHash?: string;
}

// Chainlink CCIP Chain Selectors
export const CHAIN_SELECTORS = {
  ETHEREUM: '5009297550715157269',
  ARBITRUM: '4949039107694359620', 
  OPTIMISM: '3734403246176062136',
  POLYGON: '4051577828743386545',
  BASE: '15971525489660198786',
  SOLANA: '124615329519749607',
} as const;

// CCIP Router addresses by chain ID
export const CCIP_ROUTER_ADDRESSES: Record<number, Address> = {
  1: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D',     // Ethereum Mainnet
  42161: '0x141fa059441E0ca23ce184B6A78bafD2A517DdE8',  // Arbitrum
  10: '0x261c05167db67B2b619f9d312e0753f3721ad6E8',     // Optimism  
  137: '0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe',   // Polygon
  8453: '0x881e3A65B4d4a04dD529061dd0071cf975F58bCD',   // Base
};

// Supported chains for CCIP operations
export const CCIP_SUPPORTED_CHAINS = {
  1: 'Ethereum',
  42161: 'Arbitrum',
  10: 'Optimism', 
  137: 'Polygon',
  8453: 'Base',
} as const;

export interface SolanaAddressEncoding {
  // Solana addresses are base58 strings, need to encode them for CCIP
  address: string;
  encoding: 'base58' | 'hex';
}