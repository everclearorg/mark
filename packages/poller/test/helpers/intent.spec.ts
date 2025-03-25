import { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore as sinonRestore } from 'sinon';
import {
    INTENT_ADDED_TOPIC0,
    ORDER_CREATED_TOPIC0,
    sendIntents,
    sendIntentsMulticall
} from '../../src/helpers/intent';
import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { Logger } from '@mark/logger';
import * as contractHelpers from '../../src/helpers/contracts';
import * as permit2Helpers from '../../src/helpers/permit2';
import { GetContractReturnType, zeroAddress } from 'viem';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { expect } from '../globalTestHook';
import { MarkAdapters } from '../../src/init';
import { BigNumber, Wallet } from 'ethers';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';

// Common test constants for transaction logs
const INTENT_ADDED_TOPIC = '0x5c5c7ce44a0165f76ea4e0a89f0f7ac5cce7b2c1d1b91d0f49c1f219656b7d8c';
const INTENT_ADDED_LOG_DATA = '0x00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000';

const createMockTransactionReceipt = (transactionHash: string, intentId: string, eventType: 'intent' | 'order' = 'intent') => ({
    transactionHash,
    cumulativeGasUsed: BigNumber.from('100'),
    effectiveGasPrice: BigNumber.from('1'),
    logs: [{
        topics: eventType === 'intent' ? [
            INTENT_ADDED_TOPIC,
            intentId,
            '0x0000000000000000000000000000000000000000000000000000000000000002'
        ] : [
            ORDER_CREATED_TOPIC0,
            intentId,
            '0x0000000000000000000000000000000000000000000000000000000000000002'
        ],
        data: eventType === 'intent' ? INTENT_ADDED_LOG_DATA : '0x00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000'
    }]
});

describe('sendIntents', () => {
    let mockDeps: SinonStubbedInstance<MarkAdapters>;
    let getERC20ContractStub: SinonStub;

    const invoiceId = '0xmockinvoice';

    const mockConfig = {
        ownAddress: '0xdeadbeef1234567890deadbeef1234567890dead',
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
                createNewIntent: stub(),
                getMinAmounts: stub(),
            }),
            chainService: createStubInstance(ChainService, {
                submitAndMonitor: stub()
            }),
            logger: createStubInstance(Logger),
            web3Signer: createStubInstance(Wallet, {
                _signTypedData: stub()
            }),
            cache: createStubInstance(PurchaseCache),
            prometheus: createStubInstance(PrometheusAdapter),
        };

        getERC20ContractStub = stub(contractHelpers, 'getERC20Contract');
    });

    afterEach(() => {
        sinonRestore();
    });

    it('should fail if everclear.createNewIntent fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).rejects(new Error('API Error'));

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig)).to.be.rejectedWith(
            'API Error',
        );
    });

    it('should fail if getting allowance fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
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

        getERC20ContractStub.resolves(mockTokenContract as any);

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
            minAmounts: {
                [intentsArray[0].origin]: intentsArray[0].amount
            }
        });

        await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig))
            .to.be.rejectedWith('Allowance check failed');
    });

    it('should fail if sending approval transaction fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
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

        getERC20ContractStub.resolves(mockTokenContract as any);
        (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(new Error('Approval failed'));

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
            minAmounts: {
                [intentsArray[0].origin]: intentsArray[0].amount
            }
        });

        await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig))
            .to.be.rejectedWith('Approval failed');
    });

    it('should fail if sending intent transaction fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
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

        getERC20ContractStub.resolves(mockTokenContract as any);
        (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(new Error('Intent transaction failed'));

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
            minAmounts: {
                [intentsArray[0].origin]: intentsArray[0].amount
            }
        });

        await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig))
            .to.be.rejectedWith('Intent transaction failed');
    });

    it('should handle empty batches', async () => {
        const batch = new Map();
        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        const result = await sendIntents(invoiceId, intentsArray as NewIntentParams[], mockDeps, mockConfig);
        expect(result).to.deep.equal([]);
        expect((mockDeps.everclear.createNewIntent as SinonStub).called).to.be.false;
    });

    it('should handle when min amounts are smaller than intent amounts', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
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

        getERC20ContractStub.resolves(mockTokenContract as any);
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(
            createMockTransactionReceipt('0xintentTx', '0x0000000000000000000000000000000000000000000000000000000000000000', 'order')
        );

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
            minAmounts: {
                [intentsArray[0].origin]: '0'
            }
        });

        const result = await sendIntents(
            invoiceId,
            intentsArray,
            mockDeps,
            mockConfig,
        );

        expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).to.equal(1); // Called for intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1', intentId: '0x0000000000000000000000000000000000000000000000000000000000000000' }]);
    });

    it('should handle cases where there is not sufficient allowance', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
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

        getERC20ContractStub.resolves(mockTokenContract as any);
        (mockDeps.chainService.submitAndMonitor as SinonStub)
            .onFirstCall().resolves(createMockTransactionReceipt('0xapprovalTx', '0x0000000000000000000000000000000000000000000000000000000000000000', 'order'))
            .onSecondCall().resolves(createMockTransactionReceipt('0xintentTx', '0x0000000000000000000000000000000000000000000000000000000000000000', 'order'));

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
            minAmounts: {
                [intentsArray[0].origin]: intentsArray[0].amount
            }
        });

        const result = await sendIntents(invoiceId, intentsArray, mockDeps, mockConfig);

        expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).to.equal(2); // Called for both approval and intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1', intentId: '0x0000000000000000000000000000000000000000000000000000000000000000' }]);
    });

    it('should handle cases where there is sufficient allowance', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
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

        getERC20ContractStub.resolves(mockTokenContract as any);
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(
            createMockTransactionReceipt('0xintentTx', '0x0000000000000000000000000000000000000000000000000000000000000000', 'order')
        );

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
            minAmounts: {
                [intentsArray[0].origin]: intentsArray[0].amount
            }
        });

        const result = await sendIntents(
            invoiceId,
            intentsArray,
            mockDeps,
            mockConfig,
        );

        expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).to.equal(1); // Called only for intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1', intentId: '0x0000000000000000000000000000000000000000000000000000000000000000' }]);
    });

    it('should throw an error when sending multiple intents with different input assets', async () => {
        const differentAssetIntents = [
            {
                origin: '1',
                destinations: ['8453'],
                to: '0xto1',
                inputAsset: '0xtoken1',
                amount: '1000',
                callData: '0x',
                maxFee: '0',
            },
            {
                origin: '1',  // Same origin
                destinations: ['42161'],
                to: '0xto2',
                inputAsset: '0xtoken2', // Different input asset
                amount: '2000',
                callData: '0x',
                maxFee: '0',
            }
        ];

        await expect(sendIntents(invoiceId, differentAssetIntents, mockDeps, mockConfig))
            .to.be.rejectedWith('Cannot process multiple intents with different input assets');
    });

    it('should process multiple intents with the same origin and input asset in a single transaction', async () => {
        const sameOriginSameAssetIntents = [
            {
                origin: '1',
                destinations: ['8453'],
                to: '0xto1',
                inputAsset: '0xtoken1',
                amount: '1000',
                callData: '0x',
                maxFee: '0',
            },
            {
                origin: '1',  // Same origin
                destinations: ['42161'],
                to: '0xto2',
                inputAsset: '0xtoken1', // Same input asset
                amount: '2000',
                callData: '0x',
                maxFee: '0',
            }
        ];

        // Set up createNewIntent to handle the batch call
        const createNewIntentStub = mockDeps.everclear.createNewIntent as SinonStub;
        createNewIntentStub.resolves({
            to: '0xspoke1',
            data: '0xdata1',
            chainId: '1',
            from: mockConfig.ownAddress,
            value: '0',
        });

        (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
            minAmounts: {
                1: '2000'
            }
        });

        const mockTokenContract = {
            address: '0xtoken1',
            read: {
                allowance: stub().resolves(BigInt(5000)), // Sufficient allowance for both
            },
        } as unknown as GetContractReturnType;

        getERC20ContractStub.resolves(mockTokenContract as any);

        // Mock transaction response with both intent IDs in the OrderCreated event
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(
            createMockTransactionReceipt('0xbatchTx', '0x0000000000000000000000000000000000000000000000000000000000000000', 'order')
        );  
        const result = await sendIntents(invoiceId, sameOriginSameAssetIntents, mockDeps, mockConfig);

        // Should be called once for the batch
        expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).to.equal(1);
    });
});

describe('sendIntentsMulticall', () => {
    let mockIntent: NewIntentParams;
    let mockDeps: any;
    let mockConfig: MarkConfiguration;
    let mockPermit2Functions: any;
    const MOCK_TOKEN1 = '0x1234567890123456789012345678901234567890';
    const MOCK_DEST1 = '0xddddddddddddddddddddddddddddddddddddddd1';
    const MOCK_DEST2 = '0xddddddddddddddddddddddddddddddddddddddd2';
    const MOCK_MULTICALL_ADDRESS = '0xmulticall3';

    beforeEach(async () => {
        mockDeps = {
            everclear: createStubInstance(EverclearAdapter, {
                createNewIntent: stub()
            }),
            chainService: createStubInstance(ChainService, {
                submitAndMonitor: stub()
            }),
            logger: createStubInstance(Logger),
            web3Signer: createStubInstance(Wallet, {
                _signTypedData: stub()
            }),
            cache: createStubInstance(PurchaseCache),
            prometheus: createStubInstance(PrometheusAdapter),
        };

        mockConfig = {
            ownAddress: '0xdeadbeef1234567890deadbeef1234567890dead',
            chains: {
                '1': {
                    providers: ['provider1'],
                    deployments: {
                        everclear: '0xspoke',
                        multicall3: MOCK_MULTICALL_ADDRESS,
                        permit2: '0xpermit2address'
                    }
                },
            },
        } as unknown as MarkConfiguration;

        mockIntent = {
            origin: '1',
            destinations: ['8453'],
            to: MOCK_DEST1,
            inputAsset: MOCK_TOKEN1,
            amount: '1000',
            callData: '0x',
            maxFee: '0',
        };

        mockPermit2Functions = {
            generatePermit2Nonce: stub().returns('0x123456'),
            generatePermit2Deadline: stub().returns(BigInt('1735689600')), // Some future timestamp
            getPermit2Signature: stub().resolves('0xsignature'),
            approvePermit2: stub().resolves('0xapprovalTx')
        };

        stub(permit2Helpers, 'generatePermit2Nonce').callsFake(mockPermit2Functions.generatePermit2Nonce);
        stub(permit2Helpers, 'generatePermit2Deadline').callsFake(mockPermit2Functions.generatePermit2Deadline);
        stub(permit2Helpers, 'getPermit2Signature').callsFake(mockPermit2Functions.getPermit2Signature);
        stub(permit2Helpers, 'approvePermit2').callsFake(mockPermit2Functions.approvePermit2);
    });

    afterEach(() => {
        sinonRestore();
    });

    it('should throw an error when intents array is empty', async () => {
        await expect(sendIntentsMulticall([], mockDeps, mockConfig))
            .to.be.rejectedWith('No intents provided for multicall');
    });

    it('should handle errors when Permit2 approval fails', async () => {
        // Mock token contract with zero allowance for Permit2
        const tokenContract = {
            address: MOCK_TOKEN1,
            read: {
                allowance: stub().resolves(BigInt('0')), // No allowance for Permit2
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(tokenContract as any);

        // Mock approvePermit2 to throw an error
        const errorMessage = 'Failed to approve Permit2';
        mockPermit2Functions.approvePermit2.rejects(new Error(errorMessage));

        // Create an intent to test
        const intents = [mockIntent];

        // Verify that the error is properly caught, logged, and rethrown
        await expect(sendIntentsMulticall(intents, mockDeps, mockConfig))
            .to.be.rejectedWith(errorMessage);

        // Verify that the error was logged with the correct parameters
        expect((mockDeps.logger.error as SinonStub).calledWith(
            'Error signing/submitting Permit2 approval',
            {
                error: errorMessage,
                chainId: '1',
            }
        )).to.be.true;
    });

    it('should throw an error when Permit2 approval transaction is submitted but allowance is still zero', async () => {
        // Create a token contract stub that returns zero allowance initially
        // and still returns zero after approval (simulating a failed approval)
        const allowanceStub = stub();
        allowanceStub.onFirstCall().resolves(BigInt('0')); // Initial zero allowance
        allowanceStub.onSecondCall().resolves(BigInt('0')); // Still zero after approval

        const tokenContract = {
            address: MOCK_TOKEN1,
            read: {
                allowance: allowanceStub,
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(tokenContract as any);

        // Mock approvePermit2 to succeed but not actually change the allowance
        const txHash = '0xapprovalTxHash';
        mockPermit2Functions.approvePermit2.resolves(txHash);

        // Create an intent to test
        const intents = [mockIntent];

        // Verify that the error is properly thrown with the expected message
        await expect(sendIntentsMulticall(intents, mockDeps, mockConfig))
            .to.be.rejectedWith(`Permit2 approval transaction was submitted (${txHash}) but allowance is still zero`);
    });

    it('should handle errors when signing Permit2 message or fetching transaction data', async () => {
        // Mock token contract with sufficient allowance for Permit2
        const tokenContract = {
            address: MOCK_TOKEN1,
            read: {
                allowance: stub().resolves(BigInt('1000000000000000000')), // Already approved for Permit2
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(tokenContract as any);

        // Mock getPermit2Signature to succeed
        mockPermit2Functions.getPermit2Signature.resolves('0xsignature');

        // Mock everclear.createNewIntent to throw an error
        const errorMessage = 'API error when creating intent';
        (mockDeps.everclear.createNewIntent as SinonStub).rejects(new Error(errorMessage));

        // Create two intents to test the error handling in the loop
        const intents = [
            mockIntent,
            {
                ...mockIntent,
                to: MOCK_DEST2
            }
        ];

        // Verify that the error is properly caught, logged, and rethrown
        await expect(sendIntentsMulticall(intents, mockDeps, mockConfig))
            .to.be.rejectedWith(errorMessage);

        // Verify that the error was logged with the correct parameters
        expect((mockDeps.logger.error as SinonStub).calledWith(
            'Error signing Permit2 message or fetching transaction data',
            {
                error: errorMessage,
                tokenAddress: MOCK_TOKEN1,
                spender: '0xspoke',
                amount: '1000',
                nonce: '0x123456',
                deadline: '1735689600',
            }
        )).to.be.true;
    });

    it('should add 0x prefix to nonce when it does not have one', async () => {
        // Mock token contract with sufficient allowance for Permit2
        const tokenContract = {
            address: MOCK_TOKEN1,
            read: {
                allowance: stub().resolves(BigInt('1000000000000000000')), // Already approved for Permit2
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(tokenContract as any);

        // Return a nonce without 0x prefix
        mockPermit2Functions.generatePermit2Nonce.returns('123456');

        // Mock getPermit2Signature to succeed
        mockPermit2Functions.getPermit2Signature.resolves('0xsignature');

        // Mock everclear.createNewIntent to return valid transaction data
        (mockDeps.everclear.createNewIntent as SinonStub).callsFake((intentWithPermit) => {
            // Verify that the nonce has been prefixed with 0x
            // The nonce will have the index suffix (00) appended to it
            expect(intentWithPermit.permit2Params.nonce).to.equal('0x12345600');
            return Promise.resolve({
                to: zeroAddress,
                data: '0xintentdata',
                chainId: 1,
            });
        });

        // Mock chainService to return a successful receipt
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
            transactionHash: '0xmulticallTx',
            cumulativeGasUsed: BigNumber.from('200000'),
            effectiveGasPrice: BigNumber.from('5'),
            logs: [
                {
                    topics: [
                        '0x5c5c7ce44a0165f76ea4e0a89f0f7ac5cce7b2c1d1b91d0f49c1f219656b7d8c',
                        '0x0000000000000000000000000000000000000000000000000000000000000001',
                        '0x0000000000000000000000000000000000000000000000000000000000000002'
                    ],
                    data: '0x00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000'
                }
            ]
        });

        // Call the function with a single intent
        await sendIntentsMulticall([mockIntent], mockDeps, mockConfig);

        // Verify that createNewIntent was called with the correct parameters
        expect((mockDeps.everclear.createNewIntent as SinonStub).called).to.be.true;
    });

    it('should prepare and send a multicall transaction with multiple intents', async () => {
        // Mock token contract with sufficient allowance for Permit2
        const tokenContract = {
            address: MOCK_TOKEN1,
            read: {
                allowance: stub().resolves(BigInt('1000000000000000000')), // Already approved for Permit2
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(tokenContract as any);

        // Mock everclear.createNewIntent to return valid transaction data
        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
            to: zeroAddress,
            data: '0xintentdata',
            chainId: 1,
        });

        // Mock chainService to return a successful receipt with intent IDs in logs
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
            transactionHash: '0xmulticallTx',
            cumulativeGasUsed: BigNumber.from('200000'),
            effectiveGasPrice: BigNumber.from('5'),
            logs: [
                createMockTransactionReceipt('0xmulticallTx', '0x0000000000000000000000000000000000000000000000000000000000000001').logs[0],
                createMockTransactionReceipt('0xmulticallTx', '0x0000000000000000000000000000000000000000000000000000000000000002').logs[0]
            ]
        });

        // Create two intents with different destinations
        const intents = [
            { ...mockIntent, to: MOCK_DEST1 },
            { ...mockIntent, to: MOCK_DEST2 }
        ];

        const result = await sendIntentsMulticall(
            intents,
            mockDeps,
            mockConfig,
        );

        // Verify the structure of the result
        expect(result).to.deep.equal({
            transactionHash: '0xmulticallTx',
            chainId: '1',
            intentId: MOCK_DEST1
        });

        // Verify everclear.createNewIntent was called for each intent
        expect((mockDeps.everclear.createNewIntent as SinonStub).callCount).to.equal(2);

        // Verify chainService.submitAndMonitor was called with multicall data
        expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).to.equal(1);
        const submitCall = (mockDeps.chainService.submitAndMonitor as SinonStub).firstCall.args[1];
        expect(submitCall.to).to.equal(MOCK_MULTICALL_ADDRESS);

        // Verify prometheus metrics were updated
        expect((mockDeps.prometheus.updateGasSpent as SinonStub).calledOnce).to.be.true;
    });

    it('should construct the correct multicall payload from multiple intents', async () => {
        // Mock token contract with sufficient allowance
        const tokenContract = {
            address: MOCK_TOKEN1,
            read: {
                allowance: stub().resolves(BigInt('1000000000000000000')),
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(tokenContract as any);

        // Mock intent creation to return different data for each intent
        const intentData = [
            { to: zeroAddress, data: '0xintent1data', chainId: 1 },
            { to: zeroAddress, data: '0xintent2data', chainId: 1 }
        ];

        const createNewIntentStub = mockDeps.everclear.createNewIntent as SinonStub;
        createNewIntentStub.onFirstCall().resolves(intentData[0]);
        createNewIntentStub.onSecondCall().resolves(intentData[1]);

        // Mock successful transaction submission
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
            transactionHash: '0xmulticallTx',
            cumulativeGasUsed: BigNumber.from('200000'),
            effectiveGasPrice: BigNumber.from('5'),
            logs: []
        });

        const intents = [
            { ...mockIntent, to: MOCK_DEST1 },
            { ...mockIntent, to: MOCK_DEST2 }
        ];

        await sendIntentsMulticall(intents, mockDeps, mockConfig);

        // Check that chainService was called with correct multicall data
        const submitCall = (mockDeps.chainService.submitAndMonitor as SinonStub).firstCall.args[1];

        // The multicall should contain both intent calls
        expect(submitCall.to).to.equal(MOCK_MULTICALL_ADDRESS);
        // The data should be a multicall encoding containing both intent data
        const data = submitCall.data;
        expect(data).to.match(/^0x/); // Should be hex
        // Both intent data strings should be included in the multicall data
        expect(data.includes('0xintent1data'.substring(2))).to.be.true;
        expect(data.includes('0xintent2data'.substring(2))).to.be.true;
    });

    it('should throw an error if chainService.submitAndMonitor fails', async () => {
        // Mock token contract with sufficient allowance
        const tokenContract = {
            address: MOCK_TOKEN1,
            read: {
                allowance: stub().resolves(BigInt('1000000000000000000')),
            },
        } as unknown as GetContractReturnType;

        stub(contractHelpers, 'getERC20Contract').resolves(tokenContract as any);

        // Mock intent creation success
        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
            to: zeroAddress,
            data: '0xintentdata',
            chainId: 1,
        });

        // Mock transaction submission failure
        const txError = new Error('Transaction failed');
        (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(txError);

        const intents = [
            { ...mockIntent, inputAsset: MOCK_TOKEN1 },
        ];

        // The function passes through the original error
        await expect(sendIntentsMulticall(intents, mockDeps, mockConfig))
            .to.be.rejectedWith(txError);

        // Verify the error was logged
        expect((mockDeps.logger.error as SinonStub).calledWith('Failed to submit multicall transaction')).to.be.true;
    });
});