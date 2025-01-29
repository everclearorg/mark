import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import { Invoice } from '@mark/everclear';
import { processBatch } from '../../src/invoice/processBatch';
import * as balanceHelpers from '../../src/helpers/balance';
import * as intentHelpers from '../../src/helpers/intent';
import * as assetHelpers from '../../src/helpers/asset';
import { MarkConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';

describe('processBatch', () => {
  // const mockInvoices: Invoice[] = [
  //   {
  //     intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
  //     owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
  //     entry_epoch: 186595,
  //     amount: '1506224658731513369685',
  //     discountBps: 1.2,
  //     origin: '1',
  //     destinations: ['8453'],
  //     hub_status: 'INVOICED',
  //     ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
  //     hub_invoice_enqueued_timestamp: 1737491219,
  //   },
  //   {
  //     intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
  //     owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
  //     entry_epoch: 186595,
  //     amount: '1706224658731513369685',
  //     discountBps: 1.2,
  //     origin: '1',
  //     destinations: ['8453'],
  //     hub_status: 'INVOICED',
  //     ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
  //     hub_invoice_enqueued_timestamp: 1737491219,
  //   },
  // ];
  const mockInvoices: Invoice[] = [
    {
      intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
      owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
      entry_epoch: 186595,
      amount: '1506224658731513369685',
      discountBps: 1.2,
      origin: '1',
      destinations: ['8453'],
      hub_status: 'INVOICED',
      ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
      hub_invoice_enqueued_timestamp: 1737491219,
    }
  ];

  let mockDeps: {
    logger: SinonStubbedInstance<Logger>;
    everclear: SinonStubbedInstance<EverclearAdapter>;
    chainService: SinonStubbedInstance<ChainService>;
  };

  let custodiedBalanceStub: SinonStub;
  let markBalanceStub: SinonStub;
  let mockGasStub: SinonStub;
  let isXerc20SupportedStub: SinonStub;
  let sendIntentsStub: SinonStub;

  const mockConfig: MarkConfiguration = {
    ownAddress: '0xmarkAddress',
    chains: {
      '1': {
        invoiceAge: 3600,
        gasThreshold: '0',
        providers: ['provider1'],
        assets: [{
          address: '0xtoken1',
          tickerHash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
          decimals: 18,
          symbol: 'TEST',
          balanceThreshold: '0',
          isNative: false
        }]
      },
      '8453': {
        invoiceAge: 3600,
        gasThreshold: '0',
        providers: ['provider8453'],
        assets: [{
          address: '0xtoken8453',
          tickerHash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
          decimals: 18,
          symbol: 'TEST',
          balanceThreshold: '0',
          isNative: false
        }]
      }
    },
    supportedSettlementDomains: [1, 8453],
    web3SignerUrl: '0xdifferentAddress',
  } as unknown as MarkConfiguration;

  beforeEach(() => {
    mockDeps = {
      logger: createStubInstance(Logger),
      everclear: createStubInstance(EverclearAdapter),
      chainService: createStubInstance(ChainService),
    };

    // Mock balances with sufficient amount
    const mockBalances = new Map();
    mockBalances.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt(mockInvoices[0].amount)] // More than invoice amount
    ]));
    markBalanceStub = stub(balanceHelpers, 'getMarkBalances').resolves(mockBalances);

    // Mock gas with sufficient amount
    const mockgas = new Map();
    Object.keys(mockConfig.chains).map(chain => mockgas.set(chain, BigInt('100000000000000000000'))) // 100 ether
    mockGasStub = stub(balanceHelpers, 'getMarkGasBalances').resolves(mockgas);

    // Mock empty custodied amounts
    const mockCustodied = new Map();
    mockCustodied.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt(0)]
    ]));
    custodiedBalanceStub = stub(balanceHelpers, 'getCustodiedBalances').resolves(mockCustodied);

    isXerc20SupportedStub = stub(assetHelpers, 'isXerc20Supported').resolves(false);

    sendIntentsStub = stub(intentHelpers, 'sendIntents').resolves([{ transactionHash: '0xtx', chainId: '8453' }]);
  });

  it('should process valid invoice when sufficient balance exists', async () => {
    await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(mockDeps.logger.info.calledWith('Sent transactions to purchase invoices')).to.be.true;
  });

  it('should skip invoice when sufficient custodied balance exists', async () => {
    // Mock sufficient custodied amounts
    const mockCustodied = new Map();
    mockCustodied.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('2000000000000000000000')] // More than invoice amount
    ]));
    custodiedBalanceStub.resolves(mockCustodied);

    await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(mockDeps.logger.info.calledWith('Sufficient custodied balance to settle invoice')).to.be.true;
    expect(sendIntentsStub.called).to.be.false;
  });

  it('should skip invoice when XERC20 is supported', async () => {
    // Mock XERC20 check to return true
    isXerc20SupportedStub.resolves(true);

    await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(mockDeps.logger.info.calledWith('XERC20 supported for ticker on valid destination')).to.be.true;
    expect(sendIntentsStub.called).to.be.false;
  });

  it('should handle multiple invoices correctly', async () => {
    const multipleInvoices = [
      mockInvoices[0],
      {
        ...mockInvoices[0],
        intent_id: '0xdifferent',
        amount: '1000000000000000000' // 1 token
      }
    ];

    // Mock balances with sufficient amount for both
    const mockBalances = new Map();
    mockBalances.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('3000000000000000000000')] // Enough for both invoices
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch(multipleInvoices, mockDeps, mockConfig);
    expect(sendIntentsStub.called).to.be.true;
  });

  it('should handle insufficient balance for required deposit', async () => {
    // Mock insufficient balances
    const mockBalances = new Map();
    mockBalances.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('100')] // Very small balance
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(mockDeps.logger.debug.calledWith('Insufficient balance to support destination')).to.be.true;
    expect(sendIntentsStub.called).to.be.false;
  });

  it('should throw error when token address is not found', async () => {
    // Modify config to make token address lookup fail
    const badConfig = {
      ...mockConfig,
      chains: {
        ...mockConfig.chains,
        '8453': {
          ...mockConfig.chains['8453'],
          assets: [
            {
              address: undefined,
              tickerHash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
              decimals: 18,
              symbol: 'TEST'
            }
          ]
        }
      }
    };

    await expect(processBatch(mockInvoices, mockDeps, badConfig as any))
      .to.be.rejectedWith('No input asset found for ticker');
  });

  it('should correctly apply discount BPS to invoice amount', async () => {
    const invoiceWithDiscount = {
      ...mockInvoices[0],
      amount: '2000000000000000000', // 2 tokens
      discountBps: 50 // 0.5% discount
    };

    await processBatch([invoiceWithDiscount], mockDeps, mockConfig);

    // With 0.5% discount on 2 tokens, the purchase amount should be 1.99 tokens
    // The discount calculation is: amount * (1 - (discountBps * 10000) / (10000 * 10000))
    expect(sendIntentsStub.called).to.be.true;
    const sentIntents = sendIntentsStub.firstCall.args[0];
    const intentAmount = sentIntents.get('8453')?.get('0xtoken8453')?.amount;
    expect(intentAmount).to.equal('1990000000000000000'); // 1.99 tokens
  });

  it('should try multiple destinations until finding one with sufficient balance', async () => {
    const multiDestInvoice = {
      ...mockInvoices[0],
      destinations: ['8453', '1'], // Try 8453 first, then 1
      amount: '1000000000000000000', // 1 token
      discountBps: 0 // No discount to keep math simple
    };

    // Set up balances where first destination has insufficient balance
    const mockBalances = new Map();
    mockBalances.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('100')], // Insufficient for first destination
      ['1', BigInt('2000000000000000000')] // Sufficient for second destination
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch([multiDestInvoice], mockDeps, mockConfig);

    expect(sendIntentsStub.called).to.be.true;
    const sentIntents = sendIntentsStub.firstCall.args[0];
    expect(sentIntents.has('1')).to.be.true; // Should use the second destination
    expect(sentIntents.has('8453')).to.be.false; // Should skip the first destination
  });

  it('should correctly update balances after processing each invoice', async () => {
    const multipleInvoices = [
      {
        ...mockInvoices[0],
        amount: '1000000000000000000', // 1 token
        discountBps: 0 // No discount to keep math simple
      },
      {
        ...mockInvoices[0],
        intent_id: '0x456',
        amount: '500000000000000000', // 0.5 tokens
        discountBps: 0 // No discount to keep math simple
      }
    ];

    // Set up initial balance of 2 tokens
    const mockBalances = new Map();
    mockBalances.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('2000000000000000000')]
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch(multipleInvoices, mockDeps, mockConfig);

    expect(sendIntentsStub.called).to.be.true;
    // Should process both invoices since total amount (1.5 tokens) is less than balance (2 tokens)
    const sentIntents = sendIntentsStub.firstCall.args[0];
    const combinedAmount = sentIntents.get('8453')?.get(mockConfig.chains['8453'].assets[0].address.toLowerCase())?.amount;
    expect(combinedAmount).to.equal('1500000000000000000'); // 1.5 tokens
  });

  it('should correctly handle partial custodied amounts', async () => {
    const invoice = {
      ...mockInvoices[0],
      amount: '2000000000000000000', // 2 tokens
      discountBps: 0 // No discount to keep math simple
    };

    // Set up partial custodied amount (1 token)
    const mockCustodied = new Map();
    mockCustodied.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('1000000000000000000')]
    ]));
    custodiedBalanceStub.resolves(mockCustodied);

    // Set up sufficient balance for the remainder
    const mockBalances = new Map();
    mockBalances.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('2000000000000000000')]
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch([invoice], mockDeps, mockConfig);

    expect(sendIntentsStub.called).to.be.true;
    const sentIntents = sendIntentsStub.firstCall.args[0];
    const intentAmount = sentIntents.get('8453')?.get(mockConfig.chains['8453'].assets[0].address.toLowerCase())?.amount;
    expect(intentAmount).to.equal('1000000000000000000');
  });

  it('should handle case when all destinations have insufficient balance', async () => {
    const multiDestInvoice = {
      ...mockInvoices[0],
      destinations: ['8453', '1']
    };

    // Set up insufficient balances for all destinations
    const mockBalances = new Map();
    mockBalances.set(mockInvoices[0].ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('100')],
      ['1', BigInt('100')]
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch([multiDestInvoice], mockDeps, mockConfig);

    expect(sendIntentsStub.called).to.be.false;
    expect(mockDeps.logger.info.calledWith('No intents to purchase')).to.be.true;
  });

  it('should handle undefined custodied map for ticker', async () => {
    const invoice = {
      ...mockInvoices[0],
      ticker_hash: '0xnonexistentticker',
      amount: '1000000000000000000', // 1 token
      discountBps: 0 // No discount to keep math simple
    };

    // Set up empty custodied map
    custodiedBalanceStub.resolves(new Map());

    // Set up sufficient balance
    const mockBalances = new Map();
    mockBalances.set(invoice.ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('2000000000000000000')]
    ]));
    markBalanceStub.resolves(mockBalances);

    // Update config to include the new ticker
    const configWithNewTicker = {
      ...mockConfig,
      chains: {
        ...mockConfig.chains,
        '8453': {
          ...mockConfig.chains['8453'],
          assets: [{
            ...mockConfig.chains['8453'].assets[0],
            tickerHash: invoice.ticker_hash
          }]
        }
      }
    };

    await processBatch([invoice], mockDeps, configWithNewTicker as any);

    expect(sendIntentsStub.called).to.be.true;
    // Should treat undefined custodied amount as 0
    const sentIntents = sendIntentsStub.firstCall.args[0];
    const intentAmount = sentIntents.get('8453')?.get(mockConfig.chains['8453'].assets[0].address.toLowerCase())?.amount;
    expect(intentAmount).to.equal('1000000000000000000');
  });

  it('should handle undefined balance map for ticker', async () => {
    const invoice = {
      ...mockInvoices[0],
      ticker_hash: '0xnonexistentticker',
      amount: '1000000000000000000', // 1 token
      discountBps: 0 // No discount to keep math simple
    };

    // Set up empty balance map
    markBalanceStub.resolves(new Map());

    // Set up empty custodied map
    custodiedBalanceStub.resolves(new Map());

    // Update config to include the new ticker
    const configWithNewTicker = {
      ...mockConfig,
      chains: {
        ...mockConfig.chains,
        '8453': {
          ...mockConfig.chains['8453'],
          assets: [{
            ...mockConfig.chains['8453'].assets[0],
            tickerHash: invoice.ticker_hash
          }]
        }
      }
    };

    await processBatch([invoice], mockDeps, configWithNewTicker as any);

    expect(sendIntentsStub.called).to.be.false;
    expect(mockDeps.logger.debug.calledWith('Insufficient balance to support destination')).to.be.true;
  });

  it('should handle undefined custodied chain map', async () => {
    const invoice = {
      ...mockInvoices[0],
      amount: '1000000000000000000', // 1 token
      discountBps: 0 // No discount to keep math simple
    };

    // Set up custodied map with no chain map
    const mockCustodied = new Map();
    mockCustodied.set(invoice.ticker_hash.toLowerCase(), new Map());
    custodiedBalanceStub.resolves(mockCustodied);

    // Set up sufficient balance
    const mockBalances = new Map();
    mockBalances.set(invoice.ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('2000000000000000000')]
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch([invoice], mockDeps, mockConfig);

    expect(sendIntentsStub.called).to.be.true;
    // Should treat undefined custodied amount as 0
    const sentIntents = sendIntentsStub.firstCall.args[0];
    const intentAmount = sentIntents.get('8453')?.get(mockConfig.chains['8453'].assets[0].address.toLowerCase())?.amount;
    expect(intentAmount).to.equal('1000000000000000000');
  });

  it('should handle errors in getMarkBalances', async () => {
    markBalanceStub.rejects(new Error('Failed to get balances'));
    await expect(processBatch(mockInvoices, mockDeps, mockConfig))
      .to.be.rejectedWith('Failed to get balances');
  });

  it('should handle errors in getCustodiedBalances', async () => {
    custodiedBalanceStub.rejects(new Error('Failed to get custodied balances'));
    await expect(processBatch(mockInvoices, mockDeps, mockConfig))
      .to.be.rejectedWith('Failed to get custodied balances');
  });

  it('should handle errors in isXerc20Supported', async () => {
    isXerc20SupportedStub.rejects(new Error('Failed to check XERC20 support'));
    await expect(processBatch(mockInvoices, mockDeps, mockConfig))
      .to.be.rejectedWith('Failed to check XERC20 support');
  });

  it('should handle errors in combineIntents', async () => {
    // Set up a valid invoice that will get to the combineIntents call
    const invoice = {
      ...mockInvoices[0],
      amount: '1000000000000000000',
      discountBps: 0
    };

    // Set up sufficient balance
    const mockBalances = new Map();
    mockBalances.set(invoice.ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('2000000000000000000')]
    ]));
    markBalanceStub.resolves(mockBalances);

    // Make combineIntents fail
    stub(intentHelpers, 'combineIntents').rejects(new Error('Failed to combine intents'));

    await expect(processBatch([invoice], mockDeps, mockConfig))
      .to.be.rejectedWith('Failed to combine intents');
  });

  it('should initialize unbatched intents map for new destination', async () => {
    const invoice = {
      ...mockInvoices[0],
      amount: '1000000000000000000', // 1 token
      discountBps: 0 // No discount to keep math simple
    };

    // Set up sufficient balance
    const mockBalances = new Map();
    mockBalances.set(invoice.ticker_hash.toLowerCase(), new Map([
      ['8453', BigInt('2000000000000000000')]
    ]));
    markBalanceStub.resolves(mockBalances);

    await processBatch([invoice], mockDeps, mockConfig);

    expect(sendIntentsStub.called).to.be.true;
    const sentIntents = sendIntentsStub.firstCall.args[0];
    // Verify that a new map was initialized for the destination
    expect(sentIntents.has('8453')).to.be.true;
    const intentAmount = sentIntents.get('8453')?.get(mockConfig.chains['8453'].assets[0].address.toLowerCase())?.amount;
    expect(intentAmount).to.equal('1000000000000000000');
  });
});
