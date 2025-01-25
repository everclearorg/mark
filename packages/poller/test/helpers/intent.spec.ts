import { stub, createStubInstance, SinonStubbedInstance } from 'sinon';
import { sendIntents } from '../../src/helpers/intent';
import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { Logger } from '@mark/logger';
import * as contractHelpers from '../../src/helpers/contracts';
import { GetContractReturnType, zeroAddress } from 'viem';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { expect } from '../globalTestHook';

describe('combineIntents', () => { });

describe('sendIntents', () => {
    let mockDeps: {
        everclear: SinonStubbedInstance<EverclearAdapter>
        chainService: SinonStubbedInstance<ChainService>
        logger: SinonStubbedInstance<Logger>
    };

    const mockConfig = {
        ownAddress: '0xmarkAddress',
        chains: {
            '1': { providers: ['provider1'] },
        },
    } as unknown as MarkConfiguration;

    const mockIntent: NewIntentParams = {
        origin: '1',
        destinations: ['8453'],
        to: '0xto',
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
    };

    beforeEach(() => {
        mockDeps = {
            everclear: createStubInstance(EverclearAdapter, {
                createNewIntent: stub()
            }),
            chainService: createStubInstance(ChainService, {
                submitAndMonitor: stub()
            }),
            logger: createStubInstance(Logger)
        }
    });

    it('should fail if everclear.createNewIntent fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        mockDeps.everclear.createNewIntent.rejects(new Error('API Error'));

        await expect(sendIntents(batch, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: API Error');
    });

    it('should fail if getting allowance fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        mockDeps.everclear.createNewIntent.resolves({
            to: zeroAddress,
            data: '0xdata',
            chainId: 1,
        });

        const mockTokenContract = {
            address: '0xtoken1',
            read: {
                allowance: stub().rejects(new Error('Allowance check failed')),
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;

        await expect(sendIntents(batch, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: Allowance check failed');
    });

    it('should fail if sending approval transaction fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        mockDeps.everclear.createNewIntent.resolves({
            to: zeroAddress,
            data: '0xdata',
            chainId: 1,
        });

        const mockTokenContract = {
            address: '0xtoken1',
            read: {
                allowance: stub().resolves(BigInt(0)), // Zero allowance to trigger approval
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;
        mockDeps.chainService.submitAndMonitor.rejects(new Error('Approval failed'));

        await expect(sendIntents(batch, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: Approval failed');
    });

    it('should fail if sending intent transaction fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        mockDeps.everclear.createNewIntent.resolves({
            to: zeroAddress,
            data: '0xdata',
            chainId: 1,
        });

        const mockTokenContract = {
            address: '0xtoken1',
            read: {
                allowance: stub().resolves(BigInt(2000)), // Sufficient allowance
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;
        mockDeps.chainService.submitAndMonitor.rejects(new Error('Intent transaction failed'));

        await expect(sendIntents(batch, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: Intent transaction failed');
    });

    it('should handle empty batches', async () => {
        const batch = new Map();
        const result = await sendIntents(batch, mockDeps, mockConfig);
        expect(result).to.deep.equal([]);
        expect(mockDeps.everclear.createNewIntent.called).to.be.false;
    });

    it('should handle cases where there is not sufficient allowance', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        mockDeps.everclear.createNewIntent.resolves({
            to: zeroAddress,
            data: '0xdata',
            chainId: 1,
        });

        const mockTokenContract = {
            address: '0xtoken1',
            read: {
                allowance: stub().resolves(BigInt(500)), // Less than required
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;
        mockDeps.chainService.submitAndMonitor
            .onFirstCall().resolves('0xapprovalTx')
            .onSecondCall().resolves('0xintentTx');

        const result = await sendIntents(batch, mockDeps, mockConfig);

        expect(mockDeps.chainService.submitAndMonitor.callCount).to.equal(2); // Called for both approval and intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1' }]);
    });

    it('should handle cases where there is sufficient allowance', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        mockDeps.everclear.createNewIntent.resolves({
            to: zeroAddress,
            data: '0xdata',
            chainId: 1,
        });

        const mockTokenContract = {
            address: '0xtoken1',
            read: {
                allowance: stub().resolves(BigInt(2000)), // More than required
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);
        mockDeps.chainService.submitAndMonitor.resolves('0xintentTx');

        const result = await sendIntents(batch, mockDeps, mockConfig);

        expect(mockDeps.chainService.submitAndMonitor.callCount).to.equal(1); // Called only for intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1' }]);
    });
});