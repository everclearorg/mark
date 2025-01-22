import { expect } from 'chai';
import { isValidInvoice, Invoice, processInvoice } from '../../src/invoice/processInvoices';
import sinon from 'sinon';
import * as balanceFns from '../../src/helpers/balance';
import * as destinationFns from '../../src/helpers/selectDestination';

describe('processInvoice', () => {
  let mockInvoice: Invoice;
  let mockDeps: any;
  let mockConfig: any;

  beforeEach(() => {
    // Initialize a mock invoice object
    mockInvoice = {
      id: 'invoice123',
      amount: 100,
      chainId: '1',
      owner: 'SomeOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

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
    const validInvoice: Invoice = {
      id: 'invoice123',
      amount: 100,
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(validInvoice);
    expect(result).to.be.true;
  });

  it('should return false if invoice is null or undefined', () => {
    const resultNull = isValidInvoice(null as any);
    const resultUndefined = isValidInvoice(undefined as any);

    expect(resultNull).to.be.false;
    expect(resultUndefined).to.be.false;
  });

  it('should return false if id is not a string', () => {
    const invalidInvoice: Partial<Invoice> = {
      id: 123 as any, // Invalid id type
      amount: 100,
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice as Invoice);
    expect(result).to.be.false;
  });

  it('should return false if amount is not a number', () => {
    const invalidInvoice: Partial<Invoice> = {
      id: 'invoice123',
      amount: '100' as any, // Invalid amount type
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice as Invoice);
    expect(result).to.be.false;
  });

  it('should return false if amount is not a valid number', () => {
    const invalidInvoice: Invoice = {
      id: 'invoice123',
      amount: 'abc' as any, // Invalid amount
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice);
    expect(result).to.be.false;
  });

  it('should return false if amount is less than or equal to 0', () => {
    const invalidInvoiceZero: Invoice = {
      id: 'invoice123',
      amount: 0, // Zero amount
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const invalidInvoiceNegative: Invoice = {
      id: 'invoice123',
      amount: -50, // Negative amount
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    expect(isValidInvoice(invalidInvoiceZero)).to.be.false;
    expect(isValidInvoice(invalidInvoiceNegative)).to.be.false;
  });

  it('should return false if owner matches "Mark wallet address"', () => {
    const invalidInvoice: Invoice = {
      id: 'invoice123',
      amount: 100,
      chainId: '1',
      owner: 'Mark wallet address', // Invalid owner
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice);
    expect(result).to.be.false;
  });
});
