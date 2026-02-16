import { parseAbi } from 'viem';

export const ZKSYNC_L1_BRIDGE = '0x57891966931eb4bb6fb81430e6ce0a03aabde063';
export const ZKSYNC_L2_BRIDGE = '0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102';
export const ZKSYNC_DIAMOND_PROXY = '0x32400084c286cf3e17e7b677ea9583e60a000324';
export const ETH_TOKEN_L2 = '0x000000000000000000000000000000000000800A';
export const L1_MESSENGER = '0x0000000000000000000000000000000000008008';
export const WITHDRAWAL_DELAY_HOURS = 24;
export const BASE_COST_BUFFER_PERCENT = BigInt(20); // 20% buffer for gas price fluctuation; overpayment is refunded to _refundRecipient

// L1MessageSent event topic from L1Messenger system contract
export const L1_MESSAGE_SENT_TOPIC = '0x3a36e47291f4201faf137fab081d92295bce2d53be2c6ca68ba82c7faa9ce241';

export const zkSyncL1BridgeAbi = parseAbi([
  'function deposit(address _l2Receiver, address _l1Token, uint256 _amount, uint256 _l2TxGasLimit, uint256 _l2TxGasPerPubdataByte, address _refundRecipient) payable',
  'function finalizeWithdrawal(uint256 _l2BatchNumber, uint256 _l2MessageIndex, uint16 _l2TxNumberInBatch, bytes calldata _message, bytes32[] calldata _merkleProof)',
  'function isWithdrawalFinalized(uint256 _l2BatchNumber, uint256 _l2MessageIndex) view returns (bool)',
  'event DepositInitiated(bytes32 indexed l2DepositTxHash, address indexed from, address indexed to, address l1Token, uint256 amount)',
]);

export const zkSyncL2BridgeAbi = parseAbi([
  'function withdraw(address _l1Receiver, address _l2Token, uint256 _amount)',
  'event WithdrawalInitiated(address indexed l2Sender, address indexed l1Receiver, address indexed l2Token, uint256 amount)',
]);

export const zkSyncL2EthTokenAbi = parseAbi([
  'function withdraw(address _l1Receiver) payable',
]);

export const zkSyncDiamondProxyAbi = parseAbi([
  'function getTotalBatchesExecuted() view returns (uint256)',
  'function l2LogsRootHash(uint256 _batchNumber) view returns (bytes32)',
  'function l2TransactionBaseCost(uint256 _gasPrice, uint256 _l2GasLimit, uint256 _l2GasPerPubdataByteLimit) view returns (uint256)',
  'function requestL2Transaction(address _contractL2, uint256 _l2Value, bytes calldata _calldata, uint256 _l2GasLimit, uint256 _l2GasPerPubdataByteLimit, bytes[] calldata _factoryDeps, address _refundRecipient) payable returns (bytes32 canonicalTxHash)',
  'function finalizeEthWithdrawal(uint256 _l2BatchNumber, uint256 _l2MessageIndex, uint16 _l2TxNumberInBatch, bytes calldata _message, bytes32[] calldata _merkleProof)',
  'function isEthWithdrawalFinalized(uint256 _l2BatchNumber, uint256 _l2MessageIndex) view returns (bool)',
]);
