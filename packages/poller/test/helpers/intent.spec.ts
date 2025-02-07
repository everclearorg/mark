import { stub, createStubInstance, SinonStubbedInstance } from 'sinon';
import { combineIntents, sendIntents } from '../../src/helpers/intent';
import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { Logger } from '@mark/logger';
import * as contractHelpers from '../../src/helpers/contracts';
import { GetContractReturnType, zeroAddress } from 'viem';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { expect } from '../globalTestHook';

describe('combineIntents', () => {
    let mockDeps: {
        everclear: SinonStubbedInstance<EverclearAdapter>
        chainService: SinonStubbedInstance<ChainService>
        logger: SinonStubbedInstance<Logger>
    };

    beforeEach(() => {
        mockDeps = {
            everclear: createStubInstance(EverclearAdapter),
            chainService: createStubInstance(ChainService),
            logger: createStubInstance(Logger)
        };
    });

    it('should combine intents with shared domains and assets, with an amount equaling the sum of all combined', async () => {
        const intent1: NewIntentParams = {
            origin: '1',
            destinations: ['8453'],
            to: '0xto',
            inputAsset: '0xtoken1',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
        };

        const intent2: NewIntentParams = {
            ...intent1,
            amount: '2000',
        };

        const unbatched = new Map([
            ['1', [intent1, intent2]], // Same origin and asset
        ]);

        const result = await combineIntents(unbatched, mockDeps);

        // Check structure
        expect(result.size).to.equal(1); // One origin
        const originMap = result.get('1');
        expect(originMap?.size).to.equal(1); // One asset

        // Check combined amount
        const combinedIntent = originMap?.get(intent1.inputAsset.toLowerCase());
        expect(combinedIntent?.amount).to.equal('3000'); // 1000 + 2000

        // Verify other fields are preserved
        expect(combinedIntent?.origin).to.equal(intent1.origin);
        expect(combinedIntent?.destinations).to.deep.equal(intent1.destinations);
        expect(combinedIntent?.to).to.equal(intent1.to);
        expect(combinedIntent?.callData).to.equal(intent1.callData);
        expect(combinedIntent?.maxFee).to.equal(intent1.maxFee);
    });

    it('should keep intents with different assets separate within same domain', async () => {
        const intent1: NewIntentParams = {
            origin: '1',
            destinations: ['8453'],
            to: '0xto',
            inputAsset: '0xtoken1',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
        };

        const intent2: NewIntentParams = {
            ...intent1,
            inputAsset: '0xtoken2',
            amount: '2000',
        };

        const unbatched = new Map([
            ['1', [intent1, intent2]], // Same origin, different assets
        ]);

        const result = await combineIntents(unbatched, mockDeps);

        // Check structure
        expect(result.size).to.equal(1); // One origin
        const originMap = result.get('1');
        expect(originMap?.size).to.equal(2); // Two different assets

        // Check amounts weren't combined
        expect(originMap?.get(intent1.inputAsset.toLowerCase())?.amount).to.equal('1000');
        expect(originMap?.get(intent2.inputAsset.toLowerCase())?.amount).to.equal('2000');
    });

    it('should keep intents with different domains separate', async () => {
        const intent1: NewIntentParams = {
            origin: '1',
            destinations: ['8453'],
            to: '0xto',
            inputAsset: '0xtoken1',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
        };

        const intent2: NewIntentParams = {
            ...intent1,
            origin: '8453',
            amount: '2000',
        };

        const unbatched = new Map([
            ['1', [intent1]],
            ['8453', [intent2]],
        ]);

        const result = await combineIntents(unbatched, mockDeps);

        // Check structure
        expect(result.size).to.equal(2); // Two origins
        expect(result.get('1')?.size).to.equal(1);
        expect(result.get('8453')?.size).to.equal(1);

        // Check amounts
        expect(result.get('1')?.get(intent1.inputAsset.toLowerCase())?.amount).to.equal('1000');
        expect(result.get('8453')?.get(intent2.inputAsset.toLowerCase())?.amount).to.equal('2000');
    });

    it('should handle empty input', async () => {
        const result = await combineIntents(new Map(), mockDeps);
        expect(result.size).to.equal(0);
    });

    it('should handle single intent per domain', async () => {
        const intent: NewIntentParams = {
            origin: '1',
            destinations: ['8453'],
            to: '0xto',
            inputAsset: '0xtoken1',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
        };

        const unbatched = new Map([
            ['1', [intent]],
        ]);

        const result = await combineIntents(unbatched, mockDeps);

        expect(result.size).to.equal(1);
        const originMap = result.get('1');
        expect(originMap?.size).to.equal(1);
        expect(originMap?.get(intent.inputAsset.toLowerCase())?.amount).to.equal('1000');
    });

    it('should normalize asset addresses to lowercase', async () => {
        const intent1: NewIntentParams = {
            origin: '1',
            destinations: ['8453'],
            to: '0xto',
            inputAsset: '0xTOKEN1',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
        };

        const intent2: NewIntentParams = {
            ...intent1,
            inputAsset: '0xtoken1',
            amount: '2000',
        };

        const unbatched = new Map([
            ['1', [intent1, intent2]], // Same token with different cases
        ]);

        const result = await combineIntents(unbatched, mockDeps);

        expect(result.size).to.equal(1);
        const originMap = result.get('1');
        expect(originMap?.size).to.equal(1);
        expect(originMap?.get('0xtoken1')?.amount).to.equal('3000');
    });

    it('should log debug information', async () => {
        const intent: NewIntentParams = {
            origin: '1',
            destinations: ['8453'],
            to: '0xto',
            inputAsset: '0xtoken1',
            amount: '1000',
            callData: '0x',
            maxFee: '0',
        };

        const unbatched = new Map([
            ['1', [intent]],
        ]);

        await combineIntents(unbatched, mockDeps);

        expect(mockDeps.logger.debug.calledWith('Method started')).to.be.true;
        expect(mockDeps.logger.info.calledWith('Combining intents for domain')).to.be.true;
        expect(mockDeps.logger.info.calledWith('Combined intents for domain + asset')).to.be.true;
        expect(mockDeps.logger.info.calledWith('Batched intents mapping')).to.be.true;
    });

    it('should handle error cases gracefully', async () => {
        const intent: NewIntentParams = {
            origin: '1',
            destinations: ['8453'],
            to: '0xto',
            inputAsset: '0xtoken1',
            amount: 'invalid', // Invalid amount
            callData: '0x',
            maxFee: '0',
        };

        const unbatched = new Map([
            ['1', [{ ...intent, amount: '100' }, intent]],
        ]);

        await expect(combineIntents(unbatched, mockDeps))
            .to.be.rejectedWith('combineIntents failed');

        expect(mockDeps.logger.error.called).to.be.true;
    });
});

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

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig)).to.be.rejectedWith(
          'Failed to send intents: API Error',
        );
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

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig))
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

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig))
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

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: Intent transaction failed');
    });

    it('should handle empty batches', async () => {
        const batch = new Map();
        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        const result = await sendIntents(intentsArray as NewIntentParams[], mockDeps, mockConfig);
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

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        const result = await sendIntents(intentsArray, mockDeps, mockConfig);

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

        const result = await sendIntents(
            Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values())),
            mockDeps,
            mockConfig,
        );

        expect(mockDeps.chainService.submitAndMonitor.callCount).to.equal(1); // Called only for intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1' }]);
    });
});