export const USDC_CONTRACTS: Record<string, string> = {
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

// Transfer Parameters
export const MAX_FEE = 50n; // Set fast transfer max fee in 10^6 subunits (0.0005 USDC; change as needed)

export const DOMAINS = {
  optimism: 2,
  arbitrum: 3,
  base: 6,
};

export const CHAIN_ID_TO_DOMAIN: Record<number, string> = {
    42161: 'arbitrum',
    // ...add all supported chain IDs
  };

export const TOKEN_MESSENGERS_V1: Record<string, string> = {
  avalanche: '0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982',
  ethereum: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
  optimism: '0x2B4069517957735bE00ceE0fadAE88a26365528f',
  arbitrum: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
  base: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
  polygon: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
  unichain: '0x4e744b28E787c3aD0e810eD65A24461D4ac5a762',
};

export const MESSAGE_TRANSMITTERS_V1: Record<string, string> = {
  avalanche: '0x8186359aF5F57FbB40c6b14A588d2A59C0C29880',
  ethereum: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81',
  optimism: '0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8',
  arbitrum: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
  base: '0xAD09780d193884d503182aD4588450C416D6F9D4',
  polygon: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
  unichain: '0x353bE9E2E38AB1D19104534e4edC21c643Df86f4',
};

export const TOKEN_MESSENGERS_V2: Record<string, string> = {
  arbitrum: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
};

export const MESSAGE_TRANSMITTERS_V2: Record<string, string> = {
  base: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
};
