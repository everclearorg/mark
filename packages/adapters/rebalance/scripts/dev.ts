import { config } from 'dotenv';
import { Logger } from '@mark/logger';
import { getEverclearConfig, ChainConfiguration, parseChainConfigurations, SupportedBridge, RebalanceRoute, MarkConfiguration, RebalanceOperationStatus } from '@mark/core';
import { BridgeAdapter, RebalanceTransactionMemo } from '../src/types';
import { Account, Hash, parseUnits, TransactionReceipt, createWalletClient, http, fallback, createPublicClient, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createNonceManager, jsonRpc } from 'viem/nonce'
import { Command } from 'commander';
import * as chains from 'viem/chains'
import { RebalanceAdapter } from '../src';
import * as database from '@mark/database';
import { CoinbaseClient } from '../src/adapters/coinbase';

const nonceManager = createNonceManager({ source: jsonRpc() });

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

program
    .command('adapter')
    .description('Test a specific bridge adapter with a bridge transaction on mainnets')
    .argument('<type>', 'Adapter type (e.g. across)')
    .option('-a, --amount <amount>', 'Amount to test with (human units)', '0.01')
    .option('-o, --origin <chainId>', 'Origin chain ID', '1')
    .option('-d, --destination <chainId>', 'Destination chain ID', '10')
    .option('-t, --token <address>', 'Token address to test with')
    .action(async (type: SupportedBridge, options: AdapterOptions) => {

        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error('PRIVATE_KEY not found in .env');
        }

        // database is necessary for caching and tracking rebalance operations
        database.initializeDatabase({
            connectionString: process.env.DATABASE_URL as string,
            maxConnections: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000
        });

        const account = privateKeyToAccount(privateKey as `0x${string}`, {nonceManager});

        const configs = await getEverclearConfig();
        if (!configs) {
            throw new Error('Failed to get chain configurations');
        }
        const parsed = await parseChainConfigurations(configs, ['WETH', 'USDC', 'USDT', 'ETH'], {});

        const markConfig = {
            chains: parsed,
            environment: 'mainnet',
            kraken: { apiSecret: process.env.KRAKEN_API_SECRET, apiKey: process.env.KRAKEN_API_KEY },
            binance: { apiSecret: process.env.BINANCE_API_SECRET, apiKey: process.env.BINANCE_API_KEY },
            coinbase: { 
                apiKey: process.env.COINBASE_API_KEY, 
                apiSecret: process.env.COINBASE_API_SECRET, 
                allowedRecipients: (process.env.COINBASE_ALLOWED_RECIPIENTS || '').split(',') 
            }
        } as unknown as MarkConfiguration

        const rebalancer = new RebalanceAdapter(markConfig, logger, database);
        const adapter = rebalancer.getAdapter(type);

        await testBridgeAdapter(adapter, account, markConfig, options);
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

    const destinationProviders = destinationChain.providers ?? [];
    const destinationTransports = destinationProviders.map((url) => http(url));
    const destinationTransport = destinationTransports.length === 1 ? destinationTransports[0] : fallback(destinationTransports, { rank: true });

    const destinationWalletClient = createWalletClient({
        account,
        chain: getViemChain(route.destination),
        transport: destinationTransport
    });

    // Create public client for destination chain
    const destinationPublicClient = createPublicClient({
        chain: getViemChain(route.destination),
        transport: destinationTransport
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
    const maxAttempts = 100;
    const pollIntervalMs = 15_000; 

    while (!isReady && attempts < maxAttempts) {
        attempts++;
        logger.info(`Polling attempt ${attempts}/${maxAttempts}...`);

        isReady = await adapter.readyOnDestination(amountInWei, route, receipt);

        if (!isReady) {
            logger.info('Transaction not ready yet, waiting...');
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
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
    markConfig: MarkConfiguration,
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
    const originChain = markConfig.chains[route.origin.toString()];
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
    const originProviders = originChain.providers ?? [];
    const originTransports = originProviders.map((url) => http(url));
    const originTransport = originTransports.length === 1 ? originTransports[0] : fallback(originTransports, { rank: true });

    const walletClient = createWalletClient({
        account,
        chain: getViemChain(route.origin),
        transport: originTransport,
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
        transport: originTransport
    });


    // Sanity check: sufficient balance
    const balance = asset.isNative
        ? await publicClient.getBalance({ address: account.address })
        : await publicClient.readContract({ abi: erc20Abi, address: asset.address as `0x${string}`, functionName: 'balanceOf', args: [account.address] })
    if (balance < BigInt(amountInWei)) {
        throw new Error(`${account.address} has insufficient balance of ${asset.symbol} (${asset.address}) on ${route.origin} to send via adapter. need ${amountInWei}, have ${balance}.`);
    }

    let receiptToTrack: TransactionReceipt | undefined = undefined;
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
            receiptToTrack = receipt as TransactionReceipt;
        }

        logger.info(`Bridge transaction confirmed [${memo}]`, {
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            status: receipt.status
        });
    }

    if (!receiptToTrack) {
        throw new Error(`No ${RebalanceTransactionMemo.Rebalance} receipt found in receipts.`)
    }

    // Create database record for tracking
    const rebalanceOperation = await database.createRebalanceOperation({
        earmarkId: null, // NULL indicates regular rebalancing
        originChainId: route.origin,
        destinationChainId: route.destination,
        tickerHash: asset.tickerHash,
        amount: amountInWei,
        slippage: 0, // Dev script uses default slippage
        status: RebalanceOperationStatus.PENDING,
        bridge: adapter.type() as SupportedBridge,
        //@ts-ignore
        transactions: {[route.origin.toString()]: receiptToTrack as TransactionReceipt},
        recipient: account.address,
    });

    logger.info('Successfully created rebalance operation in database', {
        route,
        bridge: adapter.type(),
        originTxHash: receiptToTrack.transactionHash,
        amount: amountInWei,
    });

    // Poll for transaction readiness (outside of a test, this would normally occur via the poller agent)
    await pollForTransactionReady(adapter, amountInWei, route, receiptToTrack);

    // Handle destination chain operations
    const result = await handleDestinationChain(adapter, account, markConfig.chains, route, receiptToTrack);

    await database.updateRebalanceOperation(rebalanceOperation.id, {
        status: RebalanceOperationStatus.COMPLETED,
    });

    logger.info('Bridge transaction completed', {
        bridgeTxHash: receiptToTrack.transactionHash,
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
        const account = privateKeyToAccount(privateKey as `0x${string}`, {nonceManager});

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

        const originProviders = originChain.providers ?? [];
        const originTransports = originProviders.map((url) => http(url));
        const originTransport = originTransports.length === 1 ? originTransports[0] : fallback(originTransports, { rank: true });
        const publicClient = createPublicClient({
            chain: getViemChain(route.origin),
            transport: originTransport
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
            environment: 'mainnet',
            kraken: { apiSecret: process.env.KRAKEN_API_SECRET, apiKey: process.env.KRAKEN_API_KEY },
            binance: { apiSecret: process.env.BINANCE_API_SECRET, apiKey: process.env.BINANCE_API_KEY },
        } as unknown as MarkConfiguration, logger, database);
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

    });

// Parse command line arguments
program.parse(); 