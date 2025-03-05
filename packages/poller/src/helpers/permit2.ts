import { Address, PublicClient, WalletClient, parseAbi, maxUint256 } from 'viem';
import { Wallet } from 'ethers';
import { Web3Signer } from '@mark/web3signer';

/**
 * Before using Permit2, Mark needs to perform a one-time approval for each token:
 * 
 * 1. Mark must approve the Permit2 contract to spend tokens on its behalf.
 *    This is a standard ERC20 approval transaction that needs to happen once per token:
 *    
 *    // Approve Permit2 for maximum amount (effectively infinite approval)
 *    ```
 *    const tokenContract = getContract({
 *      address: tokenAddress,
 *      abi: erc20Abi,
 *      walletClient: client
 *    });
 *    const hash = await tokenContract.write.approve([
 *      PERMIT2_ADDRESS,
 *      MaxUint256 // 2^256 - 1
 *    ]);
 *    ```
 *    
 * 2. This approval allows Permit2 to transfer tokens on Mark's behalf when provided
 *    with a valid signature.
 *    
 * 3. After this approval, Mark can use Permit2 signatures to authorize transfers
 *    without needing additional on-chain approvals.
 *    
 * 4. The approval is permanent until explicitly revoked by setting the allowance to zero.
 *    
 * 5. Security considerations:
 *    - Approving Permit2 gives it permission to move tokens, so ensure you're using
 *      the canonical Permit2 contract address (0x000000000022D473030F116dDEE9F6B43aC78BA3)
 *    - Nonces should be managed carefully to prevent replay attacks
 *    - Deadlines should be set reasonably to limit the validity period of signatures
 */

// Permit2 is deployed at the same address on all chains
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/**
 * Checks if Mark has already approved Permit2 for a specific token
 * 
 * @param tokenAddress The ERC20 token address
 * @param ownerAddress Mark's address
 * @param publicClient viem's PublicClient for reading blockchain data
 * @returns True if Permit2 has sufficient allowance, false otherwise
 */
export async function hasPermit2Allowance(
  tokenAddress: Address,
  ownerAddress: Address,
  publicClient: PublicClient
): Promise<boolean> {
  const erc20Abi = parseAbi([
    'function allowance(address owner, address spender) view returns (uint256)',
  ]);
  
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ownerAddress, PERMIT2_ADDRESS],
  });
  
  // Check if allowance is sufficient (should be very large for Permit2)
  // A reasonable threshold might be 2^200 or higher
  return allowance >= 2n ** 200n;
}

/**
 * Approves the Permit2 contract to spend tokens on Mark's behalf
 * This is a one-time setup that needs to be done for each token
 * 
 * @param tokenAddress The ERC20 token address
 * @param walletClient viem's WalletClient for sending transactions
 * @param ownerAddress Mark's address
 * @returns The transaction hash
 */
export async function approvePermit2(
  tokenAddress: Address,
  walletClient: WalletClient,
  ownerAddress: Address
): Promise<`0x${string}`> {
  const erc20Abi = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
  ]);
  
  const hash = await walletClient.writeContract({
    account: ownerAddress,
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [PERMIT2_ADDRESS, maxUint256],
    chain: walletClient.chain,
  });
  
  return hash;
}

/**
 * Gets a Permit2 signature for token approval using Web3Signer or ethers Wallet
 * @param signer The Web3Signer or Wallet instance
 * @param chainId The chain ID
 * @param token The token address
 * @param spender The spender address
 * @param amount The amount to approve
 * @param nonce The nonce for the permit
 * @param deadline The deadline for the permit
 * @param permit2Address The Permit2 contract address
 * @returns The signature
 */
export async function getPermit2Signature(
  signer: Web3Signer | Wallet,
  chainId: number,
  token: string,
  spender: string,
  amount: string,
  nonce: string,
  deadline: number,
  permit2Address: string
): Promise<string> {
  // Create the domain for the Permit2 contract
  const domain = {
    name: 'Permit2',
    chainId: chainId,
    verifyingContract: permit2Address
  };

  // Define the types for the permit
  const types = {
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' }
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'expiration', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }
    ]
  };

  // Create the permit data
  const value = {
    details: {
      token: token,
      amount: amount,
      expiration: deadline,
      nonce: nonce
    },
    spender: spender,
    sigDeadline: deadline
  };

  try {
    // Check if signer is Web3Signer (has signTypedData method)
    if ('signTypedData' in signer && typeof signer.signTypedData === 'function') {
      // Use Web3Signer's signTypedData method
      return await signer.signTypedData(
        domain,
        types,
        value
      );
    } else if (signer instanceof Wallet) {
      // Use ethers Wallet's _signTypedData method - allows for local using private key
      return await signer._signTypedData(
        domain,
        types,
        value
      );
    } else {
      throw new Error('Signer does not support signTypedData method');
    }
  } catch (error) {
    console.error('Error signing Permit2 data:', error);
    throw new Error(`Failed to sign Permit2 data: ${error}`);
  }
}

/**
 * Generates a unique nonce for Permit2
 * @returns A unique nonce as a string
 */
export function generatePermit2Nonce(): string {
  return BigInt(Date.now())
    .toString(16)
    .padStart(16, '0');
}

/**
 * Generates a deadline timestamp for Permit2
 * @param durationInSeconds Duration in seconds (default: 3600)
 * @returns A deadline timestamp
 */
export function generatePermit2Deadline(durationInSeconds = 3600): number {
  return Math.floor(Date.now() / 1000) + durationInSeconds;
}
