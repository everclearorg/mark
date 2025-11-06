// CowSwap SDK handles most of the API interactions
// We only need basic configuration here

// Chains supported by CowSwap SDK
// See: https://docs.cow.fi/cow-protocol/reference/sdks/cow-sdk
export const SUPPORTED_NETWORKS: Record<number, string> = {
  1: 'mainnet', // Ethereum
  100: 'gnosis', // Gnosis Chain
  137: 'polygon', // Polygon
  42161: 'arbitrum', // Arbitrum One
  8453: 'base', // Base
  11155111: 'sepolia', // Sepolia (testnet)
};

export const USDC_USDT_PAIRS: Record<number, { usdc: string; usdt: string }> = {
  1: {
    usdc: '0xA0b86a33E6417fad52e9d5e5d12a0749A9e9ad2B',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  100: {
    usdc: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
    usdt: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6',
  },
  137: {
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    usdt: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  },
  42161: {
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  },
  8453: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdt: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  },
};

// GPv2VaultRelayer contract addresses per chain
// These are the contracts that need approval to transfer tokens on behalf of users
export const COWSWAP_VAULT_RELAYER_ADDRESSES: Record<number, string> = {
  1: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // Ethereum mainnet
  100: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // Gnosis
  137: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // Polygon
  42161: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // Arbitrum
  8453: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // Base
  11155111: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // Sepolia
};
