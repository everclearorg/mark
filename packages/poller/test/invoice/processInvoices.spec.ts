import { expect } from 'chai';
import { stub, SinonStubbedInstance, createStubInstance, SinonStub } from 'sinon';
import { processInvoices } from '../../src/invoice/processInvoices';
import { MarkConfiguration, Invoice, NewIntentParams, PurchaseAction, InvalidPurchaseReasons } from '@mark/core';
import { PurchaseCache } from '@mark/cache';
import { Logger } from '@mark/logger';
import { EverclearAdapter, MinAmountsResponse } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { InvoiceLabels, PrometheusAdapter } from '@mark/prometheus';
import * as balanceHelpers from '../../src/helpers/balance';
import * as intentHelpers from '../../src/helpers/intent';
import * as assetHelpers from '../../src/helpers/asset'
import * as monitorHelpers from '../../src/helpers/monitor';

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
    let markBalanceStub: SinonStub;

    beforeEach(() => {
        cache = createStubInstance(PurchaseCache);
        logger = createStubInstance(Logger);
        everclear = createStubInstance(EverclearAdapter);
        chainService = createStubInstance(ChainService);
        prometheus = createStubInstance(PrometheusAdapter);

        // Setup default stubs
        cache.getAllPurchases.resolves([]);
        cache.removePurchases.resolves();
        cache.addPurchases.resolves();

        // Setup prometheus stubs
        prometheus.updateChainBalance.resolves();
        prometheus.updateGasBalance.resolves();
        prometheus.recordPossibleInvoice.resolves();
        prometheus.recordSuccessfulPurchase.resolves();

        // Setup everclear stubs
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
        stub(intentHelpers, 'sendIntents').resolves([{ transactionHash: '0xtx', chainId: '1' }]);
        stub(assetHelpers, 'isXerc20Supported').resolves(false);
        stub(monitorHelpers, 'logBalanceThresholds').returns();
        stub(monitorHelpers, 'logGasThresholds').returns();
    });

    it('should process a valid invoice and create a purchase', async () => {
        everclear.getMinAmounts.resolves(validMinApiResponse);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        expect(purchases).to.have.lengthOf(1);
        expect(purchases[0].target).to.deep.equal(validInvoice);
        expect(purchases[0].transactionHash).to.equal('0xtx');
        expect(prometheus.recordSuccessfulPurchase.calledOnceWith({
            ...labels,
            destination: validInvoice.destinations[0]
        })).to.be.true;
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
    });

    it('should skip processing if invoice already has a pending purchase', async () => {
        const existingPurchase: PurchaseAction = {
            target: validInvoice,
            purchase: {} as NewIntentParams,
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
            config: validConfig
        });

        expect(everclear.getMinAmounts.called).to.be.false;
        expect(chainService.submitAndMonitor.called).to.be.false;
        expect((intentHelpers.sendIntents as SinonStub).called).to.be.false;
        // adds pending purchases, handled at cache level
        expect(cache.addPurchases.calledOnceWith([existingPurchase])).to.be.true;
        // Does record as a possible invoice w.failure reason
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.PendingPurchaseRecord, labels)).to.be.true;
    });

    it('should skip processing if XERC20 is supported for the destination', async () => {
        (assetHelpers.isXerc20Supported as any).restore();
        stub(assetHelpers, 'isXerc20Supported').resolves(true);

        everclear.getMinAmounts.resolves(validMinApiResponse);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });

        expect((intentHelpers.sendIntents as SinonStub).called).to.be.false;
        expect(everclear.getMinAmounts.called).to.be.false;
        expect(chainService.submitAndMonitor.called).to.be.false;
        expect((intentHelpers.sendIntents as SinonStub).called).to.be.false;
        expect(cache.addPurchases.called).to.be.false;
        // Does record as a possible invoice w.failure reason
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.DestinationXerc20, labels)).to.be.true;
    });

    it('should skip processing if insufficient balance', async () => {
        (balanceHelpers.getMarkBalances as any).restore();
        stub(balanceHelpers, 'getMarkBalances').resolves(new Map([
            ['TEST', new Map([['8453', BigInt('500000000000000000')]])] // Less than required
        ]));

        everclear.getMinAmounts.resolves(validMinApiResponse);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });

        expect(everclear.getMinAmounts.called).to.be.true;
        expect(chainService.submitAndMonitor.called).to.be.false;
        expect((intentHelpers.sendIntents as SinonStub).called).to.be.false;
        expect(cache.addPurchases.called).to.be.false;
        // Does record as a possible invoice w.failure reason
        expect(prometheus.recordPossibleInvoice.calledOnceWith(labels)).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.InsufficientBalance, { ...labels, destination: validInvoice.destinations[0] })).to.be.true;
    });

    it('should not handle multiple invoices with same ticker + destinations', async () => {
        const secondInvoice = {
            ...validInvoice,
            intent_id: '0x456',
            hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 3600 // 15 minutes ago
        };

        everclear.getMinAmounts.resolves(validMinApiResponse);

        await processInvoices({
            invoices: [validInvoice, secondInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });

        // Should only process the older invoice
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        expect(purchases).to.have.lengthOf(1);
        expect(purchases[0].target.intent_id).to.equal('0x123');
        // Does record as a possible invoices w.failure reason
        expect(prometheus.recordPossibleInvoice.callCount).to.be.eq(2);
        expect(prometheus.recordSuccessfulPurchase.calledOnceWith({ ...labels, destination: validInvoice.destinations[0] })).to.be.true;
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.PendingPurchaseRecord, { ...labels, id: secondInvoice.intent_id })).to.be.true;
    });

    it('should handle multiple invoices with same ticker + destinations, but second invoice has unique dest (settle to second invoice second dest)', async () => {
        const secondInvoice = {
            ...validInvoice,
            intent_id: '0x456',
            destinations: [validInvoice.destinations[0], '8453'],
            hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 3600 // 15 minutes ago
        };

        everclear.getMinAmounts.onFirstCall().resolves(validMinApiResponse);
        everclear.getMinAmounts.onSecondCall().resolves({
            minAmounts: {
                '8453': '1000000000000000000',
                '1': '1000000000000000000',
            }
        } as unknown as MinAmountsResponse);
        markBalanceStub.resolves(new Map([
            [validInvoice.ticker_hash, new Map([
                ['8453', BigInt('2000000000000000000')],
                ['1', BigInt('2000000000000000000')]
            ])]
        ]));

        await processInvoices({
            invoices: [validInvoice, secondInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });

        // Should only process the older invoice
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        expect(purchases).to.have.lengthOf(2);
        expect(purchases[0].target.intent_id).to.equal(validInvoice.intent_id);
        expect(purchases[1].target.intent_id).to.equal(secondInvoice.intent_id);
        // Does record as a possible invoices w.failure reason
        expect(prometheus.recordPossibleInvoice.callCount).to.be.eq(2);
        expect(prometheus.recordSuccessfulPurchase.callCount).to.be.eq(2);
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.PendingPurchaseRecord, { ...labels, id: secondInvoice.intent_id })).to.be.true;
    });

    it('should handle errors during purchase transaction', async () => {
        (intentHelpers.sendIntents as any).restore();
        stub(intentHelpers, 'sendIntents').rejects(new Error('Transaction failed'));

        everclear.getMinAmounts.resolves(validMinApiResponse);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });

        expect(logger.error.called).to.be.true;
        expect(cache.addPurchases.called).to.be.false;
        expect(prometheus.recordPossibleInvoice.callCount).to.be.eq(1);
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.TransactionFailed, { ...labels, destination: validInvoice.destinations[0] })).to.be.true;
    });

    it('should try next destination if first has insufficient balance', async () => {
        // Create invoice with multiple destinations
        const multiDestInvoice: Invoice = {
            ...validInvoice,
            destinations: ['1', '8453'], // First domain 1, then 8453
        };

        // Setup balances where first destination has insufficient funds but second has enough
        markBalanceStub.resolves(new Map([
            ['0xtickerhash', new Map([
                ['1', BigInt('500000000000000000')], // Insufficient for first destination
                ['8453', BigInt('2000000000000000000')] // Sufficient for second destination
            ])]
        ]));

        // Setup min amounts response with both destinations
        const multiDestMinAmounts: MinAmountsResponse = {
            invoiceAmount: '1023',
            discountBps: '1.2',
            amountAfterDiscount: '1020',
            custodiedAmounts: {
                '1': '1000000000000000000',
                '8453': '1000000000000000000'
            },
            minAmounts: {
                '1': '1000000000000000000',
                '8453': '1000000000000000000'
            }
        };

        everclear.getMinAmounts.resolves(multiDestMinAmounts);

        await processInvoices({
            invoices: [multiDestInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });

        // Verify a purchase was created
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        expect(purchases).to.have.lengthOf(1);
        expect(purchases[0].target).to.deep.equal(multiDestInvoice);
        expect(purchases[0].purchase.origin).to.equal('8453'); // Should use second destination
        expect(purchases[0].transactionHash).to.equal('0xtx');
        expect(prometheus.recordPossibleInvoice.callCount).to.be.eq(1);
        expect(prometheus.recordSuccessfulPurchase.calledOnceWith({ ...labels, destination: '8453' }))
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.InsufficientBalance, { ...labels, destination: '1' })).to.be.true;
    });

    it('should handle errors when removing stale purchases from cache', async () => {
        // Setup a cached purchase that no longer matches any invoice
        const stalePurchase = {
            target: { ...validInvoice, intent_id: '0xstale' },
            purchase: {} as NewIntentParams,
            transactionHash: '0xold'
        };
        cache.getAllPurchases.resolves([stalePurchase]);
        cache.removePurchases.rejects(new Error('Cache error'));
        everclear.getMinAmounts.resolves(validMinApiResponse);

        await processInvoices({
            invoices: [validInvoice],
            cache,
            logger,
            everclear,
            chainService,
            prometheus,
            config: validConfig
        });

        expect(cache.removePurchases.calledOnce).to.be.true;
        expect(logger.warn.called).to.be.true;
        // Should continue processing despite cache error
        expect(everclear.getMinAmounts.called).to.be.true;
        expect(prometheus.recordSuccessfulPurchase.called).to.be.true;
    });

    it('should handle missing input asset in config', async () => {
        // Create a config without the asset but keep the chain structure
        const invalidConfig = {
            ...validConfig,
            chains: {
                '8453': {
                    invoiceAge: 3600,
                    providers: ['provider'],
                    assets: [{
                        ...validConfig.chains['8453'].assets[0],
                        address: undefined // Remove the token address
                    }]
                }
            }
        } as unknown as MarkConfiguration;

        everclear.getMinAmounts.resolves(validMinApiResponse);

        try {
            await processInvoices({
                invoices: [validInvoice],
                cache,
                logger,
                everclear,
                chainService,
                prometheus,
                config: invalidConfig
            });
            expect.fail('Should have thrown an error');
        } catch (error: any) {
            expect(error.message).to.include('No input asset found');
            expect(logger.error.called).to.be.true;
        }
        expect(prometheus.recordInvalidPurchase.calledOnceWith(InvalidPurchaseReasons.InvalidTokenConfiguration, { ...labels, destination: validInvoice.destinations[0] })).to.be.true;
    });

    it('should handle errors when adding purchases to cache', async () => {
        everclear.getMinAmounts.resolves(validMinApiResponse);
        cache.addPurchases.rejects(new Error('Failed to add purchases'));

        try {
            await processInvoices({
                invoices: [validInvoice],
                cache,
                logger,
                everclear,
                chainService,
                prometheus,
                config: validConfig
            });
            expect.fail('Should have thrown an error');
        } catch (error: any) {
            expect(error.message).to.include('Failed to add purchases');
            expect(logger.error.called).to.be.true;
            expect(cache.addPurchases.calledOnce).to.be.true;
            expect(prometheus.recordSuccessfulPurchase.called).to.be.true;
        }
    });
});