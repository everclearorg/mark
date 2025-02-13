import { expect } from '../globalTestHook';
import { stub, createStubInstance, SinonStubbedInstance, SinonStub } from 'sinon';
import { pollAndProcess } from '../../src/invoice/pollAndProcess';
import * as processInvoicesModule from '../../src/invoice/processInvoices';
import { MarkConfiguration, Invoice } from '@mark/core';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { MarkAdapters } from '../../src/init';
import { PurchaseCache } from '@mark/cache';
import { Wallet } from 'ethers';
import { PrometheusAdapter } from '@mark/prometheus';

describe('pollAndProcess', () => {
    let mockDeps: SinonStubbedInstance<MarkAdapters>;
    let processInvoicesStub: sinon.SinonStub;

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
            chainService: createStubInstance(ChainService),
            cache: createStubInstance(PurchaseCache),
            web3Signer: createStubInstance(Wallet),
            prometheus: createStubInstance(PrometheusAdapter),
        };

        (mockDeps.everclear.fetchInvoices as SinonStub).resolves(mockInvoices);
        processInvoicesStub = stub(processInvoicesModule, 'processInvoices').resolves();
    });

    it('should fetch and process invoices successfully', async () => {
        await pollAndProcess(mockConfig, mockDeps);

        expect((mockDeps.everclear.fetchInvoices as SinonStub).calledOnceWith(mockConfig.chains)).to.be.true;
        expect(processInvoicesStub.callCount).to.be.eq(1);
        expect(processInvoicesStub.firstCall.args[0]).contains({
            invoices: mockInvoices
        });
    });

    it('should handle fetchInvoices failure', async () => {
        const error = new Error('Fetch failed');
        (mockDeps.everclear.fetchInvoices as SinonStub).rejects(error);

        await expect(pollAndProcess(mockConfig, mockDeps))
            .to.be.rejectedWith('Fetch failed');

        expect((mockDeps.logger.error as SinonStub).calledWith('Failed to process invoices')).to.be.true;
        expect(processInvoicesStub.called).to.be.false;
    });

    it('should handle processBatch failure', async () => {
        const error = new Error('Process failed');
        processInvoicesStub.rejects(error);

        await expect(pollAndProcess(mockConfig, mockDeps))
            .to.be.rejectedWith('Process failed');

        expect((mockDeps.logger.error as SinonStub).calledWith('Failed to process invoices')).to.be.true;
    });
});
