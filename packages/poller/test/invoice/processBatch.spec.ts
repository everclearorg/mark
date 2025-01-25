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
  let isXerc20SupportedStub: SinonStub;
  let sendIntentsStub: SinonStub;

  const mockConfig: MarkConfiguration = {
    ownAddress: '0xmarkAddress',
    chains: {
      '1': {
        providers: ['provider1'],
        assets: [{
          address: '0xtoken1',
          tickerHash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
          decimals: 18,
          symbol: 'TEST'
        }]
      },
      '8453': {
        providers: ['provider8453'],
        assets: [{
          address: '0xtoken8453',
          tickerHash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
          decimals: 18,
          symbol: 'TEST'
        }]
      }
    },
    supportedSettlementDomains: [1, 8453],
    web3SignerUrl: '0xdifferentAddress',
    invoiceAge: 3600,
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
});
