import { Address } from 'viem';

// Solana (SVM) extra arguments structure for CCIP
export interface SVMExtraArgsV1 {
  computeUnits: bigint;
  accountIsWritableBitmap: bigint;
  allowOutOfOrderExecution: boolean;
  tokenReceiver: `0x${string}`;
  accounts: `0x${string}`[];
}

// Minimal AnyMessage shape used when calling the CCIP SDK
export interface SDKAnyMessage {
  receiver: `0x${string}`;
  data: `0x${string}`;
  extraArgs: SVMExtraArgsV1;
  tokenAmounts?: { token: Address; amount: bigint }[];
  feeToken?: Address;
  fee?: bigint;
}

export interface CCIPRequestTx {
  /** Transaction hash. */
  hash: string
  /** Logs emitted by this transaction. */
  logs: readonly unknown[]
  /** Block number containing this transaction. */
  blockNumber: number
  /** Unix timestamp of the block. */
  timestamp: number
  /** Sender address. */
  from: string
  /** Optional error if transaction failed. */
  error?: unknown
}
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
  messageId?: string;
  destinationTransactionHash?: string;
}

// Chainlink CCIP Chain Selectors (as strings to avoid BigInt issues)
// See: https://docs.chain.link/ccip/directory/mainnet
export const CHAIN_SELECTORS = {
  ETHEREUM: '5009297550715157269',
  ARBITRUM: '4949039107694359620',
  OPTIMISM: '3734403246176062136',
  POLYGON: '4051577828743386545',
  BASE: '15971525489660198786',
  SOLANA: '124615329519749607',
} as const;

// Map chain ID to CCIP chain selector (string to avoid overflow)
export const CHAIN_ID_TO_CCIP_SELECTOR: Record<number, string> = {
  1: CHAIN_SELECTORS.ETHEREUM,
  42161: CHAIN_SELECTORS.ARBITRUM,
  10: CHAIN_SELECTORS.OPTIMISM,
  137: CHAIN_SELECTORS.POLYGON,
  8453: CHAIN_SELECTORS.BASE,
  1399811149: CHAIN_SELECTORS.SOLANA,
};

// Solana chain ID as used in the system (from @mark/core SOLANA_CHAINID)
export const SOLANA_CHAIN_ID_NUMBER = 1399811149;

// CCIP Router addresses by chain ID
// See: https://docs.chain.link/ccip/directory/mainnet
export const CCIP_ROUTER_ADDRESSES: Record<number, string> = {
  1: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D', // Ethereum Mainnet
  42161: '0x141fa059441E0ca23ce184B6A78bafD2A517DdE8', // Arbitrum
  10: '0x261c05167db67B2b619f9d312e0753f3721ad6E8', // Optimism
  137: '0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe', // Polygon
  8453: '0x881e3A65B4d4a04dD529061dd0071cf975F58bCD', // Base
  1399811149: 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C', // Solana
};

// Supported chains for CCIP operations (EVM only)
export const CCIP_SUPPORTED_CHAINS = {
  1: 'Ethereum',
  42161: 'Arbitrum',
  10: 'Optimism',
  137: 'Polygon',
  8453: 'Base',
} as const;

// CCIP event signatures for extracting message ID from transaction logs
export const CCIP_SEND_REQUESTED_EVENT_SIGNATURE = '0xd0c3c799bf9e2639de44391e7b4a40c8e33e0e91e0c3e3e34b90b6c17a8e7ed1';

export interface SolanaAddressEncoding {
  // Solana addresses are base58 strings, need to encode them for CCIP
  address: string;
  encoding: 'base58' | 'hex';
}

// Chainlink CCIP Router ABI
export const CCIP_ROUTER_ABI = [
  {
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' },
        ],
      },
    ],
    name: 'getFee',
    outputs: [{ name: 'fee', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'extraArgs', type: 'bytes' },
          { name: 'feeToken', type: 'address' },
        ],
      },
    ],
    name: 'ccipSend',
    outputs: [{ name: 'messageId', type: 'bytes32' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

