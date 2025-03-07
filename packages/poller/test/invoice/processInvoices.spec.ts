import { expect } from 'chai';
import { stub, SinonStubbedInstance, createStubInstance, SinonStub } from 'sinon';
import sinon from 'sinon';
import { processInvoices } from '../../src/invoice/processInvoices';
import { MarkConfiguration, Invoice, NewIntentParams, InvalidPurchaseReasons } from '@mark/core';
import { PurchaseCache, PurchaseAction } from '@mark/cache';
import { Logger } from '@mark/logger';
import { EverclearAdapter, MinAmountsResponse, IntentStatus } from '@mark/everclear';
import { Web3Signer } from '@mark/web3signer';
import { Wallet } from '@ethersproject/wallet';
import { ChainService } from '@mark/chainservice';
import { InvoiceLabels, PrometheusAdapter } from '@mark/prometheus';
import * as balanceHelpers from '../../src/helpers/balance';
import * as intentHelpers from '../../src/helpers/intent';
import * as assetHelpers from '../../src/helpers/asset'
import * as monitorHelpers from '../../src/helpers/monitor';
import * as splitIntentHelpers from '../../src/helpers/splitIntent';

describe('processInvoices', () => {
    // Setup common test objects
    const validInvoice: Invoice = {
        intent_id: '0x123',
        owner: '0xowner',
        entry_epoch: 186595,
        amount: '1000000000000000000',
        discountBps: 1.2,
        origin: '8453',
        destinations: ['1'],
        hub_status: 'INVOICED',
        ticker_hash: '0xtickerhash',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 3600,
    };

    const validMinApiResponse: MinAmountsResponse = {
        invoiceAmount: '1023',
        discountBps: '1.2',
        amountAfterDiscount: '1020',
        custodiedAmounts: {
            '1': '1000000000000000000'
        },
        minAmounts: {
            '1': '1000000000000000000'
        }
    }

    const validConfig: MarkConfiguration = {
        pushGatewayUrl: 'http://localhost:9090',
        web3SignerUrl: 'http://localhost:8545',
        ownAddress: '0xmark',
        supportedSettlementDomains: [8453, 1],
        chains: {
            '1': {
                invoiceAge: 3600,
                providers: ['provider'],
                gasThreshold: '1000000000000000000',
                deployments: {
                    everclear: '0xspoke',
                    permit2: '0xpermit2',
                    multicall3: '0xmulticall3'
                },
                assets: [{
                    tickerHash: '0xtickerhash',
                    address: '0xtoken',
                    decimals: 18,
                    symbol: 'TEST',
                    isNative: false,
                    balanceThreshold: '1000000000000000000'
                }]
            },
            '8453': {
                invoiceAge: 3600,
                providers: ['provider'],
                gasThreshold: '1000000000000000000',
                deployments: {
                    everclear: '0xspoke',
                    permit2: '0xpermit2',
                    multicall3: '0xmulticall3'
                },
                assets: [{
                    tickerHash: '0xtickerhash',
                    address: '0xtoken',
                    decimals: 18,
                    symbol: 'TEST',
                    isNative: false,
                    balanceThreshold: '1000000000000000000'
                }]
            }
        },
        logLevel: 'info',
        everclearApiUrl: 'http://localhost:3000',
        stage: 'development',
        environment: 'testnet',
        supportedAssets: ['TEST'],
        redis: {
            host: 'localhost',
            port: 6379
        },
        hub: {
            domain: '1',
            providers: ['provider']
        }
    };

    // Setup label constants
    const labels: InvoiceLabels = {
        origin: validInvoice.origin,
        id: validInvoice.intent_id,
        ticker: validInvoice.ticker_hash,
    }

    // Setup mocks
    let cache: SinonStubbedInstance<PurchaseCache>;
    let logger: SinonStubbedInstance<Logger>;
    let everclear: SinonStubbedInstance<EverclearAdapter>;
    let chainService: SinonStubbedInstance<ChainService>;
    let prometheus: SinonStubbedInstance<PrometheusAdapter>;
    let web3Signer: SinonStubbedInstance<Web3Signer>;
    let typedWeb3Signer: Web3Signer & Wallet;
    let markBalanceStub: SinonStub;
    let calcSplitIntentsStub: SinonStub;
    let sendIntentsStub: SinonStub;
    let sendIntentsMulticallStub: SinonStub;

    beforeEach(() => {
        cache = createStubInstance(PurchaseCache);
        logger = createStubInstance(Logger);
        everclear = createStubInstance(EverclearAdapter);
        chainService = createStubInstance(ChainService);
        prometheus = createStubInstance(PrometheusAdapter);
        web3Signer = createStubInstance(Web3Signer);
        typedWeb3Signer = web3Signer as unknown as Web3Signer & Wallet;

        // Setup default stubs
        cache.getAllPurchases.resolves([]);
        cache.removePurchases.resolves();
        cache.addPurchases.resolves();

        // Setup prometheus stubs
        prometheus.updateChainBalance.resolves();
        prometheus.updateGasBalance.resolves();
        prometheus.recordPossibleInvoice.resolves();
        prometheus.recordSuccessfulPurchase.resolves();
        prometheus.recordInvoicePurchaseDuration.resolves();

        // Setup everclear stubs
        everclear.getMinAmounts.resolves(validMinApiResponse);
        everclear.intentStatus.resolves(IntentStatus.ADDED);
        everclear.createNewIntent.resolves({
            to: '0xdestination',
            data: '0xdata',
            chainId: 1,
            value: '0'
        });

        markBalanceStub = stub(balanceHelpers, 'getMarkBalances').resolves(new Map([
            ['0xtickerhash', new Map([
                ['1', BigInt('2000000000000000000')],
                ['8453', BigInt('0')]
            ])]
        ]));
        
        stub(balanceHelpers, 'getMarkGasBalances').resolves(new Map([
            ['1', BigInt('1000000000000000000')],
            ['8453', BigInt('0')]
        ]));
        
        // Setup intent helper stubs
        sendIntentsStub = stub(intentHelpers, 'sendIntents').resolves([{ 
            transactionHash: '0xtx', 
            chainId: '1', 
            intentId: '0xintent'
        }]);
        
        sendIntentsMulticallStub = stub(intentHelpers, 'sendIntentsMulticall').resolves({ 
            transactionHash: '0xmulticall_tx', 
            chainId: '1', 
            intentId: '0xmulticall_intent'
        });
        
        // Setup calculateSplitIntents stub with default single intent behavior
        calcSplitIntentsStub = stub(splitIntentHelpers, 'calculateSplitIntents').resolves({
            intents: [{
                origin: '1',
                destinations: ['8453'],
                to: '0xdestination',
                inputAsset: '0xtoken',
                amount: '1000000000000000000',
                callData: '0xdata',
                maxFee: '0'
            }],
            originDomain: '1',
            totalAllocated: BigInt('1000000000000000000')
        });
        
        stub(assetHelpers, 'isXerc20Supported').resolves(false);
        stub(assetHelpers, 'getTickers').returns(['0xtickerhash']);
        stub(monitorHelpers, 'logBalanceThresholds').returns();
        stub(monitorHelpers, 'logGasThresholds').returns();
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should process a valid invoice with a single intent', async () => {
        // Setup for a single intent scenario
        calcSplitIntentsStub.resolves({
            intents: [{
                origin: '1',
                destinations: ['8453'],
                to: '0xdestination',
                inputAsset: '0xtoken',
                amount: '1000000000000000000',
                callData: '0xdata',
                maxFee: '0'
            }],
            originDomain: '1',
            totalAllocated: BigInt('1000000000000000000')
        });

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });
        
        // Verify calculateSplitIntents was called
        expect(calcSplitIntentsStub.calledOnce).to.be.true;
        
        // Verify sendIntents was called with the correct parameters
        expect(sendIntentsStub.calledOnce).to.be.true;
        expect(sendIntentsStub.firstCall.args[0]).to.deep.equal([{
            origin: '1',
            destinations: ['8453'],
            to: '0xdestination',
            inputAsset: '0xtoken',
            amount: '1000000000000000000',
            callData: '0xdata',
            maxFee: '0'
        }]);
        expect(sendIntentsStub.firstCall.args[2]).to.equal(validConfig);
        expect(sendIntentsMulticallStub.called).to.be.false;
        
        // Verify purchase was added to cache
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        expect(purchases).to.have.lengthOf(1);
        expect(purchases[0].target).to.deep.equal(validInvoice);
        expect(purchases[0].transactionHash).to.equal('0xtx');
        
        // Verify metrics were recorded
        expect(prometheus.recordSuccessfulPurchase.calledOnceWith({
            ...labels,
            destination: '1'
        })).to.be.true;
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvoicePurchaseDuration.calledOnce).to.be.true;
    });

    it('should process a valid invoice with multiple intents', async () => {
        // Setup for a multiple intent scenario
        calcSplitIntentsStub.resolves({
            intents: [
                {
                    origin: '1',
                    destinations: ['8453'],
                    to: '0xdestination1',
                    inputAsset: '0xtoken1',
                    amount: '500000000000000000',
                    callData: '0xdata1',
                    maxFee: '0'
                },
                {
                    origin: '1',
                    destinations: ['8453'],
                    to: '0xdestination2',
                    inputAsset: '0xtoken2',
                    amount: '500000000000000000',
                    callData: '0xdata2',
                    maxFee: '0'
                }
            ],
            originDomain: '1',
            totalAllocated: BigInt('1000000000000000000')
        });

        // For multicall testing, update the sendIntents stub
        sendIntentsStub.resolves([{
            transactionHash: '0xmulticall_tx',
            chainId: '1',
            intentId: '0xmulticall_intent'
        }]);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });
        
        // Verify calculateSplitIntents was called
        expect(calcSplitIntentsStub.calledOnce).to.be.true;
        
        // Verify sendIntents was called with multiple intents and originDomain
        expect(sendIntentsStub.calledOnce).to.be.true;
        expect(sendIntentsStub.firstCall.args[0]).to.have.lengthOf(2);
        expect(sendIntentsMulticallStub.called).to.be.false; // Should not be called directly anymore
        
        // Verify purchase was added to cache
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        expect(purchases).to.have.lengthOf(1);
        expect(purchases[0].target).to.deep.equal(validInvoice);
        expect(purchases[0].transactionHash).to.equal('0xmulticall_tx');
        
        // Verify metrics were recorded
        expect(prometheus.recordSuccessfulPurchase.calledOnceWith({
            ...labels,
            destination: '1'
        })).to.be.true;
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvoicePurchaseDuration.calledOnce).to.be.true;
    });

    it('should skip processing if invoice already has a pending purchase', async () => {
        const existingPurchase: PurchaseAction = {
            target: validInvoice,
            purchase: { intentId: '0xintent', params: {} as NewIntentParams },
            transactionHash: '0xexisting'
        };
        cache.getAllPurchases.resolves([existingPurchase]);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Verify we don't try to process this invoice
        expect(everclear.getMinAmounts.called).to.be.false;
        expect(calcSplitIntentsStub.called).to.be.false;
        expect(sendIntentsStub.called).to.be.false;
        expect(sendIntentsMulticallStub.called).to.be.false;
        
        // Verify we add the existing purchase to the cache
        expect(cache.addPurchases.calledOnceWith([existingPurchase])).to.be.true;
        
        // Verify proper metrics were recorded
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.PendingPurchaseRecord, labels)).to.be.true;
    });

    it('should skip processing if XERC20 is supported for the destination', async () => {
        (assetHelpers.isXerc20Supported as any).restore();
        stub(assetHelpers, 'isXerc20Supported').resolves(true);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Verify we don't try to process this invoice
        expect(everclear.getMinAmounts.called).to.be.false;
        expect(calcSplitIntentsStub.called).to.be.false;
        expect(sendIntentsStub.called).to.be.false;
        expect(sendIntentsMulticallStub.called).to.be.false;
        expect(cache.addPurchases.called).to.be.false;
        
        // Verify proper metrics were recorded
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.DestinationXerc20, labels)).to.be.true;
    });

    it('should skip invoices where calculateSplitIntents returns no intents', async () => {
        // Set up calculateSplitIntents to return no intents
        calcSplitIntentsStub.resolves({
            intents: [],
            originDomain: '',
            totalAllocated: BigInt('0')
        });

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Verify we called calculateSplitIntents but didn't try to send intents
        expect(calcSplitIntentsStub.calledOnce).to.be.true;
        expect(sendIntentsStub.called).to.be.false;
        expect(cache.addPurchases.called).to.be.false;
        
        // Verify proper metrics were recorded
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.InsufficientBalance, labels)).to.be.true;
    });

    it('should handle errors during single intent transaction', async () => {
        // Setup sendIntents to fail
        sendIntentsStub.rejects(new Error('Transaction failed'));

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Verify error was logged and no purchase was added
        expect(logger.error.called).to.be.true;
        expect(cache.addPurchases.called).to.be.false;
        
        // Verify proper metrics were recorded
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.TransactionFailed, { 
            ...labels, 
            destination: '1' 
        })).to.be.true;
    });

    it('should handle errors during multi-intent transaction', async () => {
        // Setup for a multi-intent scenario
        calcSplitIntentsStub.resolves({
            intents: [
                {
                    origin: '1',
                    destinations: ['8453'],
                    to: '0xdestination1',
                    inputAsset: '0xtoken',
                    amount: '500000000000000000',
                    callData: '0xdata1',
                    maxFee: '0'
                },
                {
                    origin: '1',
                    destinations: ['8453'],
                    to: '0xdestination2',
                    inputAsset: '0xtoken',
                    amount: '500000000000000000',
                    callData: '0xdata2',
                    maxFee: '0'
                }
            ],
            originDomain: '1',
            totalAllocated: BigInt('1000000000000000000')
        });
        
        // Setup sendIntents to fail for multiple intents
        sendIntentsStub.rejects(new Error('Transaction failed'));
        sendIntentsMulticallStub.resolves({ transactionHash: '0xtx', chainId: '1', intentId: '0xintent' });

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Verify error was logged and no purchase was added
        expect(logger.error.called).to.be.true;
        expect(cache.addPurchases.called).to.be.false;
        
        // Verify sendIntents was called with multiple intents and originDomain
        expect(sendIntentsStub.calledOnce).to.be.true;
        expect(sendIntentsStub.firstCall.args[0]).to.have.lengthOf(2);
        expect(sendIntentsMulticallStub.called).to.be.false;
        
        // Verify proper metrics were recorded
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.TransactionFailed, { 
            ...labels, 
            destination: '1' 
        })).to.be.true;
    });

    it('should not handle multiple invoices with same ticker + destinations', async () => {
        const secondInvoice = {
            ...validInvoice,
            intent_id: '0x456',
            hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 3600 // 15 minutes ago
        };

        // Setup calculateSplitIntents to return reasonable results for first invoice but not second
        calcSplitIntentsStub.onFirstCall().resolves({
            intents: [{
                origin: '1',
                destinations: ['8453'],
                to: '0xdestination',
                inputAsset: '0xtoken',
                amount: '1000000000000000000',
                callData: '0xdata',
                maxFee: '0'
            }],
            originDomain: '1',
            totalAllocated: BigInt('1000000000000000000')
        });

        // Add specific stub to track metrics correctly
        prometheus.recordInvalidPurchase.withArgs(
            InvalidPurchaseReasons.PendingPurchaseRecord, 
            { ...labels, id: secondInvoice.intent_id }
        ).resolves(undefined);

        await processInvoices({
            invoices: [validInvoice, secondInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Should only process the older invoice
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        expect(purchases).to.have.lengthOf(1);
        expect(purchases[0].target.intent_id).to.equal('0x123');
        
        // Verify proper metrics were recorded
        expect(prometheus.recordPossibleInvoice.callCount).to.be.eq(2);
        expect(prometheus.recordSuccessfulPurchase.calledOnceWith({ ...labels, destination: '1' })).to.be.true;
        
        // Check that the second invoice was marked with PendingPurchaseRecord
        const secondLabels = { 
            ...labels, 
            id: secondInvoice.intent_id 
        };
        expect(prometheus.recordPossibleInvoice.calledWith(secondLabels)).to.be.true;
    });

    it('should handle errors when removing stale purchases from cache', async () => {
        // Setup a cached purchase that no longer matches any invoice
        const stalePurchase = {
            target: { ...validInvoice, intent_id: '0xstale' },
            purchase: { intentId: '0xintent', params: {} as NewIntentParams },
            transactionHash: '0xold'
        };
        cache.getAllPurchases.resolves([stalePurchase]);
        cache.removePurchases.rejects(new Error('Cache error'));

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        expect(cache.removePurchases.calledOnce).to.be.true;
        expect(logger.warn.called).to.be.true;
        
        // Should continue processing despite cache error
        expect(calcSplitIntentsStub.calledOnce).to.be.true;
        expect(sendIntentsStub.calledOnce).to.be.true;
        expect(prometheus.recordSuccessfulPurchase.called).to.be.true;
    });

    it('should handle errors when adding purchases to cache', async () => {
        cache.addPurchases.rejects(new Error('Failed to add purchases'));

        try {
            await processInvoices({
                invoices: [validInvoice],
                cache,
                logger,
                everclear,
                chainService,
                prometheus,
                config: validConfig,
                web3Signer: typedWeb3Signer
            });
            expect.fail('Should have thrown an error');
        } catch (error: any) {
            expect(error.message).to.include('Failed to add purchases');
            expect(logger.error.called).to.be.true;
            expect(cache.addPurchases.calledOnce).to.be.true;
            expect(prometheus.recordSuccessfulPurchase.called).to.be.true;
        }
    });

    it('should filter out destinations with existing purchases', async () => {
        // Create existing purchase for a specific destination
        const existingPurchase: PurchaseAction = {
            target: {
                ...validInvoice,
                intent_id: '0xdifferent' // Different invoice but same ticker
            },
            purchase: { 
                intentId: '0xexisting_intent', 
                params: {
                    origin: '1', // This destination will be filtered out
                    destinations: ['8453'],
                    to: '0xdestination',
                    inputAsset: '0xtoken',
                    amount: '1000000000000000000',
                    callData: '0xdata',
                    maxFee: '0'
                } as NewIntentParams 
            },
            transactionHash: '0xexisting'
        };
        
        cache.getAllPurchases.resolves([existingPurchase]);
        
        // Modify minAmounts to include multiple destinations
        const multiDestResponse = {
            ...validMinApiResponse,
            minAmounts: {
                '1': '1000000000000000000', // Will be filtered out
                '42161': '500000000000000000' // Should remain
            }
        };
        everclear.getMinAmounts.resolves(multiDestResponse);
        
        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Verify calcSplitIntents was called with filtered minAmounts
        expect(calcSplitIntentsStub.calledOnce).to.be.true;
        const filteredMinAmounts = calcSplitIntentsStub.firstCall.args[1];
        expect(filteredMinAmounts).to.not.have.property('1'); // Should be filtered out
        expect(filteredMinAmounts).to.have.property('42161'); // Should remain
        
        // Verify destination filtering was logged
        expect(logger.info.calledWith('Action exists for destination-ticker combo, removing from consideration', 
            sinon.match({ destination: '1' }))).to.be.true;
            
        // Verify metrics for filtered destination
        expect(prometheus.recordInvalidPurchase.calledWith(
            InvalidPurchaseReasons.PendingPurchaseRecord,
            sinon.match({ destination: '1' })
        )).to.be.true;
    });
    
    it('should skip invoice when all destinations are filtered out', async () => {
        // Create a specific invoice with known values
        const testInvoice = {
            ...validInvoice,
            ticker_hash: '0xspecific_ticker_hash',
            intent_id: '0xtest_invoice_id'
        };
        
        // Create existing purchase that exactly matches our test invoice's ticker_hash
        const existingPurchase: PurchaseAction = {
            target: {
                ...testInvoice,
                intent_id: '0xdifferent' // Different invoice ID but same ticker_hash
            },
            purchase: { 
                intentId: '0xexisting_intent', 
                params: {
                    origin: '1', // This is the only destination in our minAmounts
                    destinations: ['8453'],
                    to: '0xdestination',
                    inputAsset: '0xtoken',
                    amount: '1000000000000000000',
                    callData: '0xdata',
                    maxFee: '0'
                } as NewIntentParams 
            },
            transactionHash: '0xexisting'
        };
        
        cache.getAllPurchases.resolves([existingPurchase]);
        
        // Set up minAmounts to ONLY include the destination that will be filtered
        const singleDestResponse = {
            ...validMinApiResponse,
            minAmounts: {
                '1': '1000000000000000000' // Only this destination, which will be filtered out
            }
        };
        everclear.getMinAmounts.resolves(singleDestResponse);
        
        await processInvoices({
            invoices: [testInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });
        
        expect(calcSplitIntentsStub.called).to.be.false;
        expect(sendIntentsStub.called).to.be.false;
        expect(sendIntentsMulticallStub.called).to.be.false;
    });
    
    it('should correctly handle multiple pending purchases with different ticker-destination combinations', async () => {
        // Create two existing purchases for different ticker-destination combinations
        const existingPurchases: PurchaseAction[] = [
            {
                target: {
                    ...validInvoice,
                    intent_id: '0xdifferent1'
                },
                purchase: { 
                    intentId: '0xexisting_intent1', 
                    params: {
                        origin: '1',
                        destinations: ['8453'],
                        to: '0xdestination1',
                        inputAsset: '0xtoken',
                        amount: '1000000000000000000',
                        callData: '0xdata1',
                        maxFee: '0'
                    } as NewIntentParams 
                },
                transactionHash: '0xexisting1'
            },
            {
                target: {
                    ...validInvoice,
                    ticker_hash: '0xdifferent_ticker',
                    intent_id: '0xdifferent2'
                },
                purchase: { 
                    intentId: '0xexisting_intent2', 
                    params: {
                        origin: '42161', // Different destination
                        destinations: ['8453'],
                        to: '0xdestination2',
                        inputAsset: '0xtoken2',
                        amount: '1000000000000000000',
                        callData: '0xdata2',
                        maxFee: '0'
                    } as NewIntentParams 
                },
                transactionHash: '0xexisting2'
            }
        ];
        
        cache.getAllPurchases.resolves(existingPurchases);
        
        // Modify minAmounts to include multiple destinations
        const multiDestResponse = {
            ...validMinApiResponse,
            minAmounts: {
                '1': '1000000000000000000', // Should be filtered (same ticker)
                '42161': '500000000000000000' // Should remain (different ticker)
            }
        };
        everclear.getMinAmounts.resolves(multiDestResponse);
        
        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig,
            web3Signer: typedWeb3Signer
        });

        // Verify calcSplitIntents was called with correctly filtered minAmounts
        expect(calcSplitIntentsStub.calledOnce).to.be.true;
        const filteredMinAmounts = calcSplitIntentsStub.firstCall.args[1];
        expect(filteredMinAmounts).to.not.have.property('1'); // Should be filtered out (same ticker)
        expect(filteredMinAmounts).to.have.property('42161'); // Should remain (different ticker)
    });
});