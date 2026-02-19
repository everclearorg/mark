import { parseAbi } from 'viem';

// Contract addresses
export const LINEA_L1_MESSAGE_SERVICE = '0xd19d4B5d358258f05D7B411E21A1460D11B0876F';
export const LINEA_L2_MESSAGE_SERVICE = '0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec';
export const LINEA_L1_TOKEN_BRIDGE = '0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319';
export const LINEA_L2_TOKEN_BRIDGE = '0x353012dc4a9A6cF55c941bADC267f82004A8ceB9';

// Chain IDs
export const ETHEREUM_CHAIN_ID = 1;
export const LINEA_CHAIN_ID = 59144;

// Anti-DDoS fee for L2→L1 messages (in wei) - approximately 0.001 ETH
export const L2_TO_L1_FEE = BigInt('1000000000000000');

// Finality window for L2→L1 messages (24 hours in seconds)
export const FINALITY_WINDOW_SECONDS = 24 * 60 * 60;

// Linea Message Service ABI
export const lineaMessageServiceAbi = parseAbi([
  // L1 Message Service
  'function sendMessage(address _to, uint256 _fee, bytes calldata _calldata) payable',
  'function claimMessageWithProof((bytes32[] proof, uint256 messageNumber, uint32 leafIndex, address from, address to, uint256 fee, uint256 value, address feeRecipient, bytes32 merkleRoot, bytes data) _params)',
  'event MessageSent(address indexed _from, address indexed _to, uint256 _fee, uint256 _value, uint256 _nonce, bytes _calldata, bytes32 indexed _messageHash)',
  'event MessageClaimed(bytes32 indexed _messageHash)',
  // L2 Message Service
  'function sendMessage(address _to, uint256 _fee, bytes calldata _calldata) payable',
]);

// Linea Token Bridge ABI
export const lineaTokenBridgeAbi = parseAbi([
  'function bridgeToken(address _token, uint256 _amount, address _recipient) payable',
  'function bridgeTokenWithPermit(address _token, uint256 _amount, address _recipient, bytes calldata _permitData) payable',
  'event BridgingInitiated(address indexed sender, address indexed recipient, address indexed token, uint256 amount)',
  'event BridgingFinalized(address indexed nativeToken, address indexed bridgedToken, uint256 amount, address indexed recipient)',
]);

// L1 MessageService deployment block (avoids scanning from genesis)
export const LINEA_L1_MESSAGE_SERVICE_DEPLOY_BLOCK = BigInt(17614000);

// Public L1 RPCs that support wide-range eth_getLogs queries.
// The Linea SDK queries from block 0 to latest, which commercial
// providers (Alchemy, Infura) reject due to block range limits.
export const LINEA_SDK_FALLBACK_L1_RPCS = [
  'https://ethereum.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth',
];
