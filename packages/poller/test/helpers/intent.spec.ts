import { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore as sinonRestore } from 'sinon';
import { 
    INTENT_ADDED_TOPIC0, 
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

describe('sendIntents', () => {
    let mockDeps: SinonStubbedInstance<MarkAdapters>;

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
        }
    });

    it('should fail if everclear.createNewIntent fails', async () => {
        const batch = new Map([
            ['1', new Map([['0xtoken1', mockIntent]])],
        ]);

        (mockDeps.everclear.createNewIntent as SinonStub).rejects(new Error('API Error'));

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig)).to.be.rejectedWith(
            'Failed to send intents: API Error',
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

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: Allowance check failed');
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

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;
        (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(new Error('Approval failed'));

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: Approval failed');
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

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;
        (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(new Error('Intent transaction failed'));

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        await expect(sendIntents(intentsArray, mockDeps, mockConfig))
            .to.be.rejectedWith('Failed to send intents: Intent transaction failed');
    });

    it('should handle empty batches', async () => {
        const batch = new Map();
        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        const result = await sendIntents(intentsArray as NewIntentParams[], mockDeps, mockConfig);
        expect(result).to.deep.equal([]);
        expect((mockDeps.everclear.createNewIntent as SinonStub).called).to.be.false;
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

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);;
        (mockDeps.chainService.submitAndMonitor as SinonStub)
            .onFirstCall().resolves({
                transactionHash: '0xapprovalTx', cumulativeGasUsed: BigNumber.from('100'), effectiveGasPrice: BigNumber.from('1'), logs: [{
                    topics: [INTENT_ADDED_TOPIC0, '0xintentid']
                }]
            })
            .onSecondCall().resolves({
                transactionHash: '0xintentTx', cumulativeGasUsed: BigNumber.from('100'), effectiveGasPrice: BigNumber.from('1'), logs: [{
                    topics: [INTENT_ADDED_TOPIC0, '0xintentid']
                }]
            });

        const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

        const result = await sendIntents(intentsArray, mockDeps, mockConfig);

        expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).to.equal(2); // Called for both approval and intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1', intentId: '0xintentid' }]);
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

        stub(contractHelpers, 'getERC20Contract').resolves(mockTokenContract as any);
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
            transactionHash: '0xintentTx', cumulativeGasUsed: BigNumber.from('100'), effectiveGasPrice: BigNumber.from('1'), logs: [{
                topics: [INTENT_ADDED_TOPIC0, '0xintentid']
            }]
        });

        const result = await sendIntents(
            Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values())),
            mockDeps,
            mockConfig,
        );

        expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).to.equal(1); // Called only for intent
        expect(result).to.deep.equal([{ transactionHash: '0xintentTx', chainId: '1', intentId: '0xintentid' }]);
    });
});

describe('sendIntentsMulticall', () => {
    const multicallAddress = contractHelpers.MULTICALL_ADDRESS;
    
    let mockDeps: SinonStubbedInstance<MarkAdapters>;
    let mockConfig: MarkConfiguration;
    let mockIntent: NewIntentParams;
    let mockPermit2Functions: {
        generatePermit2Nonce: SinonStub;
        generatePermit2Deadline: SinonStub;
        getPermit2Signature: SinonStub;
        approvePermit2: SinonStub;
    };
    
    // Valid test Ethereum addresses
    const MOCK_TOKEN1 = '0x1111111111111111111111111111111111111111';
    const MOCK_TOKEN2 = '0x2222222222222222222222222222222222222222';
    const MOCK_DEST1 = '0xd1111111111111111111111111111111111111d1';
    const MOCK_DEST2 = '0xd2222222222222222222222222222222222222d2';
    const ZERO_ADDRESS = zeroAddress;
    
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
                '1': { providers: ['provider1'] },
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
        await expect(sendIntentsMulticall([], mockDeps, mockConfig, ZERO_ADDRESS))
            .to.be.rejectedWith('No intents provided for multicall');
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
            to: ZERO_ADDRESS,
            data: '0xintentdata',
            chainId: 1,
        });
        
        // Mock chainService to return a successful receipt with intent IDs in logs
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
            transactionHash: '0xmulticallTx',
            cumulativeGasUsed: BigNumber.from('200000'),
            effectiveGasPrice: BigNumber.from('5'),
            logs: [
                {
                    topics: [INTENT_ADDED_TOPIC0, '0xintentid1']
                },
                {
                    topics: [INTENT_ADDED_TOPIC0, '0xintentid2']
                }
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
            ZERO_ADDRESS
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
        expect(submitCall.to).to.equal(multicallAddress);
        
        // Verify prometheus metrics were updated
        expect((mockDeps.prometheus.updateGasSpent as SinonStub).calledOnce).to.be.true;
    });

    it('should check and get permit2 allowances for each token', async () => {
        // Two different tokens with different allowance status
        const tokenContract1 = {
            address: MOCK_TOKEN1,
            read: {
                allowance: stub().resolves(BigInt('1000000000000000000')), // Already approved
            },
        } as unknown as GetContractReturnType;
        
        const tokenContract2 = {
            address: MOCK_TOKEN2,
            read: {
                allowance: stub().resolves(BigInt('0')), // Needs approval
            },
        } as unknown as GetContractReturnType;
        
        // Use dynamic stub responses
        const getERC20ContractStub = stub(contractHelpers, 'getERC20Contract');
        getERC20ContractStub.withArgs(mockConfig, '1', MOCK_TOKEN1).resolves(tokenContract1 as any);
        getERC20ContractStub.withArgs(mockConfig, '1', MOCK_TOKEN2).resolves(tokenContract2 as any);
        
        // Mock the rest similar to success case
        (mockDeps.everclear.createNewIntent as SinonStub).resolves({
            to: ZERO_ADDRESS,
            data: '0xintentdata',
            chainId: 1,
        });
        
        (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
            transactionHash: '0xmulticallTx',
            cumulativeGasUsed: BigNumber.from('200000'),
            effectiveGasPrice: BigNumber.from('5'),
            logs: []
        });
        
        const intents = [
            { ...mockIntent, inputAsset: MOCK_TOKEN1, to: MOCK_DEST1 },
            { ...mockIntent, inputAsset: MOCK_TOKEN2, to: MOCK_DEST2 },
        ];
        
        await sendIntentsMulticall(intents, mockDeps, mockConfig, ZERO_ADDRESS);
        
        // Verify ERC20 contracts were checked for both tokens
        expect(getERC20ContractStub.callCount).to.equal(2);
        
        // Verify approvePermit2 was called only for the token that needed approval
        expect(mockPermit2Functions.approvePermit2.callCount).to.equal(1);
        expect(mockPermit2Functions.approvePermit2.firstCall.args[0]).to.equal(MOCK_TOKEN2);
        
        // Verify getPermit2Signature was called for each token/intent
        expect(mockPermit2Functions.getPermit2Signature.callCount).to.equal(2);
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
            { to: ZERO_ADDRESS, data: '0xintent1data', chainId: 1 },
            { to: ZERO_ADDRESS, data: '0xintent2data', chainId: 1 }
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
        
        await sendIntentsMulticall(intents, mockDeps, mockConfig, ZERO_ADDRESS);
        
        // Check that chainService was called with correct multicall data
        const submitCall = (mockDeps.chainService.submitAndMonitor as SinonStub).firstCall.args[1];
        
        // The multicall should contain both intent calls
        expect(submitCall.to).to.equal(multicallAddress);
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
            to: ZERO_ADDRESS,
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
        await expect(sendIntentsMulticall(intents, mockDeps, mockConfig, ZERO_ADDRESS))
            .to.be.rejectedWith(txError);
            
        // Verify the error was logged
        expect((mockDeps.logger.error as SinonStub).calledWith('Failed to submit multicall transaction')).to.be.true;
    });
});