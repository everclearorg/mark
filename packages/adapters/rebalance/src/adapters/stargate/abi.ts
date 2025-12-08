import { erc20Abi } from 'viem';

/**
 * Stargate V2 OFT/Pool ABI
 * Reference: https://stargateprotocol.gitbook.io/stargate/v2/developers/integrate-with-stargate
 */
export const STARGATE_OFT_ABI = [
  // Quote messaging fee
  {
    inputs: [
      {
        components: [
          { name: 'dstEid', type: 'uint32' },
          { name: 'to', type: 'bytes32' },
          { name: 'amountLD', type: 'uint256' },
          { name: 'minAmountLD', type: 'uint256' },
          { name: 'extraOptions', type: 'bytes' },
          { name: 'composeMsg', type: 'bytes' },
          { name: 'oftCmd', type: 'bytes' },
        ],
        name: '_sendParam',
        type: 'tuple',
      },
      { name: '_payInLzToken', type: 'bool' },
    ],
    name: 'quoteSend',
    outputs: [
      {
        components: [
          { name: 'nativeFee', type: 'uint256' },
          { name: 'lzTokenFee', type: 'uint256' },
        ],
        name: 'msgFee',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // Quote OFT transfer (get expected received amount after fees)
  {
    inputs: [
      {
        components: [
          { name: 'dstEid', type: 'uint32' },
          { name: 'to', type: 'bytes32' },
          { name: 'amountLD', type: 'uint256' },
          { name: 'minAmountLD', type: 'uint256' },
          { name: 'extraOptions', type: 'bytes' },
          { name: 'composeMsg', type: 'bytes' },
          { name: 'oftCmd', type: 'bytes' },
        ],
        name: '_sendParam',
        type: 'tuple',
      },
    ],
    name: 'quoteOFT',
    outputs: [
      {
        components: [
          { name: 'amountSentLD', type: 'uint256' },
          { name: 'amountReceivedLD', type: 'uint256' },
        ],
        name: 'oftLimit',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // Send function
  {
    inputs: [
      {
        components: [
          { name: 'dstEid', type: 'uint32' },
          { name: 'to', type: 'bytes32' },
          { name: 'amountLD', type: 'uint256' },
          { name: 'minAmountLD', type: 'uint256' },
          { name: 'extraOptions', type: 'bytes' },
          { name: 'composeMsg', type: 'bytes' },
          { name: 'oftCmd', type: 'bytes' },
        ],
        name: '_sendParam',
        type: 'tuple',
      },
      {
        components: [
          { name: 'nativeFee', type: 'uint256' },
          { name: 'lzTokenFee', type: 'uint256' },
        ],
        name: '_fee',
        type: 'tuple',
      },
      { name: '_refundAddress', type: 'address' },
    ],
    name: 'send',
    outputs: [
      {
        components: [
          { name: 'guid', type: 'bytes32' },
          { name: 'nonce', type: 'uint64' },
          {
            components: [
              { name: 'nativeFee', type: 'uint256' },
              { name: 'lzTokenFee', type: 'uint256' },
            ],
            name: 'fee',
            type: 'tuple',
          },
        ],
        name: 'msgReceipt',
        type: 'tuple',
      },
      {
        components: [
          { name: 'amountSentLD', type: 'uint256' },
          { name: 'amountReceivedLD', type: 'uint256' },
        ],
        name: 'oftReceipt',
        type: 'tuple',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  // OFTSent event
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'guid', type: 'bytes32' },
      { indexed: false, name: 'dstEid', type: 'uint32' },
      { indexed: true, name: 'fromAddress', type: 'address' },
      { indexed: false, name: 'amountSentLD', type: 'uint256' },
      { indexed: false, name: 'amountReceivedLD', type: 'uint256' },
    ],
    name: 'OFTSent',
    type: 'event',
  },
  // Token address getter
  {
    inputs: [],
    name: 'token',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * LayerZero Endpoint V2 ABI (for message verification)
 */
export const LZ_ENDPOINT_ABI = [
  {
    inputs: [
      { name: '_receiver', type: 'address' },
      { name: '_srcEid', type: 'uint32' },
      { name: '_sender', type: 'bytes32' },
      { name: '_nonce', type: 'uint64' },
    ],
    name: 'inboundPayloadHash',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Re-export ERC20 ABI for approvals
export { erc20Abi };
