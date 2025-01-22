import { expect } from 'chai';
import { Invoice } from '../../src/invoice/processInvoices';
import sinon from 'sinon';
import { processInvoiceBatch } from '../../src/invoice/processInvoiceBatch';
import * as destinationFns from '../../src/helpers/selectDestination';

describe('processInvoiceBatch', () => {
  let mockBatch: Invoice[];
  let mockDeps: any;
  let mockConfig: any;
  let batchKey: string;

  beforeEach(() => {
    mockBatch = [
      {
        id: 'invoice1',
        amount: 100,
        chainId: '1',
        owner: 'Owner1',
        destinations: ['2'],
        ticker_hash: '0xhash',
      },
      {
        id: 'invoice2',
        amount: 200,
        chainId: '1',
        owner: 'Owner2',
        destinations: ['2'],
        ticker_hash: '0xhash',
      },
    ];

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

    mockConfig = {
      ownAddress: '0xYourAddress',
      chains: {
        '1': { providers: ['https://mainnet.infura.io/v3/test'] },
        '2': { providers: ['https://ropsten.infura.io/v3/test'] },
      },
    };

    batchKey = 'batch123';
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should process a batch successfully', async () => {
    sinon.stub(destinationFns, 'findBestDestination').resolves(3);
    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');

    mockDeps.everclear.createNewIntent.resolves({
      chainId: '1',
      data: '0xTransactionData',
    });

    mockDeps.txService.submitAndMonitor.resolves('0xTransactionHash');

    const result = await processInvoiceBatch(mockBatch, mockDeps, mockConfig, batchKey, getTokenAddressMock);

    expect(result).to.be.true;
    expect(
      mockDeps.logger.info.calledOnceWith('Batch processed successfully', {
        batchKey,
        txHash: '0xTransactionHash',
      }),
    ).to.be.true;

    expect(getTokenAddressMock.calledOnceWith(mockBatch[0].ticker_hash, mockBatch[0].destinations[0])).to.be.true;
    expect(mockDeps.everclear.createNewIntent.calledOnce).to.be.true;
    expect(mockDeps.txService.submitAndMonitor.calledOnce).to.be.true;
  });

  it('should return false if the batch is empty', async () => {
    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');
    const result = await processInvoiceBatch([], mockDeps, mockConfig, batchKey, getTokenAddressMock);

    expect(result).to.be.false;
    expect(mockDeps.logger.error.calledOnceWith('Batch is empty or invalid', { batchKey })).to.be.true;
  });

  it('should throw an error if batch amount is 0', async () => {
    mockBatch[0].amount = 0;
    mockBatch[1].amount = 0;

    sinon.stub(destinationFns, 'findBestDestination').resolves(3);
    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');

    const result = await processInvoiceBatch(mockBatch, mockDeps, mockConfig, batchKey, getTokenAddressMock);

    expect(result).to.be.false;
    expect(mockDeps.logger.error.calledOnce).to.be.true;
    expect(mockDeps.logger.error.firstCall.args[0]).to.equal('Failed to process batch');
    expect(mockDeps.logger.error.firstCall.args[1].error).to.include(`Batch amount is 0 for batchKey: ${batchKey}`);
  });

  it('should return false if findBestDestination fails', async () => {
    sinon.stub(destinationFns, 'findBestDestination').rejects(new Error('Destination error'));

    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');

    const result = await processInvoiceBatch(mockBatch, mockDeps, mockConfig, batchKey, getTokenAddressMock);

    expect(result).to.be.false;
    expect(
      mockDeps.logger.error.calledOnceWith('Failed to process batch', sinon.match.has('error', 'Destination error')),
    ).to.be.true;
  });

  it('should return false if createNewIntent fails', async () => {
    sinon.stub(destinationFns, 'findBestDestination').resolves(3);

    mockDeps.everclear.createNewIntent.rejects(new Error('Intent error'));
    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');

    const result = await processInvoiceBatch(mockBatch, mockDeps, mockConfig, batchKey, getTokenAddressMock);

    expect(result).to.be.false;
    expect(mockDeps.logger.error.calledOnceWith('Failed to process batch', sinon.match.has('error', 'Intent error'))).to
      .be.true;
  });

  it('should return false if submitAndMonitor fails', async () => {
    sinon.stub(destinationFns, 'findBestDestination').resolves(3);

    mockDeps.everclear.createNewIntent.resolves({
      chainId: '1',
      data: '0xTransactionData',
    });
    mockDeps.txService.submitAndMonitor.rejects(new Error('Transaction error'));

    const getTokenAddressMock = sinon.stub().resolves('0xTokenAddress');
    const result = await processInvoiceBatch(mockBatch, mockDeps, mockConfig, batchKey, getTokenAddressMock);

    expect(result).to.be.false;
    expect(
      mockDeps.logger.error.calledOnceWith('Failed to process batch', sinon.match.has('error', 'Transaction error')),
    ).to.be.true;
  });
});
