import { expect } from '../globalTestHook';
import sinon, { createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import { ProcessingContext } from '../../src/init';
import { processInvoices, processTickerGroup, TickerGroup } from '../../src/invoice/processInvoices';
import * as balanceHelpers from '../../src/helpers/balance';
import * as assetHelpers from '../../src/helpers/asset';
import { IntentStatus } from '@mark/everclear';
import { PurchaseAction } from '@mark/cache';
import { NewIntentParams, MarkConfiguration, Invoice, InvalidPurchaseReasons } from '@mark/core';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { PurchaseCache } from '@mark/cache';
import { Wallet, BigNumber } from 'ethers';
import { PrometheusAdapter } from '@mark/prometheus';
import * as intentHelpers from '../../src/helpers/intent';
import * as splitIntentHelpers from '../../src/helpers/splitIntent';
import { MAX_DESTINATIONS } from '../../src/invoice/processInvoices';

describe('Invoice Processing', () => {
  let mockContext: SinonStubbedInstance<ProcessingContext>;

  let getMarkBalancesStub: SinonStub;
  let getMarkGasBalancesStub: SinonStub;
  let getCustodiedBalancesStub: SinonStub;
  let isXerc20SupportedStub: SinonStub;
  let calculateSplitIntentsStub: SinonStub;
  let sendIntentsStub: SinonStub;

  let mockDeps: {
    logger: SinonStubbedInstance<Logger>;
    everclear: SinonStubbedInstance<EverclearAdapter>;
    chainService: SinonStubbedInstance<ChainService>;
    cache: SinonStubbedInstance<PurchaseCache>;
    web3Signer: SinonStubbedInstance<Wallet>;
    prometheus: SinonStubbedInstance<PrometheusAdapter>;
    config: MarkConfiguration;
  };

  // Default single-dest mock invoice
  function createMockInvoice(overrides?: Partial<Invoice>): Invoice {
    return {
      intent_id: '0x123',
      amount: '1000000000000000000',
      origin: '1',
      destinations: ['8453'],
      ticker_hash: '0xticker1',
      hub_invoice_enqueued_timestamp: Date.now() - 7200000,
      source_domain: '1',
      target_domain: '8453',
      source_address: '0xsource',
      target_address: '0xtarget',
      source_token_address: '0xtoken1',
      target_token_address: '0xtoken2',
      status: 'PENDING',
      owner: '0xowner',
      entry_epoch: 0,
      discountBps: 0,
      hub_status: 'PENDING',
      severity: 0,
      ...overrides,
    } as Invoice;
  }

  beforeEach(() => {
    // Init with fresh stubs and mocks
    getMarkBalancesStub = sinon.stub(balanceHelpers, 'getMarkBalances');
    getMarkGasBalancesStub = sinon.stub(balanceHelpers, 'getMarkGasBalances');
    getCustodiedBalancesStub = sinon.stub(balanceHelpers, 'getCustodiedBalances');
    isXerc20SupportedStub = sinon.stub(assetHelpers, 'isXerc20Supported');
    calculateSplitIntentsStub = sinon.stub(splitIntentHelpers, 'calculateSplitIntents');
    sendIntentsStub = sinon.stub(intentHelpers, 'sendIntents');

    // Default mock config supports 1, 8453, 10 and one token on each
    mockDeps = {
      logger: createStubInstance(Logger),
      everclear: createStubInstance(EverclearAdapter),
      chainService: createStubInstance(ChainService),
      cache: createStubInstance(PurchaseCache),
      web3Signer: createStubInstance(Wallet),
      prometheus: createStubInstance(PrometheusAdapter),
      config: {
        chains: {
          '1': {
            providers: ['http://localhost:8545'],
            assets: [{
              tickerHash: '0xticker1',
              address: '0xtoken1',
              decimals: 18,
              symbol: 'TEST',
              isNative: false,
              balanceThreshold: '1000000000000000000',
            }],
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890'
            },
            invoiceAge: 3600,
            gasThreshold: '1000000000000000000'
          },
          '8453': {
            providers: ['http://localhost:8545'],
            assets: [{
              tickerHash: '0xticker1',
              address: '0xtoken1',
              decimals: 18,
              symbol: 'TEST',
              isNative: false,
              balanceThreshold: '1000000000000000000',
            }],
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890'
            },
            invoiceAge: 3600,
            gasThreshold: '1000000000000000000'
          },
          '10': {
            providers: ['http://localhost:8545'],
            assets: [{
              tickerHash: '0xticker1',
              address: '0xtoken1',
              decimals: 18,
              symbol: 'TEST',
              isNative: false,
              balanceThreshold: '1000000000000000000',
            }],
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890'
            },
            invoiceAge: 3600,
            gasThreshold: '1000000000000000000'
          },
        },
        prioritizeOldestInvoice: false,
        pushGatewayUrl: 'http://localhost:9091',
        web3SignerUrl: 'http://localhost:8545',
        everclearApiUrl: 'http://localhost:3000',
        relayer: {
          url: 'http://localhost:8080',
          apiKey: 'test'
        },
        hubChain: 1,
        hubMainnetChain: 1,
        hubStorageAddress: '0x1234567890123456789012345678901234567890',
        permit2Address: '0x1234567890123456789012345678901234567890',
        multicallAddress: '0x1234567890123456789012345678901234567890',
        balanceThresholds: {},
        gasThresholds: {},
        redis: {
          host: 'localhost',
          port: 6379
        },
        ownAddress: '0x1234567890123456789012345678901234567890',
        stage: 'development',
        environment: 'devnet',
        logLevel: 'debug',
        supportedAssets: ['0xticker1'],
        supportedSettlementDomains: [1, 8453],
        hub: {
          domain: '1',
          providers: ['http://localhost:8545'],
          assets: [{
            tickerHash: '0xticker1',
            address: '0xtoken1',
            decimals: 18,
            symbol: 'TEST',
            isNative: false,
            balanceThreshold: '1000000000000000000'
          }]
        }
      } as MarkConfiguration
    };

    mockContext = {
      requestId: 'test-request-id',
      startTime: Date.now(),
      ...mockDeps
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('processInvoices', () => {
    it('should remove stale cache purchases successfully', async () => {
      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);

      // Make invoice SETTLED, which means it should be removed
      mockDeps.everclear.intentStatus.resolves(IntentStatus.SETTLED);

      const invoices = [createMockInvoice()];

      // Mock the returned purchase from cache
      mockDeps.cache.getAllPurchases.resolves([{
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
        transactionHash: '0xabc'
      }]);

      await processInvoices(mockContext, invoices);
      
      expect(mockDeps.cache.removePurchases.calledWith(['0x123'])).to.be.true;
    });

    it('should correctly store a purchase in the cache', async () => {
      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);
      mockDeps.cache.getAllPurchases.resolves([]);
      mockDeps.everclear.intentStatus.resolves(IntentStatus.ADDED);

      const invoice = createMockInvoice();
      
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
        chainId: '8453'
      }]);

      await processInvoices(mockContext, [invoice]);
      
      const expectedPurchase = {
        target: invoice,
        transactionHash: '0xabc',
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
      expect(mockDeps.cache.addPurchases.calledOnce).to.be.true;
      expect(mockDeps.cache.addPurchases.firstCall.args[0]).to.deep.equal([expectedPurchase]);
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
        chainId: '8453'
      }]);

      const result = await processTickerGroup(mockContext, group, []);
      
      const expectedPurchase = {
        target: invoice,
        transactionHash: '0xabc',
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

      // And the remaining balances were updated correctly
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));
    });

    it('should process multiple invoices in a ticker group correctly', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.resolves({
        minAmounts: { '8453': '1000000000000000000' },
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
          chainId: '8453'
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453'
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);
      
      const expectedPurchases = [
        {
          target: invoice1,
          transactionHash: '0xabc',
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

      // And the remaining balances were updated correctly
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
          chainId: '8453'
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453'
      }]);

      const result = await processTickerGroup(mockContext, group, []);
      
      const expectedPurchases = [
        {
          target: invoice,
          transactionHash: '0xabc',
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

      // And the remaining balances were updated correctly
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
        owner: mockDeps.config.ownAddress
      });
      const tooNewInvoice = createMockInvoice({
        intent_id: '0xabc',
        hub_invoice_enqueued_timestamp: Date.now()
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
        chainId: '8453'
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
        transactionHash: '0xexisting'
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
        transactionHash: '0xexisting'
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
        chainId: '10'
      }]);

      const result = await processTickerGroup(mockContext, group, pendingPurchases);
      
      // Verify the purchase uses origin 10
      expect(result.purchases.length).to.equal(1);
      expect(result.purchases[0].purchase.params.origin).to.equal('10');
    });

    it('should skip other invoices when prioritizeOldestInvoice is true and oldest invoice has no valid allocation', async () => {
      mockDeps.config.prioritizeOldestInvoice = true;
      isXerc20SupportedStub.resolves(false);

      const oldestInvoice = createMockInvoice({
        intent_id: '0x123',
        hub_invoice_enqueued_timestamp: Date.now() - 7200000 // 2 hours old
      });
      const newerInvoice = createMockInvoice({
        intent_id: '0x456',
        hub_invoice_enqueued_timestamp: Date.now() - 3600000 // 1 hour old
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

    it('should process newer invoices when prioritizeOldestInvoice is false and oldest invoice has no valid allocation', async () => {
      mockDeps.config.prioritizeOldestInvoice = false;
      isXerc20SupportedStub.resolves(false);

      const oldestInvoice = createMockInvoice({
        intent_id: '0x123',
        hub_invoice_enqueued_timestamp: Date.now() - 7200000 // 2 hours old
      });
      const newerInvoice = createMockInvoice({
        intent_id: '0x456',
        hub_invoice_enqueued_timestamp: Date.now() - 3600000 // 1 hour old
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
        chainId: '8453'
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
          chainId: '8453'
        },
        {
          intentId: '0xabc2',
          transactionHash: '0xabc2',
          chainId: '8453'
        },
        {
          intentId: '0xabc3',
          transactionHash: '0xabc3',
          chainId: '8453'
        }
      ]);

      const result = await processTickerGroup(mockContext, group, []);
      
      // Verify all purchases use the same origin
      expect(result.purchases.length).to.equal(3);
      result.purchases.forEach(purchase => {
        expect(purchase.purchase.params.origin).to.equal('8453');
      });

      // Verify the remaining balances were updated correctly for the chosen origin
      expect(result.remainingBalances.get('0xticker1')?.get('8453')).to.equal(BigInt('0'));
    });

    it('should handle getMinAmounts failure gracefully', async () => {
      isXerc20SupportedStub.resolves(false);
      mockDeps.everclear.getMinAmounts.rejects(new Error('API Error'));

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
        chainId: '8453'
      }]);

      const result = await processTickerGroup(mockContext, group, []);
      
      // Verify that the invoice was still processed with default '0' amounts
      expect(calculateSplitIntentsStub.calledOnce).to.be.true;
      expect(calculateSplitIntentsStub.firstCall.args[1]).to.deep.equal({ '8453': '0' });
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

      try {
        await processTickerGroup(mockContext, group, []);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.equal('Transaction failed');
        expect(mockDeps.prometheus.recordInvalidPurchase.calledOnce).to.be.true;
        expect(mockDeps.prometheus.recordInvalidPurchase.firstCall.args[0]).to.equal(InvalidPurchaseReasons.TransactionFailed);
      }
    });

    it('should map split intents to their respective invoices correctly', async () => {
      getMarkBalancesStub.resolves(new Map());
      getMarkGasBalancesStub.resolves(new Map());
      getCustodiedBalancesStub.resolves(new Map());
      isXerc20SupportedStub.resolves(false);
      mockDeps.cache.getAllPurchases.resolves([]);
      mockDeps.everclear.intentStatus.resolves(IntentStatus.ADDED);

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
          chainId: '8453'
        },
        {
          intentId: '0xabc2',
          transactionHash: '0xabc2',
          chainId: '8453'
        },
        {
          intentId: '0xdef',
          transactionHash: '0xdef',
          chainId: '8453'
        }
      ]);
      
      await processInvoices(mockContext, [invoice1, invoice2]);

      const expectedPurchases = [
        {
          target: invoice1,  // First two purchases target invoice1
          transactionHash: '0xabc1',
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
      expect(mockDeps.cache.addPurchases.calledOnce).to.be.true;
      expect(mockDeps.cache.addPurchases.firstCall.args[0]).to.deep.equal(expectedPurchases);
    });
  });
});
