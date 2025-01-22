import { expect } from 'chai';
import { isValidInvoice, processInvoice } from '../../src/invoice/processInvoices';
import { Invoice } from '@mark/everclear';
import { MarkConfiguration } from '@mark/core';
import sinon from 'sinon';
import * as balanceFns from '../../src/helpers/balance';
import * as destinationFns from '../../src/helpers/selectDestination';

const validInvoice = {
  intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
  owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
  entry_epoch: 186595,
  amount: '4506224658731513369685',
  discountBps: 1.2,
  origin: '1',
  destinations: ['8453'],
  hub_status: 'INVOICED',
  ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
  hub_invoice_enqueued_timestamp: 1737491219,
};

const validConfig = {
  signer: '0xMark',
  supportedSettlementDomains: [8453],
} as MarkConfiguration;

describe('processInvoice', () => {
  let mockInvoice: Invoice;
  let mockDeps: any;
  let mockConfig: any;

  beforeEach(() => {
    // Initialize a mock invoice object
    mockInvoice = { ...validInvoice };

    // Initialize mock dependencies with stubs
    mockDeps = {
      everclear: {
        createNewIntent: sinon.stub(),
      },
      txService: {
        submitAndMonitor: sinon.stub(),
      },
      logger: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
    };

    // Initialize a mock configuration object
    mockConfig = {
      ownAddress: '0xYourAddress',
      chains: {
        '1': { providers: ['https://mainnet.infura.io/v3/test'] },
        '2': { providers: ['https://ropsten.infura.io/v3/test'] },
        '3': { providers: ['https://kovan.infura.io/v3/test'] },
      },
    };
  });

  afterEach(() => {
    // Restore the default sandbox here
    sinon.restore();
  });

  it('should process the invoice successfully', async () => {
    const markHighestLiquidityBalanceStub = sinon.stub(balanceFns, 'markHighestLiquidityBalance').resolves(2);
    const findBestDestinationStub = sinon.stub(destinationFns, 'findBestDestination').resolves(3);
    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');

    mockDeps.everclear.createNewIntent.resolves({
      chainId: '1',
      data: '0xTransactionData',
    });

    mockDeps.txService.submitAndMonitor.resolves('0xTransactionHash');

    const result = await processInvoice(mockInvoice, mockDeps, mockConfig, getTokenAddressMock);

    expect(result).to.be.true;

    expect(
      markHighestLiquidityBalanceStub.calledOnceWith(
        mockInvoice.ticker_hash,
        mockInvoice.destinations,
        mockConfig,
        getTokenAddressMock,
      ),
    ).to.be.true;

    expect(findBestDestinationStub.calledOnceWith('2', mockInvoice.ticker_hash, mockConfig)).to.be.true;

    expect(mockDeps.everclear.createNewIntent.calledOnce).to.be.true;

    expect(mockDeps.txService.submitAndMonitor.calledOnce).to.be.true;

    expect(
      mockDeps.logger.info.calledOnceWith('Invoice processed successfully', {
        invoiceId: mockInvoice.id,
        txHash: '0xTransactionHash',
      }),
    ).to.be.true;
  });

  it('should log an error and return false if processing fails', async () => {
    const markHighestLiquidityBalanceStub = sinon.stub().rejects(new Error('Liquidity balance error'));
    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');

    const result = await processInvoice(mockInvoice, mockDeps, mockConfig, getTokenAddressMock);

    expect(result).to.be.false;
    expect(
      mockDeps.logger.error.calledOnceWith('Failed to process invoice', {
        invoiceId: mockInvoice.id,
        error: sinon.match.instanceOf(Error),
      }),
    ).to.be.true;
  });
});

describe('isValidInvoice', () => {
  it('should return true for a valid invoice', () => {
    const result = isValidInvoice(validInvoice, validConfig);
    expect(result).to.be.true;
  });

  it('should return false if invoice is null or undefined', () => {
    const resultNull = isValidInvoice(null as any, validConfig);
    const resultUndefined = isValidInvoice(undefined as any, validConfig);

    expect(resultNull).to.be.false;
    expect(resultUndefined).to.be.false;
  });

  it('should return false if id is not a string', () => {
    const { intent_id, ...res } = validInvoice;
    const invalidInvoice: Partial<Invoice> = {
      intent_id: 123 as any, // Invalid id type
      ...res,
    };

    const result = isValidInvoice(invalidInvoice as Invoice, validConfig);
    expect(result).to.be.false;
  });

  it('should return false if amount is not a number', () => {
    const { amount, ...res } = validInvoice;
    const invalidInvoice: Partial<Invoice> = {
      amount: 'abc',
      ...res,
    };

    const result = isValidInvoice(invalidInvoice as Invoice, validConfig);
    expect(result).to.be.false;
  });

  it('should return false if amount is less than or equal to 0', () => {
    const { amount, ...res } = validInvoice;
    const invalidInvoiceZero: Invoice = {
      amount: '0',
      ...res,
    };

    const invalidInvoiceNegative: Invoice = {
      amount: '-50',
      ...res,
    };

    expect(isValidInvoice(invalidInvoiceZero, validConfig)).to.be.false;
    expect(isValidInvoice(invalidInvoiceNegative, validConfig)).to.be.false;
  });

  it('should return false if owner matches "Mark wallet address"', () => {
    const { owner, ...res } = validInvoice;
    const invalidInvoice: Invoice = {
      owner: 'Mark wallet address', // Invalid owner
      ...res,
    };

    const result = isValidInvoice(invalidInvoice, validConfig);
    expect(result).to.be.false;
  });
});
