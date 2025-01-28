import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance } from 'sinon';
import { Invoice } from '@mark/everclear';
import { pollAndProcess } from '../../src/invoice/pollAndProcess';
import * as processBatchModule from '../../src/invoice/processBatch';
import { MarkConfiguration } from '@mark/core';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';

describe('pollAndProcess', () => {
    let mockDeps: {
        logger: SinonStubbedInstance<Logger>;
        everclear: SinonStubbedInstance<EverclearAdapter>;
        chainService: SinonStubbedInstance<ChainService>;
    };
    let processBatchStub: sinon.SinonStub;

    const mockConfig: MarkConfiguration = {
        chains: {
            '1': { providers: ['provider1'] },
            '8453': { providers: ['provider8453'] }
        },
        supportedSettlementDomains: [1, 8453],
        web3SignerUrl: 'http://localhost:8545',
        everclearApiUrl: 'http://localhost:3000',
        ownAddress: '0xmarkAddress',
        invoiceAge: 3600,
        logLevel: 'info',
        pollingInterval: 60000,
        maxRetries: 3,
        retryDelay: 1000
    } as unknown as MarkConfiguration;

    const mockInvoices: Invoice[] = [{
        intent_id: '0x123',
        amount: '1000',
        origin: '1',
        destinations: ['8453']
    } as Invoice];

    beforeEach(() => {
        mockDeps = {
            logger: createStubInstance(Logger),
            everclear: createStubInstance(EverclearAdapter),
            chainService: createStubInstance(ChainService)
        };

        mockDeps.everclear.fetchInvoices.resolves(mockInvoices);
        processBatchStub = stub(processBatchModule, 'processBatch').resolves();
    });

    it('should fetch and process invoices successfully', async () => {
        await pollAndProcess(mockConfig, mockDeps);

        expect(mockDeps.everclear.fetchInvoices.calledOnceWith(mockConfig.chains)).to.be.true;
        expect(processBatchStub.calledOnceWith(mockInvoices, mockDeps, mockConfig)).to.be.true;
    });

    it('should handle fetchInvoices failure', async () => {
        const error = new Error('Fetch failed');
        mockDeps.everclear.fetchInvoices.rejects(error);

        await expect(pollAndProcess(mockConfig, mockDeps))
            .to.be.rejectedWith('Fetch failed');

        expect(mockDeps.logger.error.calledWith('Failed to process invoices')).to.be.true;
        expect(processBatchStub.called).to.be.false;
    });

    it('should handle processBatch failure', async () => {
        const error = new Error('Process failed');
        processBatchStub.rejects(error);

        await expect(pollAndProcess(mockConfig, mockDeps))
            .to.be.rejectedWith('Process failed');

        expect(mockDeps.logger.error.calledWith('Failed to process invoices')).to.be.true;
    });
});
