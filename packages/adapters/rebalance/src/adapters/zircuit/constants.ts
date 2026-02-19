import { parseAbi } from 'viem';

// Contract addresses (Optimism Bedrock style)
export const ZIRCUIT_L1_STANDARD_BRIDGE = '0x386B76D9cA5F5Fb150B6BFB35CF5379B22B26dd8';
export const ZIRCUIT_L2_STANDARD_BRIDGE = '0x4200000000000000000000000000000000000010';
export const ZIRCUIT_OPTIMISM_PORTAL = '0x17bfAfA932d2e23Bd9B909Fd5B4D2e2a27043fb1';
export const ZIRCUIT_L2_OUTPUT_ORACLE = '0x92Ef6Af472b39F1b363da45E35530c24619245A4';
export const ZIRCUIT_L2_TO_L1_MESSAGE_PASSER = '0x4200000000000000000000000000000000000016';

// Chain IDs
export const ETHEREUM_CHAIN_ID = 1;
export const ZIRCUIT_CHAIN_ID = 48900;

// Finalization period (4 hours in seconds) — verified on-chain from L2OutputOracle.FINALIZATION_PERIOD_SECONDS()
export const CHALLENGE_PERIOD_SECONDS = 4 * 60 * 60;

// L1 Standard Bridge ABI (Optimism Bedrock StandardBridge interface)
export const zircuitL1StandardBridgeAbi = parseAbi([
  'function bridgeETH(uint32 _minGasLimit, bytes calldata _extraData) payable',
  'function bridgeETHTo(address _to, uint32 _minGasLimit, bytes calldata _extraData) payable',
  'function bridgeERC20(address _localToken, address _remoteToken, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData)',
  'function bridgeERC20To(address _localToken, address _remoteToken, address _to, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData)',
  'function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes calldata _extraData) payable',
  'function finalizeBridgeERC20(address _localToken, address _remoteToken, address _from, address _to, uint256 _amount, bytes calldata _extraData)',
  'event ETHBridgeInitiated(address indexed _from, address indexed _to, uint256 _amount, bytes _extraData)',
  'event ERC20BridgeInitiated(address indexed _localToken, address indexed _remoteToken, address indexed _from, address _to, uint256 _amount, bytes _extraData)',
]);

// L2 Standard Bridge ABI
export const zircuitL2StandardBridgeAbi = parseAbi([
  'function withdraw(address _l2Token, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData) payable',
  'function withdrawTo(address _l2Token, address _to, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData) payable',
  'function bridgeETH(uint32 _minGasLimit, bytes calldata _extraData) payable',
  'function bridgeETHTo(address _to, uint32 _minGasLimit, bytes calldata _extraData) payable',
  'function bridgeERC20(address _localToken, address _remoteToken, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData)',
  'function bridgeERC20To(address _localToken, address _remoteToken, address _to, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData)',
  'event WithdrawalInitiated(address indexed _l1Token, address indexed _l2Token, address indexed _from, address _to, uint256 _amount, bytes _extraData)',
]);

// Optimism Portal ABI (for withdrawal proving and finalization)
export const zircuitOptimismPortalAbi = parseAbi([
  'function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _l2OutputIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] calldata _withdrawalProof)',
  'function finalizeWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx)',
  'function provenWithdrawals(bytes32) view returns (bytes32 outputRoot, uint128 timestamp, uint128 l2OutputIndex)',
  'function finalizedWithdrawals(bytes32) view returns (bool)',
  'event WithdrawalProven(bytes32 indexed withdrawalHash, address indexed from, address indexed to)',
  'event WithdrawalFinalized(bytes32 indexed withdrawalHash, bool success)',
]);

// L2 Output Oracle ABI
export const zircuitL2OutputOracleAbi = parseAbi([
  'function getL2OutputIndexAfter(uint256 _l2BlockNumber) view returns (uint256)',
  'function getL2Output(uint256 _l2OutputIndex) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))',
  'function latestOutputIndex() view returns (uint256)',
  'function FINALIZATION_PERIOD_SECONDS() view returns (uint256)',
]);

// L2 to L1 Message Passer ABI
export const zircuitL2ToL1MessagePasserAbi = parseAbi([
  'event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)',
]);

// ETH address representations
export const L2_ETH_TOKEN = '0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
