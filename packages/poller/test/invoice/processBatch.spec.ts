import { expect } from 'chai';
import sinon from 'sinon';
import * as validationFns from '../../src/invoice/validation';
import * as batchFns from '../../src/invoice/processBatch';
import { processBatch } from '../../src/invoice/processBatch';

describe('processBatch', () => {
  const mockInvoices: any = [
    {
      id: '1',
      amount: 100,
      chainId: '1',
      owner: 'Owner1',
      destinations: ['2'],
      ticker_hash: '0xhash',
    },
    {
      id: '3',
      amount: 50,
      chainId: '1',
      owner: 'Owner3',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    },
  ];

  const mockDeps: any = {
    logger: {
      info: sinon.stub(),
      error: sinon.stub(),
    },
  };

  const mockConfig: any = {
    ownAddress: '0xOwnAddress',
    chains: {
      '1': {},
      '2': {},
      '3': {},
    },
  };
  afterEach(() => {
    sinon.restore();
  });

  it('should process valid invoices in batches successfully', async () => {
    const isValidInvoiceStub = sinon.stub(validationFns, 'isValidInvoice').returns(true);

    const processInvoiceBatchStub = sinon.stub(batchFns, 'processBatch').resolves();

    const result = await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(result).to.deep.equal({ processed: 1, failed: 0, skipped: 0 });

    expect(isValidInvoiceStub.callCount).to.equal(mockInvoices.length);

    expect(processInvoiceBatchStub.callCount).to.equal(1);
  });

  it('should skip invalid invoices', async () => {
    sinon.stub(validationFns, 'isValidInvoice').returns(false);

    const result = await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(result).to.deep.equal({ processed: 0, failed: 0, skipped: mockInvoices.length });
  });
});
