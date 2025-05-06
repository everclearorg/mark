#!/usr/bin/env node
import { config } from 'dotenv';
import { Logger } from '@mark/logger';
import { getEverclearConfig, ChainConfiguration } from '@mark/core';
import { AcrossBridgeAdapter } from '../src/adapters/across';
import { RebalanceRoute, BridgeAdapter, SupportedBridge } from '../src/types';
import { parseEther, Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Command } from 'commander';
import { createWalletClient, http, createPublicClient, getContract, type Hash, type TransactionReceipt, erc20Abi } from 'viem';
import { mainnet } from 'viem/chains';

// Load environment variables
config();

// Initialize logger
const logger = new Logger({
    level: 'debug',
    service: 'mark-dev'
});

interface AdapterOptions {
    amount: string;
    origin: string;
    destination: string;
    token?: string;
}

// Create CLI program
const program = new Command();

program
    .name('mark-dev')
    .description('Development tools for Mark protocol adapters')
    .version('0.1.0');

// Add adapter command
program
    .command('adapter')
    .description('Test a specific adapter')
    .argument('<type>', 'Adapter type (e.g. across)')
    .option('-a, --amount <amount>', 'Amount to test with (human units)', '0.01')
    .option('-o, --origin <chainId>', 'Origin chain ID', '1')
    .option('-d, --destination <chainId>', 'Destination chain ID', '10')
    .option('-t, --token <address>', 'Token address to test with')
    .action(async (type: SupportedBridge, options: AdapterOptions) => {
        try {
            // Get private key from env
            const privateKey = process.env.PRIVATE_KEY;
            if (!privateKey) {
                throw new Error('PRIVATE_KEY not found in .env');
            }

            // Create account from private key
            const account = privateKeyToAccount(privateKey as `0x${string}`);

            // Get chain configs
            const configs = await getEverclearConfig();
            if (!configs) {
                throw new Error('Failed to get chain configurations');
            }

            // Create appropriate adapter
            let adapter: BridgeAdapter;
            switch (type) {
                case 'across':
                    adapter = new AcrossBridgeAdapter(
                        'https://across-api.example.com', // TODO: Get from config
                        configs.chains,
                        logger
                    );
                    break;
                default:
                    throw new Error(`Unsupported adapter type: ${type}`);
            }

            // Test the adapter
            await testBridgeAdapter(adapter, account, configs.chains, options);
        } catch (error) {
            logger.error('Command failed', { error });
            process.exit(1);
        }
    });

async function testBridgeAdapter(
    adapter: BridgeAdapter,
    account: Account,
    configs: Record<string, ChainConfiguration>,
    options: AdapterOptions
) {
    logger.info('Starting bridge adapter test', {
        options,
        accountAddress: account.address,
        adapterType: adapter.type()
    });

    // Create route
    const route: RebalanceRoute = {
        asset: options.token || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Default to WETH
        origin: parseInt(options.origin),
        destination: parseInt(options.destination)
    };

    logger.info('Created route', { route });

    // Find the asset in the origin chain config
    const originChain = configs[route.origin.toString()];
    if (!originChain) {
        throw new Error(`Origin chain ${route.origin} not found in config`);
    }

    logger.info('Found origin chain config', {
        chainId: route.origin,
        providerCount: originChain.providers.length,
        assetCount: originChain.assets.length
    });

    const asset = originChain.assets.find(a => a.address.toLowerCase() === route.asset.toLowerCase());
    if (!asset) {
        throw new Error(`Asset ${route.asset} not found in origin chain ${route.origin}`);
    }

    logger.info('Found asset config', {
        symbol: asset.symbol,
        address: asset.address,
        decimals: asset.decimals,
        isNative: asset.isNative
    });

    // Convert amount using the correct decimals
    const amountInWei = (BigInt(options.amount) * BigInt(10 ** asset.decimals)).toString();
    logger.info('Converted amount to wei', {
        humanAmount: options.amount,
        weiAmount: amountInWei,
        decimals: asset.decimals
    });

    // Test getReceivedAmount
    const receivedAmount = await adapter.getReceivedAmount(amountInWei, route);
    logger.info('Received amount calculated', {
        inputAmount: amountInWei,
        receivedAmount,
        route,
        assetDecimals: asset.decimals,
        feePercentage: ((BigInt(amountInWei) - BigInt(receivedAmount)) * BigInt(100) / BigInt(amountInWei)).toString() + '%'
    });

    // Get the transaction request
    const txRequest = await adapter.send(amountInWei, route);
    if (!txRequest.to || !txRequest.data) {
        throw new Error('Invalid transaction request: missing to or data');
    }

    logger.info('Got transaction request', {
        to: txRequest.to,
        value: txRequest.value?.toString() || '0',
        dataLength: txRequest.data.length
    });

    // Create wallet client for the origin chain
    const walletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(originChain.providers[0])
    });

    // Create public client for contract interactions
    const publicClient = createPublicClient({
        chain: mainnet,
        transport: http(originChain.providers[0])
    });

    // If not native token, check and set allowance
    if (!asset.isNative) {
        const tokenContract = getContract({
            address: asset.address as `0x${string}`,
            abi: erc20Abi,
            client: publicClient
        });

        // Check current allowance
        const currentAllowance = await tokenContract.read.allowance([
            account.address,
            txRequest.to
        ]);

        logger.info('Current token allowance', {
            allowance: currentAllowance.toString(),
            required: amountInWei
        });

        // If allowance is insufficient, approve
        if (currentAllowance < BigInt(amountInWei)) {
            logger.info('Approving token spend...');
            const approveTx = await walletClient.writeContract({
                address: asset.address as `0x${string}`,
                abi: erc20Abi,
                functionName: 'approve',
                args: [txRequest.to, BigInt(amountInWei)]
            });

            logger.info('Approval transaction sent', {
                hash: approveTx
            });

            // Wait for approval transaction
            const approveReceipt = await publicClient.waitForTransactionReceipt({
                hash: approveTx
            });

            logger.info('Approval transaction confirmed', {
                blockNumber: approveReceipt.blockNumber,
                gasUsed: approveReceipt.gasUsed.toString()
            });
        }
    }

    // Send the bridge transaction
    logger.info('Sending bridge transaction...');
    const txHash = await walletClient.sendTransaction({
        to: txRequest.to,
        value: txRequest.value || 0n,
        data: txRequest.data
    });

    logger.info('Bridge transaction sent', {
        hash: txHash
    });

    // Wait for transaction confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash
    });

    logger.info('Bridge transaction confirmed', {
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        status: receipt.status
    });

    // Poll for transaction readiness
    logger.info('Starting to poll for transaction readiness...');
    let isReady = false;
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes with 10s intervals
    const pollInterval = 10000; // 10 seconds

    while (!isReady && attempts < maxAttempts) {
        attempts++;
        logger.info(`Polling attempt ${attempts}/${maxAttempts}...`);

        isReady = await adapter.readyOnDestination(amountInWei, route, receipt);

        if (!isReady) {
            logger.info('Transaction not ready yet, waiting...');
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
    }

    if (!isReady) {
        throw new Error('Transaction did not become ready within the timeout period');
    }

    logger.info('Transaction is ready on destination chain');

    // Check if callback is needed
    const callbackTx = await adapter.destinationCallback(amountInWei, route, receipt);
    if (!callbackTx) {
        logger.info('No callback transaction required');
        return {
            receivedAmount,
            bridgeTxHash: txHash,
            bridgeReceipt: receipt
        };
    }

    logger.info('Callback transaction required', {
        to: callbackTx.to,
        value: callbackTx.value?.toString() || '0',
        dataLength: callbackTx.data?.length || 0
    });

    // Create wallet client for destination chain
    const destinationChain = configs[route.destination.toString()];
    if (!destinationChain) {
        throw new Error(`Destination chain ${route.destination} not found in config`);
    }

    const destinationWalletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(destinationChain.providers[0])
    });

    // Send callback transaction
    logger.info('Sending callback transaction...');
    const callbackTxHash = await destinationWalletClient.sendTransaction({
        to: callbackTx.to,
        value: callbackTx.value || 0n,
        data: callbackTx.data || '0x'
    });

    logger.info('Callback transaction sent', {
        hash: callbackTxHash
    });

    // Wait for callback transaction confirmation
    const callbackReceipt = await publicClient.waitForTransactionReceipt({
        hash: callbackTxHash
    });

    logger.info('Callback transaction confirmed', {
        blockNumber: callbackReceipt.blockNumber,
        gasUsed: callbackReceipt.gasUsed.toString(),
        status: callbackReceipt.status
    });

    return {
        receivedAmount,
        bridgeTxHash: txHash,
        bridgeReceipt: receipt,
        callbackTxHash,
        callbackReceipt
    };
}

// Parse command line arguments
program.parse(); 