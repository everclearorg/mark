export const USDC_CONTRACTS: Record<string, string> = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  linea: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  sonic: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

// Transfer Parameters
export const CHAIN_ID_TO_DOMAIN: Record<number, string> = {
  42161: 'arbitrum',
  10: 'optimism',
  1: 'ethereum',
  137: 'polygon',
  8453: 'base',
  1399811149: 'solana',
  130: 'unichain',
  43114: 'avalanche',
  59144: 'linea',
  146: 'sonic',
};

export const CHAIN_ID_TO_NUMERIC_DOMAIN: Record<number, number> = {
  1: 0, // ethereum
  43114: 1, // avalanche
  10: 2, // optimism
  42161: 3, // arbitrum
  1399811149: 5, // Solana
  8453: 6, // base
  137: 7, // polygon,
  130: 10, // unichain
  59144: 11, // linea
  146: 13, // sonic
};

export const TOKEN_MESSENGERS_V1: Record<string, string> = {
  ethereum: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
  avalanche: '0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982',
  optimism: '0x2B4069517957735bE00ceE0fadAE88a26365528f',
  arbitrum: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
  base: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
  polygon: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
  unichain: '0x4e744b28E787c3aD0e810eD65A24461D4ac5a762',
};

export const MESSAGE_TRANSMITTERS_V1: Record<string, string> = {
  ethereum: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81',
  avalanche: '0x8186359aF5F57FbB40c6b14A588d2A59C0C29880',
  optimism: '0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8',
  arbitrum: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
  base: '0xAD09780d193884d503182aD4588450C416D6F9D4',
  polygon: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
  unichain: '0x353bE9E2E38AB1D19104534e4edC21c643Df86f4',
};

export const TOKEN_MESSENGERS_V2: Record<string, string> = {
  ethereun: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  avalanche: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  optimism: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  arbitrum: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  base: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  polygon: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  unichain: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  linea: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  sonic: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
};

export const MESSAGE_TRANSMITTERS_V2: Record<string, string> = {
  ethereum: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  avalanche: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  optimism: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  arbitrum: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  base: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  polygon: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  unichain: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  linea: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  sonic: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
};
