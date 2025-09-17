// CowSwap SDK handles most of the API interactions
// We only need basic configuration here

export const SUPPORTED_NETWORKS: Record<number, string> = {
  1: 'mainnet',
  100: 'gnosis',
  11155111: 'sepolia',
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
};