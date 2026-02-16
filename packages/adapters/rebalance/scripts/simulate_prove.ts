import { createPublicClient, http, encodeFunctionData, parseEventLogs, keccak256, encodeAbiParameters, parseAbiParameters, parseAbi } from 'viem';
import { buildProveZircuitWithdrawal, getWithdrawals } from '@zircuit/zircuit-viem/op-stack';

const ZIRCUIT_OPTIMISM_PORTAL = '0x17bfAfA932d2e23Bd9B909Fd5B4D2e2a27043fb1';
const ZIRCUIT_L2_OUTPUT_ORACLE = '0x92Ef6Af472b39F1b363da45E35530c24619245A4';

const zircuitOptimismPortalAbi = parseAbi([
  'function proveWithdrawalTransaction((uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data) _tx, uint256 _l2OutputIndex, (bytes32 version, bytes32 stateRoot, bytes32 messagePasserStorageRoot, bytes32 latestBlockhash) _outputRootProof, bytes[] calldata _withdrawalProof)',
]);
const zircuitL2ToL1MessagePasserAbi = parseAbi([
  'event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)',
]);

async function main() {
  const l2Client = createPublicClient({ transport: http('https://zircuit-mainnet.drpc.org') });
  const l1Client = createPublicClient({ transport: http('https://ethereum.publicnode.com') });

  // Get the original receipt
  const receipt = await l2Client.getTransactionReceipt({
    hash: '0x4a5203d25bbe1fd6aa3536e013f017d5d2f21c5996167173d3ec03bdeb977426'
  });
  console.log('Got receipt, block:', receipt.blockNumber);

  // Extract withdrawal using our method
  const logs = parseEventLogs({ abi: zircuitL2ToL1MessagePasserAbi, logs: receipt.logs });
  const messagePassedEvent = logs.find((log) => log.eventName === 'MessagePassed');
  if (!messagePassedEvent) {
    console.error('No MessagePassed event found');
    return;
  }
  const args = (messagePassedEvent as any).args;
  const withdrawalTx = {
    nonce: args.nonce,
    sender: args.sender,
    target: args.target,
    value: args.value,
    gasLimit: args.gasLimit,
    data: args.data,
  };
  console.log('Withdrawal nonce:', withdrawalTx.nonce.toString());
  console.log('Withdrawal nonce (hex):', '0x' + withdrawalTx.nonce.toString(16));
  console.log('Withdrawal sender:', withdrawalTx.sender);
  console.log('Withdrawal target:', withdrawalTx.target);
  console.log('Withdrawal value:', withdrawalTx.value.toString());

  // Also get withdrawal from the library
  const libWithdrawals = getWithdrawals(receipt);
  console.log('\nLibrary withdrawal nonce:', libWithdrawals[0]?.nonce.toString());
  console.log('Library withdrawal hash:', libWithdrawals[0]?.withdrawalHash);

  // Our computed hash
  const ourHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('uint256, address, address, uint256, uint256, bytes'),
      [withdrawalTx.nonce, withdrawalTx.sender, withdrawalTx.target, withdrawalTx.value, withdrawalTx.gasLimit, withdrawalTx.data],
    ),
  );
  console.log('\nOur computed hash:', ourHash);
  console.log('Library hash:', libWithdrawals[0]?.withdrawalHash);
  console.log('Hash match:', ourHash === libWithdrawals[0]?.withdrawalHash);

  // Build proof
  console.log('\nBuilding proof...');
  try {
    const proofResult = await buildProveZircuitWithdrawal(l2Client as any, {
      receipt: receipt as any,
      l1Client: l1Client as any,
      l2OutputOracleAddress: ZIRCUIT_L2_OUTPUT_ORACLE as `0x${string}`,
    } as any);

    console.log('Proof built successfully');
    console.log('l2OutputIndex:', (proofResult.l2OutputIndex as bigint).toString());
    console.log('withdrawalProof length:', proofResult.withdrawalProof.length);
    console.log('withdrawalProof[0] length:', (proofResult.withdrawalProof[0] as string).length);
    console.log('outputRootProof:', JSON.stringify({
      version: proofResult.outputRootProof.version,
      stateRoot: proofResult.outputRootProof.stateRoot,
      messagePasserStorageRoot: proofResult.outputRootProof.messagePasserStorageRoot,
      latestBlockhash: proofResult.outputRootProof.latestBlockhash,
    }, null, 2));

    // Encode the calldata
    const calldata = encodeFunctionData({
      abi: zircuitOptimismPortalAbi,
      functionName: 'proveWithdrawalTransaction',
      args: [
        withdrawalTx,
        proofResult.l2OutputIndex as bigint,
        proofResult.outputRootProof as any,
        proofResult.withdrawalProof as `0x${string}`[],
      ],
    });
    console.log('\nCalldata length:', calldata.length);
    console.log('Function selector:', calldata.slice(0, 10));

    // Simulate the call
    console.log('\nSimulating call on L1...');
    try {
      await l1Client.call({
        to: ZIRCUIT_OPTIMISM_PORTAL as `0x${string}`,
        data: calldata,
      });
      console.log('*** Simulation SUCCEEDED ***');
    } catch (e: any) {
      console.error('*** Simulation FAILED ***');
      console.error('Error:', e.message?.slice(0, 1000));
    }
  } catch (e: any) {
    console.error('Proof building failed:', e.message?.slice(0, 1000));
  }
}

main().catch(console.error);
