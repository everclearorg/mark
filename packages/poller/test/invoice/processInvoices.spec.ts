import { expect } from 'chai';
import { stub, SinonStubbedInstance, createStubInstance, SinonStub } from 'sinon';
import { processInvoices } from '../../src/invoice/processInvoices';
import { MarkConfiguration, Invoice, NewIntentParams, PurchaseAction } from '@mark/core';
import { PurchaseCache } from '@mark/cache';
import { Logger } from '@mark/logger';
import { EverclearAdapter, MinAmountsResponse } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { PrometheusAdapter } from '@mark/prometheus';
import * as balanceHelpers from '../../src/helpers/balance';
import * as intentHelpers from '../../src/helpers/intent';
import * as assetHelpers from '../../src/helpers/asset'
import * as contractHelpers from '../../src/helpers/contracts';

describe('processInvoices', () => {
    // Setup common test objects
    const validInvoice: Invoice = {
        intent_id: '0x123',
        owner: '0xowner',
        entry_epoch: 186595,
        amount: '1000000000000000000',
        discountBps: 1.2,
        origin: '1',
        destinations: ['8453'],
        hub_status: 'INVOICED',
        ticker_hash: '0xtickerhash',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 3600,
    };

    const validMinApiResponse: MinAmountsResponse = {
        invoiceAmount: '1023',
        discountBps: '1.2',
        amountAfterDiscount: '1020',
        custodiedAmounts: {
            '8453': '1000000000000000000'
        },
        minAmounts: {
            '8453': '1000000000000000000'
        }
    }

    const validConfig: MarkConfiguration = {
        web3SignerUrl: 'http://localhost:8545',
        ownAddress: '0xmark',
        supportedSettlementDomains: [8453],
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

    // Setup mocks
    let cache: SinonStubbedInstance<PurchaseCache>;
    let logger: SinonStubbedInstance<Logger>;
    let everclear: SinonStubbedInstance<EverclearAdapter>;
    let chainService: SinonStubbedInstance<ChainService>;
    let prometheus: SinonStubbedInstance<PrometheusAdapter>;

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
        prometheus.recordSuccessfulInvoice.resolves();

        // Setup everclear stubs
        everclear.createNewIntent.resolves({
            to: '0xdestination',
            data: '0xdata',
            chainId: 8453,
            value: '0'
        });

        stub(balanceHelpers, 'getMarkBalances').resolves(new Map([
            ['0xtickerhash', new Map([
                ['8453', BigInt('2000000000000000000')],
                ['1', BigInt('0')]
            ])]
        ]));
        stub(balanceHelpers, 'getMarkGasBalances').resolves(new Map([
            ['8453', BigInt('1000000000000000000')],
            ['1', BigInt('0')]
        ]));
        stub(intentHelpers, 'sendIntents').resolves([{ transactionHash: '0xtx', chainId: '8453' }]);
        stub(assetHelpers, 'isXerc20Supported').resolves(false);
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
        expect(prometheus.updateChainBalance.callCount).to.be.eq(Object.keys(validConfig.chains).length);
        expect(prometheus.updateGasBalance.callCount).to.be.eq(Object.keys(validConfig.chains).length);
        expect(cache.addPurchases.calledOnce).to.be.true;
        const purchases = cache.addPurchases.firstCall.args[0];
        console.log('purchases', purchases);
        expect(purchases).to.have.lengthOf(1);
        expect(purchases[0].target).to.deep.equal(validInvoice);
        expect(purchases[0].transactionHash).to.equal('0xtx');
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
    });

    it('should not handle multiple invoices with same ticker', async () => {
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
    });

    it('should try next destination if first has insufficient balance', async () => {
        // Create invoice with multiple destinations
        const multiDestInvoice: Invoice = {
            ...validInvoice,
            destinations: ['1', '8453'], // First domain 1, then 8453
        };

        // Setup balances where first destination has insufficient funds but second has enough
        (balanceHelpers.getMarkBalances as any).restore();
        stub(balanceHelpers, 'getMarkBalances').resolves(new Map([
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
        }
    });
});