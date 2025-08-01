import { expect } from '../globalTestHook';
import sinon, { createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import { ProcessingContext } from '../../src/init';
import { groupInvoicesByTicker, processInvoices, processTickerGroup, TickerGroup } from '../../src/invoice/processInvoices';
import * as balanceHelpers from '../../src/helpers/balance';
import * as assetHelpers from '../../src/helpers/asset';
import { IntentStatus } from '@mark/everclear';
import { RebalanceCache } from '@mark/cache';
import { InvalidPurchaseReasons, TransactionSubmissionType } from '@mark/core';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { PurchaseCache } from '@mark/cache';
import { Wallet } from 'ethers';
import { PrometheusAdapter } from '@mark/prometheus';
import * as intentHelpers from '../../src/helpers/intent';
import * as splitIntentHelpers from '../../src/helpers/splitIntent';
import { mockConfig, createMockInvoice } from '../mocks';

import { RebalanceAdapter } from '@mark/rebalance';
import * as monitorHelpers from '../../src/helpers/monitor';


describe('Invoice Processing', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;

  let getMarkBalancesStub: SinonStub;
  let getMarkGasBalancesStub: SinonStub;
  let getCustodiedBalancesStub: SinonStub;
  let isXerc20SupportedStub: SinonStub;
  let calculateSplitIntentsStub: SinonStub;
  let sendIntentsStub: SinonStub;
  let logGasThresholdsStub: SinonStub;

  let mockDeps: {
    logger: SinonStubbedInstance<Logger>;
    everclear: SinonStubbedInstance<EverclearAdapter>;
    chainService: SinonStubbedInstance<ChainService>;
    purchaseCache: SinonStubbedInstance<PurchaseCache>;
    rebalanceCache: SinonStubbedInstance<RebalanceCache>;
    rebalance: SinonStubbedInstance<RebalanceAdapter>;
    web3Signer: SinonStubbedInstance<Wallet>;
    prometheus: SinonStubbedInstance<PrometheusAdapter>;
  };

  beforeEach(() => {
    // Init with fresh stubs and mocks
    getMarkBalancesStub = sinon.stub(balanceHelpers, 'getMarkBalances');
    getMarkGasBalancesStub = sinon.stub(balanceHelpers, 'getMarkGasBalances');
    getCustodiedBalancesStub = sinon.stub(balanceHelpers, 'getCustodiedBalances');
    isXerc20SupportedStub = sinon.stub(assetHelpers, 'isXerc20Supported');
    calculateSplitIntentsStub = sinon.stub(splitIntentHelpers, 'calculateSplitIntents');
    sendIntentsStub = sinon.stub(intentHelpers, 'sendIntents');
    logGasThresholdsStub = sinon.stub(monitorHelpers, 'logGasThresholds');

    mockDeps = {
      logger: createStubInstance(Logger),
      everclear: createStubInstance(EverclearAdapter),
      chainService: createStubInstance(ChainService),
      purchaseCache: createStubInstance(PurchaseCache),
      rebalanceCache: createStubInstance(RebalanceCache),
      rebalance: createStubInstance(RebalanceAdapter),
      web3Signer: createStubInstance(Wallet),
      prometheus: createStubInstance(PrometheusAdapter),
    };

    // Default mock config supports 1, 8453, 10 and one token on each
    mockContext = {
      config: mockConfig,
      requestId: 'test-request-id',
      startTime: Math.floor(Date.now() / 1000),
      ...mockDeps
    } as unknown as ProcessingContext;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('groupInvoicesByTicker', () => {
    it('should group multiple invoices with the same ticker correctly', () => {
      const invoices = [
        createMockInvoice({ intent_id: '0x1', ticker_hash: '0xticker1' }),
        createMockInvoice({ intent_id: '0x2', ticker_hash: '0xticker1' }),
        createMockInvoice({ intent_id: '0x3', ticker_hash: '0xticker1' })
      ];

      const grouped = groupInvoicesByTicker(mockContext, invoices);

      expect(grouped.size).to.equal(1);
      expect(grouped.get('0xticker1')?.length).to.equal(3);
    });

    it('should group invoices with different tickers separately', () => {
      const invoices = [
        createMockInvoice({ intent_id: '0x1', ticker_hash: '0xticker1' }),
        createMockInvoice({ intent_id: '0x2', ticker_hash: '0xticker2' }),
        createMockInvoice({ intent_id: '0x3', ticker_hash: '0xticker1' })
      ];

      const grouped = groupInvoicesByTicker(mockContext, invoices);

      expect(grouped.size).to.equal(2);
      expect(grouped.get('0xticker1')?.length).to.equal(2);
      expect(grouped.get('0xticker2')?.length).to.equal(1);
    });

    it('should sort invoices by age within groups', () => {
      const now = Math.floor(Date.now() / 1000);
      const invoices = [
        createMockInvoice({
          intent_id: '0x1',
          ticker_hash: '0xticker1',
          hub_invoice_enqueued_timestamp: now - 1 // 1 second ago
        }),
        createMockInvoice({
          intent_id: '0x2',
          ticker_hash: '0xticker1',
          hub_invoice_enqueued_timestamp: now - 3 // 3 seconds ago
        }),
        createMockInvoice({
          intent_id: '0x3',
          ticker_hash: '0xticker1',
          hub_invoice_enqueued_timestamp: now - 2 // 2 seconds ago
        })
      ];

      const grouped = groupInvoicesByTicker(mockContext, invoices);
      const groupedInvoices = grouped.get('0xticker1');
      expect(groupedInvoices).to.not.be.undefined;

      // Should be sorted oldest to newest
      expect(groupedInvoices?.[0].intent_id).to.equal('0x2');
      expect(groupedInvoices?.[1].intent_id).to.equal('0x3');
      expect(groupedInvoices?.[2].intent_id).to.equal('0x1');
    });

    it('should handle empty invoice list', () => {
      const grouped = groupInvoicesByTicker(mockContext, []);

      expect(grouped.size).to.equal(0);
    });

    it('should handle single invoice', () => {
      const invoices = [
        createMockInvoice({ intent_id: '0x1', ticker_hash: '0xticker1' })
      ];

      const grouped = groupInvoicesByTicker(mockContext, invoices);

      expect(grouped.size).to.equal(1);
      const groupedInvoices = grouped.get('0xticker1');
      expect(groupedInvoices).to.not.be.undefined;
      expect(groupedInvoices?.length).to.equal(1);
      expect(groupedInvoices?.[0].intent_id).to.equal('0x1');
    });

    it('should record metrics for each invoice', () => {
      const invoices = [
        createMockInvoice({
          intent_id: '0x1',
          ticker_hash: '0xticker1',
          origin: '1'
        }),
        createMockInvoice({
          intent_id: '0x2',
          ticker_hash: '0xticker2',
          origin: '2'
        })
      ];

      groupInvoicesByTicker(mockContext, invoices);

      expect(mockDeps.prometheus.recordPossibleInvoice.calledTwice).to.be.true;
      expect(mockDeps.prometheus.recordPossibleInvoice.firstCall.args[0]).to.deep.equal({
        origin: '1',
        id: '0x1',
        ticker: '0xticker1'
      });
      expect(mockDeps.prometheus.recordPossibleInvoice.secondCall.args[0]).to.deep.equal({
        origin: '2',
        id: '0x2',
        ticker: '0xticker2'
      });
    });
  });

  describe('processInvoices', () => {
    it('should remove stale cache purchases successfully', async () => {
      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);

      // Make invoice SETTLED, which means it should be removed
      mockDeps.everclear.intentStatuses.resolves(new Map([['0x123', IntentStatus.SETTLED]]));

      const invoices = [createMockInvoice()];

      // Mock the returned purchase from cache
      mockDeps.purchaseCache.getAllPurchases.resolves([{
        target: invoices[0],
        purchase: {
          intentId: invoices[0].intent_id,
          params: {
            amount: '1000000000000000000',
            origin: '1',
            destinations: ['1'],
            to: '0x123',
            inputAsset: '0x123',
            callData: '',
            maxFee: 0
          }
        },
        transactionHash: '0xabc',
        transactionType: TransactionSubmissionType.Onchain,
      }]);

      await processInvoices(mockContext, invoices);

      expect(mockDeps.purchaseCache.removePurchases.calledWith(['0x123'])).to.be.true;

      expect(mockDeps.prometheus.recordPurchaseClearanceDuration.calledOnce).to.be.true;
      expect(mockDeps.prometheus.recordPurchaseClearanceDuration.firstCall.args[0]).to.deep.equal({
        origin: '1',
        ticker: '0xticker1',
        destination: '8453',
      });
      expect(mockDeps.prometheus.recordPurchaseClearanceDuration.firstCall.args[1]).to.equal(
        mockContext.startTime - invoices[0].hub_invoice_enqueued_timestamp,
      );
    });

    it('should correctly store a purchase in the cache', async () => {
      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);
      mockDeps.purchaseCache.getAllPurchases.resolves([]);
      mockDeps.everclear.intentStatuses.resolves(new Map());

      const invoice = createMockInvoice({ discountBps: 7 });

      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([{
        intentId: '0xabc',
        transactionHash: '0xabc',
        chainId: '8453',
        type: TransactionSubmissionType.Onchain,
      }]);

      await processInvoices(mockContext, [invoice]);

      const expectedPurchase = {
        target: invoice,
        transactionHash: '0xabc',
        transactionType: TransactionSubmissionType.Onchain,
        purchase: {
          intentId: '0xabc',
          params: {
            amount: '1000000000000000000',
            origin: '8453',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        }
      };

      // Verify the correct purchase was stored in cache
      expect(mockDeps.purchaseCache.addPurchases.calledOnce).to.be.true;
      expect(mockDeps.purchaseCache.addPurchases.firstCall.args[0]).to.deep.equal([expectedPurchase]);

      expect(mockDeps.prometheus.recordSuccessfulPurchase.calledOnce).to.be.true;
      expect(mockDeps.prometheus.recordSuccessfulPurchase.firstCall.args[0]).to.deep.equal({
        origin: '1',
        id: '0x123',
        ticker: '0xticker1',
        destination: '8453',
        isSplit: 'false',
        splitCount: '1',
      });

      expect(mockDeps.prometheus.recordInvoicePurchaseDuration.calledOnce).to.be.true;
      expect(mockDeps.prometheus.recordInvoicePurchaseDuration.firstCall.args[0]).to.deep.equal({
        origin: '1',
        ticker: '0xticker1',
        destination: '8453',
      });
      expect(mockDeps.prometheus.recordInvoicePurchaseDuration.firstCall.args[1]).to.equal(
        mockContext.startTime - invoice.hub_invoice_enqueued_timestamp,
      );

      expect(mockDeps.prometheus.updateRewards.calledOnce).to.be.true;
      expect(mockDeps.prometheus.updateRewards.firstCall.args[0]).to.deep.equal({
        chain: '1',
        asset: '0xtoken1',
        id: '0x123',
        ticker: '0xticker1',
      });
      expect(mockDeps.prometheus.updateRewards.firstCall.args[1]).to.equal(700000000000000);
    });

    it('should handle cache getAllPurchases failure gracefully', async () => {
      const invoice = createMockInvoice();

      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.intentStatus.resolves(IntentStatus.ADDED);

      // Simulate cache failure
      const cacheError = new Error('Cache error');
      mockDeps.purchaseCache.getAllPurchases.rejects(cacheError);

      let thrownError: Error | undefined;
      try {
        await processInvoices(mockContext, [invoice]);
      } catch (error) {
        thrownError = error as Error;
      }

      // Verify error was thrown
      expect(thrownError?.message).to.equal('Cache error');

      // And no purchases were attempted
      expect(mockDeps.purchaseCache.addPurchases.called).to.be.false;
      expect(calculateSplitIntentsStub.called).to.be.false;
      expect(sendIntentsStub.called).to.be.false;
    });

    it('should handle cache addPurchases failure gracefully', async () => {
      const invoice = createMockInvoice();

      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.intentStatus.resolves(IntentStatus.ADDED);
      mockDeps.purchaseCache.getAllPurchases.resolves([]);

      // Setup successful path until addPurchases
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([{
        intentId: '0xabc',
        transactionHash: '0xabc',
        chainId: '8453',
        type: TransactionSubmissionType.Onchain,
      }]);

      // Simulate cache failure
      const cacheError = new Error('Cache add error');
      mockDeps.purchaseCache.addPurchases.rejects(cacheError);

      let thrownError: Error | undefined;
      try {
        await processInvoices(mockContext, [invoice]);
      } catch (error) {
        thrownError = error as Error;
      }

      // Verify error was thrown
      expect(thrownError).to.exist;
      expect(thrownError?.message).to.equal('Cache add error');
    });

    it('should handle cache removePurchases failure gracefully', async () => {
      // Setup test data
      const invoice = createMockInvoice();

      // Setup basic stubs
      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.intentStatuses.resolves(new Map([['0x123', IntentStatus.SETTLED]]));

      // Setup cache data for removal
      mockDeps.purchaseCache.getAllPurchases.resolves([{
        target: invoice,
        purchase: {
          intentId: invoice.intent_id,
          params: {
            amount: '1000000000000000000',
            origin: '1',
            destinations: ['1'],
            to: '0x123',
            inputAsset: '0x123',
            callData: '',
            maxFee: 0
          }
        },
        transactionHash: '0xabc',
        transactionType: TransactionSubmissionType.Onchain,
      }]);

      // Simulate cache failure
      mockDeps.purchaseCache.removePurchases.rejects(new Error('Cache remove error'));

      await processInvoices(mockContext, [invoice]);

      // Verify warning was logged
      expect(mockDeps.logger.warn.calledWith('Failed to clear pending cache')).to.be.true;

      // And Prometheus record was not called except for possible invoice seen
      expect(mockDeps.prometheus.recordSuccessfulPurchase.called).to.be.false;
      expect(mockDeps.prometheus.recordInvoicePurchaseDuration.called).to.be.false;
      expect(mockDeps.prometheus.recordPurchaseClearanceDuration.called).to.be.false;
      expect(mockDeps.prometheus.updateRewards.called).to.be.false;
    });

    it('should adjust custodied balances based on pending intents from economy data', async () => {
      const ticker = '0xticker1';
      const domain1 = '8453';  // Origin domain
      const domain2 = '1';     // Destination domain where Mark has balance

      calculateSplitIntentsStub.restore();
      sinon.stub(assetHelpers, 'getSupportedDomainsForTicker')
        .returns([domain1, domain2]);
      sinon.stub(assetHelpers, 'convertHubAmountToLocalDecimals').returnsArg(0);

      // Mock balances - Mark has enough balance on domain2 to purchase the invoice
      getMarkBalancesStub.resolves(new Map([
        [ticker, new Map([[domain2, BigInt('5000000000000000000')]])]
      ]));
      // Mark has enough gas balance on domain2
      getMarkGasBalancesStub.resolves(new Map([
        [ticker, new Map([[domain2, BigInt('1000000000000000000')]])]
      ]));

      // Mock custodied balances - domain1 has insufficient custodied assets 
      // for Mark to settle out if not including pending intents
      const originalCustodied = new Map([
        [ticker, new Map([
          [domain1, BigInt('500000000000000000')], // Only 0.5 ETH
          [domain2, BigInt('0')]
        ])]
      ]);
      getCustodiedBalancesStub.resolves(originalCustodied);

      // Mock cache with no existing purchases
      mockDeps.purchaseCache.getAllPurchases.resolves([]);
      mockDeps.everclear.intentStatuses.resolves(new Map());

      // Mock economy data with pending intents for domain1
      mockDeps.everclear.fetchEconomyData.callsFake(async (domain, tickerHash) => {
        if (domain === domain1) {
          return {
            currentEpoch: { epoch: 1, startBlock: 1, endBlock: 100 },
            incomingIntents: {
              'chain1': [
                {
                  intentId: '0xintent1',
                  initiator: '0xuser1',
                  amount: '1500000000000000000', // 1.5 ETH in pending intents
                  destinations: [domain2]
                }
              ]
            }
          };
        }

        return {
          currentEpoch: { epoch: 1, startBlock: 1, endBlock: 100 },
          incomingIntents: null
        };
      });

      // Create an invoice going from domain1 to domain2
      const invoice = createMockInvoice({
        ticker_hash: ticker,
        origin: domain1,
        destinations: [domain2],
        amount: '2000000000000000000' // 2 ETH
      });

      // Mock getMinAmounts
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { [domain2]: '2000000000000000000' },
        invoiceAmount: '2000000000000000000',
        amountAfterDiscount: '2000000000000000000',
        discountBps: '0',
        custodiedAmounts: { [domain1]: '500000000000000000' }
      });

      // Mock sendIntents to return success
      sendIntentsStub.resolves([{
        intentId: '0xabc',
        transactionHash: '0xabc',
        chainId: domain2,
        type: TransactionSubmissionType.Onchain,
      }]);

      await processInvoices(mockContext, [invoice]);

      // Verify a purchase was created
      expect(mockDeps.purchaseCache.addPurchases.calledOnce).to.be.true;
      const purchases = mockDeps.purchaseCache.addPurchases.firstCall.args[0];
      expect(purchases.length).to.equal(1);

      // Verify the purchase reflects the allocation that would only be possible
      // if the pending intents were properly added to custodied balances
      const purchaseIntent = purchases[0].purchase.params;
      expect(purchaseIntent.origin).to.equal(domain2);
      expect(purchaseIntent.destinations).to.include(domain1);
    });

    it('should handle failed fetchEconomyData calls gracefully', async () => {
      // Setup basic stubs for the test
      const ticker = '0xticker1';
      const domain1 = '8453';
      const domain2 = '1';

      // Mock getSupportedDomainsForTicker to return our test domains
      const getSupportedDomainsStub = sinon.stub(assetHelpers, 'getSupportedDomainsForTicker')
        .returns([domain1, domain2]);

      // Mock balances and custodied assets
      getMarkBalancesStub.resolves(new Map([
        [ticker, new Map([[domain1, BigInt('5000000000000000000')], [domain2, BigInt('3000000000000000000')]])]
      ]));
      getMarkGasBalancesStub.resolves(new Map());

      // Mock custodied balances - start with 2 ETH custodied in each domain
      const originalCustodied = new Map([
        [ticker, new Map([[domain1, BigInt('2000000000000000000')], [domain2, BigInt('2000000000000000000')]])]
      ]);
      getCustodiedBalancesStub.resolves(originalCustodied);

      // Mock cache with no existing purchases
      mockDeps.purchaseCache.getAllPurchases.resolves([]);
      mockDeps.everclear.intentStatuses.resolves(new Map());

      // Mock economy data fetch - domain1 succeeds, domain2 fails
      mockDeps.everclear.fetchEconomyData.callsFake(async (domain, tickerHash) => {
        if (domain === domain1) {
          return {
            currentEpoch: { epoch: 1, startBlock: 1, endBlock: 100 },
            incomingIntents: {
              'chain1': [
                {
                  intentId: '0xintent1',
                  initiator: '0xuser1',
                  amount: '1000000000000000000', // 1 ETH
                  destinations: [domain2]
                }
              ]
            }
          };
        } else if (domain === domain2) {
          throw new Error('API error');
        }

        return {
          currentEpoch: { epoch: 1, startBlock: 1, endBlock: 100 },
          incomingIntents: null
        };
      });

      // Mock the calculateSplitIntents to examine the adjusted custodied values
      calculateSplitIntentsStub.callsFake(async (context, invoice, minAmounts, remainingBalances, remainingCustodied) => {
        // Verify domain1 was adjusted
        const domain1Custodied = remainingCustodied.get(ticker)?.get(domain1) || BigInt(0);
        expect(domain1Custodied.toString()).to.equal('1000000000000000000');

        // Verify domain2 was NOT adjusted (since fetchEconomyData failed)
        const domain2Custodied = remainingCustodied.get(ticker)?.get(domain2) || BigInt(0);
        expect(domain2Custodied.toString()).to.equal('2000000000000000000');

        return {
          intents: [],
          originDomain: null,
          totalAllocated: BigInt(0),
          remainder: BigInt(0)
        };
      });

      // Mock getMinAmounts to return valid amounts
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { [domain1]: '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // Create a test invoice
      const invoice = createMockInvoice({
        ticker_hash: ticker,
        destinations: [domain1, domain2]
      });

      // Execute the processInvoices function
      await processInvoices(mockContext, [invoice]);

      // Verify that we logged the error for domain2
      expect(mockDeps.logger.warn.calledWith(
        'Failed to fetch economy data for domain, continuing without it'
      )).to.be.true;

      // Verify adjustment was still made for domain1
      expect(mockDeps.logger.info.calledWith(
        'Adjusted custodied assets for domain based on pending intents'
      )).to.be.true;
    });

    it('should handle empty incomingIntents correctly', async () => {
      // Setup basic stubs for the test
      const ticker = '0xticker1';
      const domain = '8453';

      // Mock getSupportedDomainsForTicker to return our test domain
      const getSupportedDomainsStub = sinon.stub(assetHelpers, 'getSupportedDomainsForTicker')
        .returns([domain]);

      // Mock balances and custodied assets
      getMarkBalancesStub.resolves(new Map([
        [ticker, new Map([[domain, BigInt('5000000000000000000')]])]
      ]));
      getMarkGasBalancesStub.resolves(new Map());

      // Mock custodied balances - start with 2 ETH custodied
      const originalCustodied = BigInt('2000000000000000000');
      getCustodiedBalancesStub.resolves(new Map([
        [ticker, new Map([[domain, originalCustodied]])]
      ]));

      // Mock cache with no existing purchases
      mockDeps.purchaseCache.getAllPurchases.resolves([]);
      mockDeps.everclear.intentStatuses.resolves(new Map());

      // Mock economy data fetch with null incomingIntents
      mockDeps.everclear.fetchEconomyData.resolves({
        currentEpoch: { epoch: 1, startBlock: 1, endBlock: 100 },
        incomingIntents: null  // Null incomingIntents
      });

      // Mock the calculateSplitIntents to examine the adjusted custodied values
      calculateSplitIntentsStub.callsFake(async (context, invoice, minAmounts, remainingBalances, remainingCustodied) => {
        // Verify domain custodied was NOT adjusted
        const domainCustodied = remainingCustodied.get(ticker)?.get(domain) || BigInt(0);
        expect(domainCustodied).to.equal(originalCustodied);

        return {
          intents: [],
          originDomain: null,
          totalAllocated: BigInt(0),
          remainder: BigInt(0)
        };
      });

      // Mock getMinAmounts to return valid amounts
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { [domain]: '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // Create a test invoice
      const invoice = createMockInvoice({
        ticker_hash: ticker,
        destinations: [domain]
      });

      // Execute the processInvoices function
      await processInvoices(mockContext, [invoice]);

      // Verify that we did NOT log any adjustments
      const adjustLogCalls = mockDeps.logger.info.getCalls().filter(call =>
        call.args[0] === 'Adjusted custodied assets for domain based on pending intents');
      expect(adjustLogCalls.length).to.equal(0);
    });
  });

  describe('processTickerGroup', () => {
    it('should process a single invoice in a ticker group correctly', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice = createMockInvoice();
      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('1000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([{
        intentId: '0xabc',
        transactionHash: '0xabc',
        chainId: '8453',
        type: TransactionSubmissionType.Onchain,
      }]);

      const result = await processTickerGroup(mockContext, group, []);

      const expectedPurchase = {
        target: invoice,
        transactionHash: '0xabc',
        transactionType: TransactionSubmissionType.Onchain,
        purchase: {
          intentId: '0xabc',
          params: {
            amount: '1000000000000000000',
            origin: '8453',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        }
      };

      // Verify the correct purchases were created
      expect(result.purchases).to.deep.equal([expectedPurchase]);

      // Verify remaining balances were updated correctly
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));
    });

    it('should process multiple invoices in a ticker group correctly', async () => {
      isXerc20SupportedStub.resolves(false);
      // Mock cumulative API responses for multiple invoices
      mockDeps.everclear.getMinAmounts.onFirstCall().resolves({
        minAmounts: { '8453': '1000000000000000000' }, // First invoice: 1 WETH cumulative
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });
      
      mockDeps.everclear.getMinAmounts.onSecondCall().resolves({
        minAmounts: { '8453': '1000000000000000000' }, // Second invoice: 1 WETH independent
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice1 = createMockInvoice({ intent_id: '0x123' });
      const invoice2 = createMockInvoice({ intent_id: '0x456' });

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice1, invoice2],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      // Call to calculateSplitIntents for both invoices
      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([
        {
          intentId: '0xabc',
          transactionHash: '0xabc',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);

      const expectedPurchases = [
        {
          target: invoice1,
          transactionHash: '0xabc',
          transactionType: TransactionSubmissionType.Onchain,
          purchase: {
            intentId: '0xabc',
            params: {
              amount: '1000000000000000000',
              origin: '8453',
              destinations: ['1', '10'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          }
        },
        {
          target: invoice2,
          transactionHash: '0xdef',
          transactionType: TransactionSubmissionType.Onchain,
          purchase: {
            intentId: '0xdef',
            params: {
              amount: '1000000000000000000',
              origin: '8453',
              destinations: ['1', '10'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          }
        }
      ];

      // Verify the correct purchases were created
      expect(result.purchases).to.deep.equal(expectedPurchases);

      // Verify remaining balances were updated correctly (2 ETH - 1 ETH - 1 ETH = 0)
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));
    });

    it('should process split purchases for a single invoice correctly', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '2000000000000000000' },
        invoiceAmount: '2000000000000000000',
        amountAfterDiscount: '2000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice = createMockInvoice();
      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      // Two split intents to settle this invoice
      calculateSplitIntentsStub.resolves({
        intents: [
          {
            amount: '1000000000000000000',
            origin: '8453',
            destinations: ['1', '10'], // 1 is the target dest
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          },
          {
            amount: '1000000000000000000',
            origin: '8453',
            destinations: ['10', '1'], // 10 is the target dest
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        ],
        originDomain: '8453',
        totalAllocated: BigInt('2000000000000000000')
      });

      sendIntentsStub.resolves([
        {
          intentId: '0xabc',
          transactionHash: '0xabc',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }]);

      const result = await processTickerGroup(mockContext, group, []);

      const expectedPurchases = [
        {
          target: invoice,
          transactionHash: '0xabc',
          transactionType: TransactionSubmissionType.Onchain,
          purchase: {
            intentId: '0xabc',
            params: {
              amount: '1000000000000000000',
              origin: '8453',
              destinations: ['1', '10'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          }
        },
        {
          target: invoice,
          transactionHash: '0xdef',
          transactionType: TransactionSubmissionType.Onchain,
          purchase: {
            intentId: '0xdef',
            params: {
              amount: '1000000000000000000',
              origin: '8453',
              destinations: ['10', '1'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          }
        }
      ];

      // Verify the correct split intent purchases were created
      expect(result.purchases).to.deep.equal(expectedPurchases);

      // Verify remaining balances were updated correctly (2 ETH - 2 ETH = 0)
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));
    });

    it('should filter out invalid invoices correctly', async () => {
      // Create invoices with different invalid reasons
      const validInvoice = createMockInvoice();
      const zeroAmountInvoice = createMockInvoice({
        intent_id: '0x456',
        amount: '0'
      });
      const invalidOwnerInvoice = createMockInvoice({
        intent_id: '0x789',
        owner: mockContext.config.ownAddress
      });
      const tooNewInvoice = createMockInvoice({
        intent_id: '0xabc',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000)
      });

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [validInvoice, zeroAmountInvoice, invalidOwnerInvoice, tooNewInvoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('4000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      // Set up stubs for the valid invoice to be processed
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([{
        intentId: '0xabc',
        transactionHash: '0xabc',
        chainId: '8453',
        type: TransactionSubmissionType.Onchain,
      }]);

      const result = await processTickerGroup(mockContext, group, []);

      // Verify only the valid invoice made it through
      expect(result.purchases.length).to.equal(1);
      expect(result.purchases[0].target.intent_id).to.equal(validInvoice.intent_id);

      // And prometheus metrics were recorded for invalid invoices
      expect(mockDeps.prometheus.recordInvalidPurchase.callCount).to.equal(3);
      expect(mockDeps.prometheus.recordInvalidPurchase.getCall(0).args[0]).to.equal(InvalidPurchaseReasons.InvalidFormat);
      expect(mockDeps.prometheus.recordInvalidPurchase.getCall(1).args[0]).to.equal(InvalidPurchaseReasons.InvalidOwner);
      expect(mockDeps.prometheus.recordInvalidPurchase.getCall(2).args[0]).to.equal(InvalidPurchaseReasons.InvalidAge);
    });

    it('should skip the entire ticker group if a purchase is pending', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice = createMockInvoice({ intent_id: '0x123' });

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      // Create a pending purchase for invoice1
      const pendingPurchases = [{
        target: invoice,
        purchase: {
          intentId: '0xexisting',
          params: {
            amount: '1000000000000000000',
            origin: '8453',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        },
        transactionHash: '0xexisting',
        transactionType: TransactionSubmissionType.Onchain,
      }];

      const result = await processTickerGroup(mockContext, group, pendingPurchases);

      // Should skip entire group, no purchases
      expect(result.purchases).to.deep.equal([]);
    });

    it('should skip invoice if XERC20 is supported', async () => {
      // Invoice has xerc20 support
      isXerc20SupportedStub.onFirstCall().resolves(true);

      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice = createMockInvoice({ intent_id: '0x123' });

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      const result = await processTickerGroup(mockContext, group, []);

      // Should skip the only invoice, no purchases
      expect(result.purchases).to.deep.equal([]);
    });

    it('should filter out origins with pending purchases', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000', '10': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice = createMockInvoice();
      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([
          ['8453', BigInt('1000000000000000000')],
          ['10', BigInt('1000000000000000000')]
        ])]]),
        remainingCustodied: new Map([['0xticker1', new Map([
          ['8453', BigInt('0')],
          ['10', BigInt('0')]
        ])]]),
        chosenOrigin: null
      };

      // Create a pending purchase for the same ticker on origin 8453
      const pendingPurchases = [{
        target: createMockInvoice({ intent_id: '0xother' }),
        purchase: {
          intentId: '0xexisting',
          params: {
            amount: '1000000000000000000',
            origin: '8453', // This origin should be filtered out
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        },
        transactionHash: '0xexisting',
        transactionType: TransactionSubmissionType.Onchain,
      }];

      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '10', // Should use origin 10 since 8453 is out
          destinations: ['1', '8453'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '10',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([{
        intentId: '0xabc',
        transactionHash: '0xabc',
        chainId: '10',
        type: TransactionSubmissionType.Onchain,
      }]);

      const result = await processTickerGroup(mockContext, group, pendingPurchases);

      // Verify the purchase uses origin 10
      expect(result.purchases.length).to.equal(1);
      expect(result.purchases[0].purchase.params.origin).to.equal('10');
    });

    it('should skip invoice when all origins are filtered out due to pending purchases', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice = createMockInvoice();
      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('1000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      // Create pending purchases that will filter out all origins
      const pendingPurchases = [
        {
          target: createMockInvoice({ intent_id: '0x456' }),
          purchase: {
            intentId: '0xexisting1',
            params: {
              amount: '1000000000000000000',
              origin: '8453',
              destinations: ['1', '10'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          },
          transactionHash: '0xabc',
          transactionType: TransactionSubmissionType.Onchain,
        }
      ];

      const result = await processTickerGroup(mockContext, group, pendingPurchases);

      // Verify the invoice is skipped since no valid origins remain
      expect(result.purchases).to.deep.equal([]);
      expect(mockDeps.logger.info.calledWith('No valid origins remain after filtering existing purchases')).to.be.true;
    });

    it('should skip other invoices when forceOldestInvoice is true and oldest invoice has no valid allocation', async () => {
      mockContext.config.forceOldestInvoice = true;
      isXerc20SupportedStub.resolves(false);

      const oldestInvoice = createMockInvoice({
        intent_id: '0x123',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 7200 // 2 hours old
      });
      const newerInvoice = createMockInvoice({
        intent_id: '0x456',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 3600 // 1 hour old
      });

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [oldestInvoice, newerInvoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // No valid allocation for the oldest invoice
      calculateSplitIntentsStub.resolves({
        intents: [],
        originDomain: null,
        totalAllocated: BigInt('0')
      });

      const result = await processTickerGroup(mockContext, group, []);

      // Skip entire group since oldest invoice couldn't be processed, no purchases
      expect(result.purchases).to.deep.equal([]);
    });

    it('should process newer invoices when forceOldestInvoice is false and oldest invoice has no valid allocation', async () => {
      mockContext.config.forceOldestInvoice = false;
      isXerc20SupportedStub.resolves(false);

      const oldestInvoice = createMockInvoice({
        intent_id: '0x123',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 7200 // 2 hours old
      });
      const newerInvoice = createMockInvoice({
        intent_id: '0x456',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) - 3600 // 1 hour old
      });

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [oldestInvoice, newerInvoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // No valid allocation for oldest invoice
      calculateSplitIntentsStub.onFirstCall().resolves({
        intents: [],
        originDomain: null,
        totalAllocated: BigInt('0')
      });

      // Valid allocation for newer invoice
      calculateSplitIntentsStub.onSecondCall().resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([{
        intentId: '0xabc',
        transactionHash: '0xabc',
        chainId: '8453',
        type: TransactionSubmissionType.Onchain,
      }]);

      const result = await processTickerGroup(mockContext, group, []);

      // Should process newer invoice
      expect(result.purchases.length).to.equal(1);
      expect(result.purchases[0].target.intent_id).to.equal(newerInvoice.intent_id);
    });

    it('should use the same origin for all invoices in a group once chosen', async () => {
      isXerc20SupportedStub.resolves(false);

      const invoice1 = createMockInvoice({ intent_id: '0x123' });
      const invoice2 = createMockInvoice({ intent_id: '0x456' });
      const invoice3 = createMockInvoice({ intent_id: '0x789' });

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice1, invoice2, invoice3],
        remainingBalances: new Map([['0xticker1', new Map([
          ['8453', BigInt('3000000000000000000')],
          ['10', BigInt('3000000000000000000')]
        ])]]),
        remainingCustodied: new Map([['0xticker1', new Map([
          ['8453', BigInt('0')],
          ['10', BigInt('0')]
        ])]]),
        chosenOrigin: null
      };

      // Both origins (8453 and 10) are valid options
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: {
          '8453': '1000000000000000000',
          '10': '1000000000000000000'
        },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // First invoice chooses origin 8453
      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.resolves([
        {
          intentId: '0xabc1',
          transactionHash: '0xabc1',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xabc2',
          transactionHash: '0xabc2',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xabc3',
          transactionHash: '0xabc3',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);

      // Verify all purchases use the same origin
      expect(result.purchases.length).to.equal(3);
      result.purchases.forEach(purchase => {
        expect(purchase.purchase.params.origin).to.equal('8453');
      });

      // Verify remaining balances were updated correctly (3 ETH - 1 ETH - 1 ETH - 1 ETH = 0)
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));
    });

    it('should skip invoices with insufficient balance on chosen origin but continue processing others', async () => {
      isXerc20SupportedStub.resolves(false);

      const invoice1 = createMockInvoice({ intent_id: '0x123', amount: '1000000000000000000' });
      const invoice2 = createMockInvoice({ intent_id: '0x456', amount: '2000000000000000000' }); // Requires more balance
      const invoice3 = createMockInvoice({ intent_id: '0x789', amount: '500000000000000000' }); // Can be purchased

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice1, invoice2, invoice3],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('1500000000000000000')]])]]), // 1.5 WETH total
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      // API returns cumulative amounts for all outstanding invoices
      mockDeps.everclear.getMinAmounts.onFirstCall().resolves({
        minAmounts: { '8453': '1000000000000000000' }, // First invoice: 1 WETH cumulative
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      mockDeps.everclear.getMinAmounts.onSecondCall().resolves({
        minAmounts: { '8453': '2000000000000000000' }, // Second invoice: 2 WETH independent
        invoiceAmount: '2000000000000000000',
        amountAfterDiscount: '2000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      mockDeps.everclear.getMinAmounts.onThirdCall().resolves({
        minAmounts: { '8453': '500000000000000000' }, // Third invoice: 0.5 WETH independent
        invoiceAmount: '500000000000000000',
        amountAfterDiscount: '500000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // First invoice succeeds and sets origin to 8453
      calculateSplitIntentsStub.onFirstCall().resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      // Third invoice succeeds (second is skipped due to insufficient balance)
      calculateSplitIntentsStub.onSecondCall().resolves({
        intents: [{
          amount: '500000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('500000000000000000')
      });

      sendIntentsStub.resolves([
        {
          intentId: '0xabc',
          transactionHash: '0xabc',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);

      // Verify only invoice1 and invoice3 were processed (invoice2 skipped)
      expect(result.purchases.length).to.equal(2);
      expect(result.purchases[0].target.intent_id).to.equal(invoice1.intent_id);
      expect(result.purchases[1].target.intent_id).to.equal(invoice3.intent_id);

      // Verify the remaining balance was updated correctly (1.5 ETH - 1 ETH - 0.5 ETH = 0)
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));
    });

    it('should handle getMinAmounts failure gracefully', async () => {
      isXerc20SupportedStub.resolves(false);

      const invoice = createMockInvoice();

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      // Mock getMinAmounts to return an error
      mockDeps.everclear.getMinAmounts.rejects(new Error('Failed to get min amounts'));

      // Mock calculateSplitIntents to return empty result when minAmounts fails
      calculateSplitIntentsStub.resolves({
        intents: [],
        originDomain: null,
        totalAllocated: BigInt('0')
      });

      const result = await processTickerGroup(mockContext, group, []);

      // Should return an empty result with no purchases
      expect(result.purchases).to.be.empty;
      expect(result.remainingBalances).to.deep.equal(group.remainingBalances);
      expect(result.remainingCustodied).to.deep.equal(group.remainingCustodied);
    });

    it('should handle sendIntents failure gracefully', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      const invoice = createMockInvoice();
      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('1000000000000000000')]])]]),
        remainingCustodied: new Map([['0xticker1', new Map([['8453', BigInt('0')]])]]),
        chosenOrigin: null
      };

      calculateSplitIntentsStub.resolves({
        intents: [{
          amount: '1000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      sendIntentsStub.rejects(new Error('Transaction failed'));

      let thrownError: Error | undefined;
      try {
        await processTickerGroup(mockContext, group, []);
      } catch (error) {
        thrownError = error as Error;
      }

      // Verify error was thrown
      expect(thrownError?.message).to.equal('Transaction failed');
      expect(mockDeps.prometheus.recordInvalidPurchase.calledOnce).to.be.true;
      expect(mockDeps.prometheus.recordInvalidPurchase.firstCall.args[0]).to.equal(InvalidPurchaseReasons.TransactionFailed);
    });

    it('should map split intents to their respective invoices correctly', async () => {
      getMarkBalancesStub.resolves(new Map([
        ['0xticker1', new Map([['8453', BigInt('2000000000000000000')]])] // 2 WETH total for both invoices
      ]));
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);
      mockDeps.purchaseCache.getAllPurchases.resolves([]);
      mockDeps.everclear.intentStatuses.resolves(new Map());

      const invoice1 = createMockInvoice({
        intent_id: '0x123',
        origin: '1',
        destinations: ['8453'],
        amount: '1000000000000000000'
      });

      const invoice2 = createMockInvoice({
        intent_id: '0x456',
        origin: '1',
        destinations: ['8453'],
        amount: '1000000000000000000'
      });

      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: {
          '8453': '1000000000000000000'
        },
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // First invoice gets two split intents
      calculateSplitIntentsStub.onFirstCall().resolves({
        intents: [
          {
            amount: '500000000000000000',
            origin: '8453',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          },
          {
            amount: '500000000000000000',
            origin: '8453',
            destinations: ['10', '1'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        ],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      // Second invoice gets a single intent
      calculateSplitIntentsStub.onSecondCall().resolves({
        intents: [
          {
            amount: '1000000000000000000',
            origin: '8453',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        ],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000')
      });

      // Three txs total (2 for first invoice, 1 for second)
      sendIntentsStub.resolves([
        {
          intentId: '0xabc1',
          transactionHash: '0xabc1',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xabc2',
          transactionHash: '0xabc2',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }
      ]);

      await processInvoices(mockContext, [invoice1, invoice2]);

      const expectedPurchases = [
        {
          target: invoice1,  // First two purchases target invoice1
          transactionHash: '0xabc1',
          transactionType: TransactionSubmissionType.Onchain,
          purchase: {
            intentId: '0xabc1',
            params: {
              amount: '500000000000000000',
              origin: '8453',
              destinations: ['1', '10'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          }
        },
        {
          target: invoice1,  // First two purchases target invoice1
          transactionHash: '0xabc2',
          transactionType: TransactionSubmissionType.Onchain,
          purchase: {
            intentId: '0xabc2',
            params: {
              amount: '500000000000000000',
              origin: '8453',
              destinations: ['10', '1'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          }
        },
        {
          target: invoice2,  // Third purchase targets invoice2
          transactionHash: '0xdef',
          transactionType: TransactionSubmissionType.Onchain,
          purchase: {
            intentId: '0xdef',
            params: {
              amount: '1000000000000000000',
              origin: '8453',
              destinations: ['1', '10'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          }
        }
      ];

      // Verify the correct purchases were stored in cache with proper invoice mapping
      expect(mockDeps.purchaseCache.addPurchases.calledOnce).to.be.true;
      expect(mockDeps.purchaseCache.addPurchases.firstCall.args[0]).to.deep.equal(expectedPurchases);
    });

    it('should handle different intent statuses for pending purchases correctly', async () => {
      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);

      const invoice = createMockInvoice();

      const pendingPurchases = [
        {
          target: invoice,
          purchase: {
            intentId: '0xexisting1',
            params: {
              amount: '1000000000000000000',
              origin: '8453',
              destinations: ['1', '10'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          },
          transactionHash: '0xexisting1',
          transactionType: TransactionSubmissionType.Onchain,
        },
        {
          target: invoice,
          purchase: {
            intentId: '0xexisting2',
            params: {
              amount: '1000000000000000000',
              origin: '10',
              destinations: ['1', '8453'],
              to: '0xowner',
              inputAsset: '0xtoken1',
              callData: '0x',
              maxFee: '0'
            }
          },
          transactionHash: '0xexisting2',
          transactionType: TransactionSubmissionType.Onchain,
        }
      ];

      mockDeps.purchaseCache.getAllPurchases.resolves(pendingPurchases);

      mockDeps.everclear.intentStatuses.resolves(new Map([
        ['0xexisting1', IntentStatus.SETTLED],
        ['0xexisting2', IntentStatus.ADDED]
      ]));

      await processInvoices(mockContext, [invoice]);

      // Verify that SETTLED intent was removed from consideration
      expect(mockDeps.purchaseCache.removePurchases.calledWith(['0x123'])).to.be.true;

      // Verify that ADDED intent was kept
      expect(mockDeps.purchaseCache.removePurchases.neverCalledWith(['0xexisting2'])).to.be.true;
    });

    it('should correctly update remaining custodied balances for split intents', async () => {
      isXerc20SupportedStub.resolves(false);
      // First call to getMinAmounts (for first invoice)
      mockDeps.everclear.getMinAmounts.onFirstCall().resolves({
        minAmounts: { '8453': '4000000000000000000' }, // 4 WETH needed for first invoice
        invoiceAmount: '4000000000000000000',
        amountAfterDiscount: '4000000000000000000',
        discountBps: '0',
        custodiedAmounts: {
          '1': '3000000000000000000',
          '10': '2000000000000000000',
          '8453': '5000000000000000000'
        }
      });

      // Second call to getMinAmounts (for second invoice) - independent amount
      mockDeps.everclear.getMinAmounts.onSecondCall().resolves({
        minAmounts: { '8453': '1000000000000000000' }, // 1 WETH independent for second invoice
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '1000000000000000000',
        discountBps: '0',
        custodiedAmounts: {
          '1': '0', // No custodied assets for second invoice
          '10': '1000000000000000000', // 1 WETH available for second invoice
          '8453': '1000000000000000000'
        }
      });

      const invoice1 = createMockInvoice({ intent_id: '0x123' });
      const invoice2 = createMockInvoice({ intent_id: '0x456' });

      // Set up initial custodied balances for multiple destinations
      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice1, invoice2],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('5000000000000000000')]])]]), // 5 WETH total
        remainingCustodied: new Map([
          ['0xticker1', new Map([
            ['1', BigInt('3000000000000000000')],    // 3 WETH on Ethereum
            ['10', BigInt('2000000000000000000')],   // 2 WETH on Optimism
            ['8453', BigInt('5000000000000000000')], // 5 WETH on Base
          ])]
        ]),
        chosenOrigin: null
      };

      // First invoice gets two split intents targeting different destinations
      calculateSplitIntentsStub.onFirstCall().resolves({
        intents: [
          {
            amount: '3000000000000000000', // 3 WETH
            origin: '8453',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          },
          {
            amount: '1000000000000000000', // 1 WETH
            origin: '8453',
            destinations: ['10', '1'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        ],
        originDomain: '8453',
        totalAllocated: BigInt('4000000000000000000'), // 4 WETH total for first invoice
        remainder: BigInt('0')
      });

      // Second invoice gets a single intent
      calculateSplitIntentsStub.onSecondCall().resolves({
        intents: [{
          amount: '1000000000000000000', // 1 WETH
          origin: '8453',
          destinations: ['10', '1'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('1000000000000000000'), // 1 WETH for second invoice
        remainder: BigInt('0')
      });

      sendIntentsStub.resolves([
        {
          intentId: '0xabc1',
          transactionHash: '0xabc1',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xabc2',
          transactionHash: '0xabc2',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);

      // Verify the correct purchases were created
      expect(result.purchases.length).to.equal(3);
      expect(result.purchases[0].target.intent_id).to.equal(invoice1.intent_id);
      expect(result.purchases[1].target.intent_id).to.equal(invoice1.intent_id);
      expect(result.purchases[2].target.intent_id).to.equal(invoice2.intent_id);

      // Verify remaining balances were updated correctly (5 ETH - 4 ETH - 1 ETH = 0)
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));

      // Verify remaining custodied balances were updated correctly
      const remainingCustodied = result.remainingCustodied.get('0xticker1');
      expect(remainingCustodied?.get('1')).to.equal(BigInt('0')); // 3 - 3 = 0 left
      expect(remainingCustodied?.get('10')).to.equal(BigInt('0')); // 2 - 1 - 1 = 0 left
      expect(remainingCustodied?.get('8453')).to.equal(BigInt('5000000000000000000'));
    });

    it('should correctly distribute remainder intents across destinations', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '6000000000000000000' }, // 6 WETH needed
        invoiceAmount: '6000000000000000000',
        amountAfterDiscount: '6000000000000000000',
        discountBps: '0',
        custodiedAmounts: {
          '1': '2000000000000000000',    // 2 WETH
          '10': '3000000000000000000',   // 3 WETH
          '8453': '5000000000000000000'  // 5 WETH
        }
      });

      const invoice = createMockInvoice();

      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice],
        remainingBalances: new Map([['0xticker1', new Map([['8453', BigInt('6000000000000000000')]])]]),
        remainingCustodied: new Map([
          ['0xticker1', new Map([
            ['1', BigInt('2000000000000000000')],    // 2 WETH
            ['10', BigInt('3000000000000000000')],   // 3 WETH
            ['8453', BigInt('5000000000000000000')]  // 5 WETH
          ])]
        ]),
        chosenOrigin: null
      };

      // Create a scenario with a remainder that needs to be distributed
      calculateSplitIntentsStub.resolves({
        intents: [
          {
            amount: '2000000000000000000', // 2 WETH allocated to 1
            origin: '8453',
            destinations: ['1', '10'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          },
          {
            amount: '3000000000000000000', // 3 WETH allocated to 10
            origin: '8453',
            destinations: ['10', '1'],
            to: '0xowner',
            inputAsset: '0xtoken1',
            callData: '0x',
            maxFee: '0'
          }
        ],
        originDomain: '8453',
        totalAllocated: BigInt('5000000000000000000'), // 5 WETH allocated
        remainder: BigInt('1000000000000000000') // 1 WETH remainder
      });

      sendIntentsStub.resolves([
        {
          intentId: '0xabc1',
          transactionHash: '0xabc1',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xabc2',
          transactionHash: '0xabc2',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);

      // Verify the correct purchases were created
      expect(result.purchases.length).to.equal(2);
      expect(result.purchases[0].target.intent_id).to.equal(invoice.intent_id);
      expect(result.purchases[1].target.intent_id).to.equal(invoice.intent_id);

      // Verify remaining balances were updated correctly (6 ETH - 6 ETH = 0)
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));

      // Verify remaining custodied balances were updated correctly
      const remainingCustodied = result.remainingCustodied.get('0xticker1');
      expect(remainingCustodied?.get('1')).to.equal(BigInt('0'));
      expect(remainingCustodied?.get('10')).to.equal(BigInt('0'));

      // Base chain balance remains unchanged
      expect(remainingCustodied?.get('8453')).to.equal(BigInt('5000000000000000000'));
    });

    it('should correctly update balances and custodied after processing multiple invoices', async () => {
      isXerc20SupportedStub.resolves(false);

      // Create two simple invoices
      const invoice1 = createMockInvoice({
        intent_id: '0x123',
        amount: '2000000000000000000', // 2 WETH
        origin: '1',
        destinations: ['8453']
      });

      const invoice2 = createMockInvoice({
        intent_id: '0x456',
        amount: '3000000000000000000', // 3 WETH
        origin: '1',
        destinations: ['8453']
      });

      // Set up initial balances - enough for both invoices
      const group: TickerGroup = {
        ticker: '0xticker1',
        invoices: [invoice1, invoice2],
        remainingBalances: new Map([['0xticker1', new Map([
          ['8453', BigInt('10000000000000000000')],  // 10 WETH - enough for both
        ])]]),
        remainingCustodied: new Map([['0xticker1', new Map([
          ['8453', BigInt('0')],  // No custodied assets to simplify
        ])]]),
        chosenOrigin: null
      };

      // Mock getMinAmounts for both invoices - API returns cumulative amounts
      mockDeps.everclear.getMinAmounts.onFirstCall().resolves({
        minAmounts: { '8453': '2000000000000000000' }, // First invoice: 2 WETH cumulative
        invoiceAmount: '2000000000000000000',
        amountAfterDiscount: '2000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      mockDeps.everclear.getMinAmounts.onSecondCall().resolves({
        minAmounts: { '8453': '3000000000000000000' }, // Second invoice: 3 WETH independent
        invoiceAmount: '3000000000000000000',
        amountAfterDiscount: '3000000000000000000',
        discountBps: '0',
        custodiedAmounts: {}
      });

      // Mock calculateSplitIntents for both invoices
      calculateSplitIntentsStub.onFirstCall().resolves({
        intents: [{
          amount: '2000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0',
        }],
        originDomain: '8453',
        totalAllocated: BigInt('0'),
        remainder: BigInt('2000000000000000000'),
      });

      calculateSplitIntentsStub.onSecondCall().resolves({
        intents: [{
          amount: '3000000000000000000',
          origin: '8453',
          destinations: ['1', '10'],
          to: '0xowner',
          inputAsset: '0xtoken1',
          callData: '0x',
          maxFee: '0'
        }],
        originDomain: '8453',
        totalAllocated: BigInt('0'),
        remainder: BigInt('3000000000000000000')
      });

      sendIntentsStub.resolves([
        {
          intentId: '0xabc1',
          transactionHash: '0xabc1',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        },
        {
          intentId: '0xdef1',
          transactionHash: '0xdef1',
          chainId: '8453',
          type: TransactionSubmissionType.Onchain,
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);

      // Verify both invoices were processed
      expect(result.purchases.length).to.equal(2);
      expect(result.purchases[0].target.intent_id).to.equal(invoice1.intent_id);
      expect(result.purchases[1].target.intent_id).to.equal(invoice2.intent_id);

      // Verify remaining balances were updated correctly (10 ETH - 2 ETH - 3 ETH = 5 ETH)
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(
        BigInt('5000000000000000000')
      );

      // Verify custodied balances remain unchanged (no custodied assets used)
      const remainingCustodied = result.remainingCustodied.get('0xticker1');
      expect(remainingCustodied?.get('8453')).to.equal(BigInt('0'));
    });
  });
});
