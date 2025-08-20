import { config } from 'dotenv';
import { Logger } from '@mark/logger';
import { getEverclearConfig, ChainConfiguration, parseChainConfigurations, SupportedBridge, RebalanceRoute, MarkConfiguration } from '@mark/core';
import { BridgeAdapter, RebalanceTransactionMemo } from '../src/types';
import { Account, Hash, parseUnits, TransactionReceipt, createWalletClient, http, createPublicClient, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Command } from 'commander';
import * as chains from 'viem/chains'
import { RebalanceAdapter } from '../src';
import { RebalanceAction, RebalanceCache } from '@mark/cache';

function getViemChain(id: number) {
    for (const chain of Object.values(chains)) {
        if ('id' in chain) {
            if (chain.id === id) {
                return chain;
            }
        }
    }
}

// Load environment variables
config();

// Initialize logger
const logger = new Logger({
    level: 'debug',
    service: 'mark-dev'
});

// Initialize cache
const cache = new RebalanceCache('127.0.0.1', 6379);

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
        const parsed = await parseChainConfigurations(configs, ['WETH', 'USDC', 'USDT', 'ETH'], {});

        // Create appropriate adapter
        const rebalancer = new RebalanceAdapter({
            chains: parsed,
            kraken: { apiSecret: process.env.KRAKEN_API_SECRET, apiKey: process.env.KRAKEN_API_KEY },
            binance: { apiSecret: process.env.BINANCE_API_SECRET, apiKey: process.env.BINANCE_API_KEY }
        } as unknown as MarkConfiguration, logger, cache);
        const adapter = rebalancer.getAdapter(type);

        // Test the adapter
        await testBridgeAdapter(adapter, account, parsed, options);
    });

// Helper function to handle destination chain operations
async function handleDestinationChain(
    adapter: BridgeAdapter,
    account: Account,
    configs: Record<string, ChainConfiguration>,
    route: RebalanceRoute,
    receipt: TransactionReceipt
): Promise<{ callbackTxHash?: Hash; callbackReceipt?: TransactionReceipt }> {
    // Check if callback is needed
    const { transaction: callbackTx, memo } = await adapter.destinationCallback(route, receipt) ?? {};
    if (!callbackTx) {
        logger.info('No callback transaction required');
        return {};
    }

    logger.info('Callback transaction required', {
        memo,
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
        chain: getViemChain(route.destination),
        transport: http(destinationChain.providers[0])
    });

    // Create public client for destination chain
    const destinationPublicClient = createPublicClient({
        chain: getViemChain(route.destination),
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

    // Wait for callback transaction confirmation using public client
    const callbackReceipt = (await destinationPublicClient.waitForTransactionReceipt({
        hash: callbackTxHash
    })) as TransactionReceipt;

    logger.info('Callback transaction confirmed', {
        blockNumber: callbackReceipt.blockNumber,
        gasUsed: callbackReceipt.gasUsed.toString(),
        status: callbackReceipt.status
    });

    return {
        callbackTxHash,
        callbackReceipt
    };
}

// Helper function to poll for transaction readiness
async function pollForTransactionReady(
    adapter: BridgeAdapter,
    amountInWei: string,
    route: RebalanceRoute,
    receipt: TransactionReceipt
): Promise<void> {
    logger.info('Starting to poll for transaction readiness...');
    let isReady = false;
    let attempts = 0;
    const maxAttempts = 5; // 5 minutes with 10s intervals
    const pollInterval = 15_000; // 10 seconds

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
}

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

    const asset = Object.values(originChain.assets).find(a => a.address.toLowerCase() === route.asset.toLowerCase());
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
    const amountInWei = parseUnits(options.amount, asset.decimals).toString()
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
    });

    // Create wallet client for the origin chain
    const walletClient = createWalletClient({
        account,
        chain: getViemChain(route.origin),
        transport: http(originChain.providers[0])
    });

    // Get the transaction request
    const walletAddr = walletClient.account.address;
    const txRequests = await adapter.send(walletAddr, walletAddr, amountInWei, route);

    logger.info('Got transaction requests', {
        chain: route.origin,
        tx: txRequests,
    });

    // Create public client for contract interactions
    const publicClient = createPublicClient({
        chain: getViemChain(route.origin),
        transport: http(originChain.providers[0])
    });


    // Sanity check: sufficient balance
    const balance = asset.isNative
        ? await publicClient.getBalance({ address: account.address })
        : await publicClient.readContract({ abi: erc20Abi, address: asset.address as `0x${string}`, functionName: 'balanceOf', args: [account.address] })
    if (balance < BigInt(amountInWei)) {
        throw new Error(`${account.address} has insufficient balance of ${asset.symbol} (${asset.address}) on ${route.origin} to send via adapter. need ${amountInWei}, have ${balance}.`);
    }

    let toTrack: TransactionReceipt | undefined = undefined;
    for (const { transaction: txRequest, memo } of txRequests) {
        if (!txRequest.to || !txRequest.data) {
            throw new Error('Invalid transaction request: missing to or data');
        }

        // Send the bridge transaction
        logger.info(`Sending transaction request [${memo}]...`);
        const txHash = await walletClient.sendTransaction({
            to: txRequest.to,
            value: txRequest.value || 0n,
            data: txRequest.data
        });

        logger.info(`Bridge transaction sent [${memo}]`, {
            hash: txHash
        });

        // Wait for transaction confirmation
        const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash
        });
        if (memo === RebalanceTransactionMemo.Rebalance) {
            toTrack = receipt as TransactionReceipt;
        }

        logger.info(`Bridge transaction confirmed [${memo}]`, {
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            status: receipt.status
        });
    }

    if (!toTrack) {
        throw new Error(`No ${RebalanceTransactionMemo.Rebalance} receipt found in receipts.`)
    }

    // Add to the rebalance cache
    const rebalanceAction: RebalanceAction = {
        bridge: adapter.type(),
        amount: amountInWei.toString(),
        origin: route.origin,
        destination: route.destination,
        asset: route.asset,
        transaction: toTrack.transactionHash,
        recipient: account.address,
    };
    logger.info('Adding rebalance action to cache', {
        rebalanceAction,
        route,
        toTrack,
    });
    await cache.addRebalances([rebalanceAction]);

    // Poll for transaction readiness
    await pollForTransactionReady(adapter, amountInWei, route, toTrack);

    // Handle destination chain operations
    const result = await handleDestinationChain(adapter, account, configs, route, toTrack);

    logger.info('Bridge transaction completed', {
        bridgeTxHash: toTrack.transactionHash,
        ...result
    });
}

// Add resume command
program
    .command('resume <type>')
    .description('Resume a bridge transaction from a given transaction hash')
    .requiredOption('-o, --origin <chainId>', 'Origin chain ID')
    .requiredOption('-h, --hash <txHash>', 'Transaction hash to resume from')
    .option('-d, --destination <chainId>', 'Destination chain ID', '10')
    .option('-a, --amount <amount>', 'Original amount (in human units)', '0.01')
    .option('-t, --token <address>', 'Token address used in the transaction')
    .action(async (type: string, options: { origin: string; hash: string; destination: string; amount: string; token?: string }) => {
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
        const parsed = await parseChainConfigurations(configs, ['WETH', 'USDC', 'USDT', 'ETH'], {});

        // Create route
        const route: RebalanceRoute = {
            asset: options.token || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Default to WETH
            origin: parseInt(options.origin),
            destination: parseInt(options.destination)
        };

        // Create public client for the origin chain
        const originChain = parsed[route.origin.toString()];
        if (!originChain) {
            throw new Error(`Origin chain ${route.origin} not found in config`);
        }

        const publicClient = createPublicClient({
            chain: getViemChain(route.origin),
            transport: http(originChain.providers[0]) // TODO: use multiple providers if included
        });

        // Get transaction receipt
        const receipt = await publicClient.getTransactionReceipt({
            hash: options.hash as `0x${string}`
        });

        logger.info('Found transaction receipt', {
            blockNumber: receipt.blockNumber,
            status: receipt.status
        });

        // Create adapter
        const rebalancer = new RebalanceAdapter({
            chains: parsed,
            kraken: { apiSecret: process.env.KRAKEN_API_SECRET, apiKey: process.env.KRAKEN_API_KEY },
            binance: { apiSecret: process.env.BINANCE_API_SECRET, apiKey: process.env.BINANCE_API_KEY }
        } as unknown as MarkConfiguration, logger, cache);
        const adapter = rebalancer.getAdapter(type as SupportedBridge);

        // Find the asset to get decimals
        const asset = Object.values(originChain.assets).find(a => a.address.toLowerCase() === route.asset.toLowerCase());
        if (!asset) {
            throw new Error(`Asset ${route.asset} not found in origin chain ${route.origin}`);
        }

        // Convert amount to wei
        const amountInWei = parseUnits(options.amount, asset.decimals).toString();

        // Poll for transaction readiness
        await pollForTransactionReady(adapter, amountInWei, route, receipt as TransactionReceipt);

        // Handle destination chain operations
        const result = await handleDestinationChain(adapter, account, parsed, route, receipt as TransactionReceipt);

        logger.info('Resume operation completed', {
            bridgeTxHash: options.hash,
            ...result
        });

        await cache.removeWithdrawalRecord(options.hash);
    });

// Parse command line arguments
program.parse(); 