import { expect } from 'chai';
import sinon from 'sinon';
import * as processInvoiceFns from '../../src/invoice/processInvoices';
import * as batchFns from '../../src/invoice/processInvoiceBatch';
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
    const isValidInvoiceStub = sinon.stub(processInvoiceFns, 'isValidInvoice').returns(true);

    const processInvoiceStub = sinon.stub(processInvoiceFns, 'processInvoice').resolves(true);

    const processInvoiceBatchStub = sinon.stub(batchFns, 'processInvoiceBatch').resolves(true);

    const result = await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(result).to.deep.equal({ processed: 1, failed: 0, skipped: 0 });

    expect(isValidInvoiceStub.callCount).to.equal(mockInvoices.length);

    expect(processInvoiceStub.notCalled).to.be.true;

    expect(processInvoiceBatchStub.callCount).to.equal(1);
  });

  it('should skip invalid invoices', async () => {
    sinon.stub(processInvoiceFns, 'isValidInvoice').returns(false);

    const result = await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(result).to.deep.equal({ processed: 0, failed: 0, skipped: mockInvoices.length });
  });

  it('should process individual invoices if they cannot be batched', async () => {
    sinon.stub(processInvoiceFns, 'isValidInvoice').returns(true);

    const processInvoiceStub = sinon.stub(processInvoiceFns, 'processInvoice').resolves(true);

    const processInvoiceBatchStub = sinon.stub(batchFns, 'processInvoiceBatch').resolves(true);

    const modifiedInvoices = [
      { ...mockInvoices[0], destinations: ['1'] }, // Unique destination to force individual processing
      ...mockInvoices.slice(1),
    ];

    const result = await processBatch(modifiedInvoices, mockDeps, mockConfig);

    expect(result).to.deep.equal({ processed: 2, failed: 0, skipped: 0 });

    expect(processInvoiceBatchStub.calledOnce).to.be.true;
    console.log(processInvoiceBatchStub.firstCall.args[0], 'heyyyyyyaaaa');
    expect(processInvoiceBatchStub.firstCall.args[0]).to.deep.equal([modifiedInvoices[0]]);

    expect(processInvoiceStub.calledOnce).to.be.true;
  });

  it('should log an error for failed batch processing', async () => {
    sinon.stub(processInvoiceFns, 'isValidInvoice').returns(true);

    const processInvoiceBatchStub = sinon.stub(batchFns, 'processInvoiceBatch').resolves(false);

    const result = await processBatch(mockInvoices, mockDeps, mockConfig);

    expect(result).to.deep.equal({ processed: 0, failed: 1, skipped: 0 });
  });
});
