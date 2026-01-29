#!/usr/bin/env npx tsx

/**
 * Script to derive TON USDT Jetton Wallet Address from a mnemonic
 * 
 * Usage:
 *   npx tsx scripts/ton-jetton-address.ts
 *   
 * Then paste your mnemonic when prompted.
 * 
 * The script will output:
 *   - Your TON wallet address
 *   - Your USDT Jetton wallet address (the address where your USDT is stored)
 */

import * as readline from 'readline';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4, Address, TonClient, JettonMaster } from '@ton/ton';

// USDT Jetton Master on TON Mainnet
const USDT_JETTON_MASTER_ADDRESS = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

// TON RPC endpoints
const TON_RPC_ENDPOINTS = [
  'https://toncenter.com/api/v2/jsonRPC',
  'https://ton.drpc.org/rest/mainnet',
];

async function getMnemonicFromUser(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n🔐 Enter your TON mnemonic (space-separated words): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function deriveWalletAddress(mnemonic: string): Promise<{
  address: Address;
  publicKey: Buffer;
}> {
  // Parse mnemonic
  const words = mnemonic.split(/\s+/).filter(w => w.length > 0);
  
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(`Invalid mnemonic: expected 12 or 24 words, got ${words.length}`);
  }

  // Derive keypair from mnemonic
  const keypair = await mnemonicToPrivateKey(words);

  // Create V4 wallet (most common wallet type)
  const wallet = WalletContractV4.create({
    publicKey: keypair.publicKey,
    workchain: 0, // Mainnet workchain
  });

  return {
    address: wallet.address,
    publicKey: keypair.publicKey,
  };
}

async function getJettonWalletAddress(
  ownerAddress: Address,
  jettonMasterAddress: string,
): Promise<Address | null> {
  // Try each RPC endpoint
  for (const endpoint of TON_RPC_ENDPOINTS) {
    try {
      const client = new TonClient({ endpoint });
      
      // Parse jetton master address
      const masterAddress = Address.parse(jettonMasterAddress);
      
      // Open jetton master contract
      const jettonMaster = client.open(JettonMaster.create(masterAddress));
      
      // Get the jetton wallet address for the owner
      const jettonWalletAddress = await jettonMaster.getWalletAddress(ownerAddress);
      
      return jettonWalletAddress;
    } catch (error) {
      console.log(`  ⚠️  RPC ${endpoint} failed, trying next...`);
      continue;
    }
  }
  
  return null;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║         TON USDT Jetton Wallet Address Derivation            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  // Get mnemonic from user
  const mnemonic = await getMnemonicFromUser();
  
  if (!mnemonic) {
    console.error('\n❌ No mnemonic provided');
    process.exit(1);
  }
  
  console.log('\n⏳ Processing...\n');
  
  try {
    // Derive wallet address
    const { address } = await deriveWalletAddress(mnemonic);
    
    console.log('┌────────────────────────────────────────────────────────────────┐');
    console.log('│ RESULTS                                                        │');
    console.log('├────────────────────────────────────────────────────────────────┤');
    console.log(`│ TON Wallet Address:                                            │`);
    console.log(`│   ${address.toString({ bounceable: false })}       │`);
    console.log(`│                                                                │`);
    console.log(`│ TON Wallet Address (raw):                                      │`);
    console.log(`│   ${address.toRawString()}       │`);
    console.log('├────────────────────────────────────────────────────────────────┤');
    
    // Get Jetton wallet address
    console.log('│ Fetching USDT Jetton wallet address from chain...             │');
    
    const jettonWalletAddress = await getJettonWalletAddress(address, USDT_JETTON_MASTER_ADDRESS);
    
    if (jettonWalletAddress) {
      console.log('├────────────────────────────────────────────────────────────────┤');
      console.log(`│ USDT Jetton Master Address:                                    │`);
      console.log(`│   ${USDT_JETTON_MASTER_ADDRESS}   │`);
      console.log(`│                                                                │`);
      console.log(`│ YOUR USDT Jetton Wallet Address:                               │`);
      console.log(`│   ${jettonWalletAddress.toString({ bounceable: true })}       │`);
      console.log(`│                                                                │`);
      console.log(`│ YOUR USDT Jetton Wallet (raw):                                 │`);
      console.log(`│   ${jettonWalletAddress.toRawString()}       │`);
    } else {
      console.log('├────────────────────────────────────────────────────────────────┤');
      console.log('│ ⚠️  Could not fetch Jetton wallet address from RPC            │');
      console.log('│   (May not have USDT or RPC is unavailable)                   │');
    }
    
    console.log('└────────────────────────────────────────────────────────────────┘');
    
    // Also output as simple copy-pasteable format
    console.log('\n📋 Copy-paste format:\n');
    console.log(`TON_WALLET_ADDRESS=${address.toString({ bounceable: false })}`);
    console.log(`TON_USDT_JETTON_MASTER_ADDRESS=${USDT_JETTON_MASTER_ADDRESS}`);
    if (jettonWalletAddress) {
      console.log(`TON_USDT_JETTON_WALLET_ADDRESS=${jettonWalletAddress.toString({ bounceable: true })}`);
    }
    console.log('');
    
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();



