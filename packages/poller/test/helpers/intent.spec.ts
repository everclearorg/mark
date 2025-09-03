import { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore as sinonRestore } from 'sinon';
import { INTENT_ADDED_TOPIC0, sendIntents, sendIntentsMulticall } from '../../src/helpers/intent';
import { MarkConfiguration, NewIntentParams, TransactionSubmissionType } from '@mark/core';
import { Logger } from '@mark/logger';
import { Log, TransactionReceipt, zeroAddress } from 'viem';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { MarkAdapters } from '../../src/init';
import { Wallet } from 'ethers';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { RebalanceAdapter } from '@mark/rebalance';
import { createMinimalDatabaseMock } from '../mocks/database';
import { Web3Signer } from '@mark/web3signer';

// Common test constants for transaction logs
const INTENT_ADDED_TOPIC = '0x5c5c7ce44a0165f76ea4e0a89f0f7ac5cce7b2c1d1b91d0f49c1f219656b7d8c';
const INTENT_ADDED_LOG_DATA =
  '0x000000000000000000000000000000000000000000000000000000000000074d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000015a7ca97d1ed168fb34a4055cefa2e2f9bdb6c75000000000000000000000000b60d0c2e8309518373b40f8eaa2cad0d1de3decb000000000000000000000000fde4c96c8593536e31f229ea8f37b2ada2699bb2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002105000000000000000000000000000000000000000000000000000000000000074d0000000000000000000000000000000000000000000000000000000067f1620f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000a86a0000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000a4b1000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000';

const createMockTransactionReceipt = (
  transactionHash: string,
  intentId: string,
  eventType: 'intent' | 'order' = 'intent',
) => ({
  transactionHash,
  cumulativeGasUsed: 100n,
  effectiveGasPrice: 1n,
  logs: [
    {
      topics:
        eventType === 'intent'
          ? [INTENT_ADDED_TOPIC, intentId, '0x0000000000000000000000000000000000000000000000000000000000000002']
          : [INTENT_ADDED_TOPIC0, intentId, '0x0000000000000000000000000000000000000000000000000000000000000002'],
      data: INTENT_ADDED_LOG_DATA,
    },
  ],
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
    to: '0xdeadbeef1234567890deadbeef1234567890dead', // Use ownAddress for EOA
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
        submitAndMonitor: stub(),
        readTx: stub(),
      }),
      logger: createStubInstance(Logger),
      web3Signer: createStubInstance(Wallet, {
        signTypedData: stub(),
      }),
      purchaseCache: createStubInstance(PurchaseCache),
      rebalance: createStubInstance(RebalanceAdapter),
      prometheus: createStubInstance(PrometheusAdapter),
      database: createMinimalDatabaseMock(),
    };

    getERC20ContractStub = stub(contractHelpers, 'getERC20Contract');
  });

  afterEach(() => {
    sinonRestore();
  });

  it('should fail if everclear.createNewIntent fails', async () => {
    const batch = new Map([['1', new Map([['0xtoken1', mockIntent]])]]);

    (mockDeps.everclear.createNewIntent as SinonStub).rejects(new Error('API Error'));

    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig)).rejects.toThrow('API Error');
  });

  it('should fail if getting allowance fails', async () => {
    const batch = new Map([['1', new Map([['0xtoken1', mockIntent]])]]);

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xdata',
      chainId: 1,
    });

    // Mock chainService.readTx to reject with error
    (mockDeps.chainService.readTx as SinonStub).rejects(new Error('Allowance check failed'));

    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: {
        [intentsArray[0].origin]: intentsArray[0].amount,
      },
    });

    await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig)).rejects.toThrow('Allowance check failed');
  });

  it('should fail if sending approval transaction fails', async () => {
    const batch = new Map([['1', new Map([['0xtoken1', mockIntent]])]]);

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xdata',
      chainId: 1,
    });

    // Mock zero allowance to trigger approval
    const encodedZeroAllowance = '0x0000000000000000000000000000000000000000000000000000000000000000';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedZeroAllowance);
    (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(new Error('Approval failed'));

    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: {
        [intentsArray[0].origin]: intentsArray[0].amount,
      },
    });

    await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig)).rejects.toThrow('Approval failed');
  });

  it('should fail if sending intent transaction fails', async () => {
    const batch = new Map([['1', new Map([['0xtoken1', mockIntent]])]]);

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xdata',
      chainId: 1,
    });

    // Mock sufficient allowance (2000n in hex)
    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000007d0';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);
    (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(new Error('Intent transaction failed'));

    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: {
        [intentsArray[0].origin]: intentsArray[0].amount,
      },
    });

    await expect(sendIntents(invoiceId, intentsArray, mockDeps, mockConfig)).rejects.toThrow(
      'Intent transaction failed',
    );
  });

  it('should handle empty batches', async () => {
    const batch = new Map();
    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    const result = await sendIntents(invoiceId, intentsArray as NewIntentParams[], mockDeps, mockConfig);
    expect(result).toEqual([]);
    expect((mockDeps.everclear.createNewIntent as SinonStub).called).toBe(false);
  });

  it('should handle when min amounts are smaller than intent amounts', async () => {
    const batch = new Map([['1', new Map([['0xtoken1', mockIntent]])]]);

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xdata',
      chainId: 1,
    });

    // Mock sufficient allowance (2000n in hex)
    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000007d0';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);
    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(
      createMockTransactionReceipt(
        '0xintentTx',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        'order',
      ),
    );

    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: {
        [intentsArray[0].origin]: '0',
      },
    });

    const result = await sendIntents(invoiceId, intentsArray, mockDeps, mockConfig);

    expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).toBe(1); // Called for intent
    expect(result).toEqual([
      {
        type: TransactionSubmissionType.Onchain,
        transactionHash: '0xintentTx',
        chainId: '1',
        intentId: '0x0000000000000000000000000000000000000000000000000000000000000000',
      },
    ]);
  });

  it('should handle cases where there is not sufficient allowance', async () => {
    const batch = new Map([['1', new Map([['0xtoken1', mockIntent]])]]);

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xdata',
      chainId: 1,
    });

    // Mock insufficient allowance (500n in hex)
    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000001f4';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);
    (mockDeps.chainService.submitAndMonitor as SinonStub)
      .onFirstCall()
      .resolves(
        createMockTransactionReceipt(
          '0xapprovalTx',
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          'order',
        ),
      )
      .onSecondCall()
      .resolves(
        createMockTransactionReceipt(
          '0xintentTx',
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          'order',
        ),
      );

    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: {
        [intentsArray[0].origin]: intentsArray[0].amount,
      },
    });

    const result = await sendIntents(invoiceId, intentsArray, mockDeps, mockConfig);

    expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).toBe(2); // Called for both approval and intent
    expect(result).toEqual([
      {
        type: TransactionSubmissionType.Onchain,
        transactionHash: '0xintentTx',
        chainId: '1',
        intentId: '0x0000000000000000000000000000000000000000000000000000000000000000',
      },
    ]);
  });

  it('should handle cases where there is sufficient allowance', async () => {
    const batch = new Map([['1', new Map([['0xtoken1', mockIntent]])]]);

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xdata',
      chainId: 1,
    });

    // Mock sufficient allowance (2000n in hex)
    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000007d0';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);
    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(
      createMockTransactionReceipt(
        '0xintentTx',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        'order',
      ),
    );

    const intentsArray = Array.from(batch.values()).flatMap((assetMap) => Array.from(assetMap.values()));

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: {
        [intentsArray[0].origin]: intentsArray[0].amount,
      },
    });

    const result = await sendIntents(invoiceId, intentsArray, mockDeps, mockConfig);

    expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).toBe(1); // Called only for intent
    expect(result).toEqual([
      {
        type: TransactionSubmissionType.Onchain,
        transactionHash: '0xintentTx',
        chainId: '1',
        intentId: '0x0000000000000000000000000000000000000000000000000000000000000000',
      },
    ]);
  });

  it('should set USDT allowance to zero before setting new allowance', async () => {
    // Mock a valid USDT token address and spender address
    const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
    const SPENDER_ADDRESS = '0x1234567890123456789012345678901234567890';

    const usdtIntent: NewIntentParams = {
      origin: '1',
      destinations: ['8453'],
      to: '0x1234567890123456789012345678901234567890',
      inputAsset: USDT_ADDRESS,
      amount: '1000000', // 1 USDT
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: SPENDER_ADDRESS as `0x${string}`,
      data: '0xdata',
      chainId: '1',
    });

    // Mock USDT with existing non-zero allowance (500000n in hex)
    const encodedAllowance = '0x000000000000000000000000000000000000000000000000000000000007a120';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    (mockDeps.chainService.submitAndMonitor as SinonStub)
      .onFirstCall()
      .resolves(
        createMockTransactionReceipt('0xzeroTx', '0x0000000000000000000000000000000000000000000000000000000000000001'),
      ) // Zero allowance tx
      .onSecondCall()
      .resolves(
        createMockTransactionReceipt(
          '0xapproveTx',
          '0x0000000000000000000000000000000000000000000000000000000000000002',
        ),
      ) // New allowance tx
      .onThirdCall()
      .resolves(
        createMockTransactionReceipt(
          '0xintentTx',
          '0x0000000000000000000000000000000000000000000000000000000000000003',
          'order',
        ),
      ); // Intent tx

    // Configure mock config with USDT asset
    const configWithUSDT = {
      ...mockConfig,
      ownAddress: '0x1234567890123456789012345678901234567890',
      chains: {
        '1': {
          providers: ['http://localhost:8545'],
          assets: [
            {
              symbol: 'USDT',
              address: USDT_ADDRESS,
              decimals: 6,
              tickerHash: '0xticker1',
              isNative: false,
              balanceThreshold: '1000000',
            },
          ],
          invoiceAge: 3600,
          gasThreshold: '1000000000000000000',
          deployments: {
            everclear: SPENDER_ADDRESS,
            permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
            multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
          },
        },
      },
    } as MarkConfiguration;

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '1': '1000000' },
    });

    await sendIntents(invoiceId, [usdtIntent], mockDeps, configWithUSDT);

    // First tx should zero allowance
    const zeroAllowanceCall = (mockDeps.chainService.submitAndMonitor as SinonStub).firstCall.args[1];
    expect(zeroAllowanceCall.to).toBe(USDT_ADDRESS);
    expect(zeroAllowanceCall.data).toContain('0000000000000000000000000000000000000000000000000000000000000000'); // Zero amount in approval data

    // Second tx should be new allowance
    const newAllowanceCall = (mockDeps.chainService.submitAndMonitor as SinonStub).secondCall.args[1];
    expect(newAllowanceCall.to).toBe(USDT_ADDRESS);

    // Third tx should be new intent
    const intentCall = (mockDeps.chainService.submitAndMonitor as SinonStub).thirdCall.args[1];
    expect(intentCall.data).toBe('0xdata');
  });

  it('should throw an error when sending multiple intents with different input assets', async () => {
    const differentAssetIntents = [
      {
        origin: '1',
        destinations: ['8453'],
        to: mockConfig.ownAddress,
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      },
      {
        origin: '1', // Same origin
        destinations: ['42161'],
        to: mockConfig.ownAddress,
        inputAsset: '0xtoken2', // Different input asset
        amount: '2000',
        callData: '0x',
        maxFee: '0',
      },
    ];

    await expect(sendIntents(invoiceId, differentAssetIntents, mockDeps, mockConfig)).rejects.toThrow(
      'Cannot process multiple intents with different input assets',
    );
  });

  it('should process multiple intents with the same origin and input asset in a single transaction', async () => {
    const sameOriginSameAssetIntents = [
      {
        origin: '1',
        destinations: ['8453'],
        to: mockConfig.ownAddress,
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      },
      {
        origin: '1', // Same origin
        destinations: ['42161'],
        to: mockConfig.ownAddress,
        inputAsset: '0xtoken1', // Same input asset
        amount: '2000',
        callData: '0x',
        maxFee: '0',
      },
    ];

    // Set up createNewIntent to handle the batch call
    const createNewIntentStub = mockDeps.everclear.createNewIntent as SinonStub;
    createNewIntentStub.resolves({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xdata1',
      chainId: '1',
      from: mockConfig.ownAddress,
      value: '0',
    });

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: {
        1: '2000',
      },
    });

    // Mock sufficient allowance for both intents (5000n in hex)
    const encodedAllowance = '0x0000000000000000000000000000000000000000000000000000000000001388';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    // Mock transaction response with both intent IDs in the OrderCreated event
    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(
      createMockTransactionReceipt(
        '0xbatchTx',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        'order',
      ),
    );
    await sendIntents(invoiceId, sameOriginSameAssetIntents, mockDeps, mockConfig);

    // Should be called once for the batch
    expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).toBe(1);
  });

  // Test cases for new sanity check validation logic
  describe('Intent Validation (Sanity Checks)', () => {
    beforeEach(() => {
      // Set up common successful mocks for validation tests
      (mockDeps.everclear.createNewIntent as SinonStub).resolves({
        to: zeroAddress,
        data: '0xdata',
        chainId: 1,
      });

      // Mock sufficient allowance (2000n in hex)
      const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000007d0';
      (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);
      (mockDeps.chainService.submitAndMonitor as SinonStub).resolves(
        createMockTransactionReceipt(
          '0xintentTx',
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          'order',
        ),
      );

      (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
        minAmounts: { '1': '1000' },
      });
    });

    it('should throw an error when intents have different origins', async () => {
      const differentOriginIntents = [
        {
          origin: '1',
          destinations: ['8453'],
          to: mockConfig.ownAddress,
          inputAsset: '0xtoken1',
          amount: '1000',
          callData: '0x',
          maxFee: '0',
        },
        {
          origin: '42161', // Different origin
          destinations: ['8453'],
          to: mockConfig.ownAddress,
          inputAsset: '0xtoken1',
          amount: '1000',
          callData: '0x',
          maxFee: '0',
        },
      ];

      await expect(sendIntents(invoiceId, differentOriginIntents, mockDeps, mockConfig)).rejects.toThrow(
        'Cannot process multiple intents with different origin domains',
      );
    });

    it('should throw an error when intent has non-zero maxFee', async () => {
      const nonZeroMaxFeeIntent = {
        origin: '1',
        destinations: ['8453'],
        to: mockConfig.ownAddress,
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '100', // Non-zero maxFee
      };

      await expect(sendIntents(invoiceId, [nonZeroMaxFeeIntent], mockDeps, mockConfig)).rejects.toThrow(
        'intent.maxFee (100) must be 0',
      );
    });

    it('should throw an error when intent has non-empty callData', async () => {
      const nonEmptyCallDataIntent = {
        origin: '1',
        destinations: ['8453'],
        to: mockConfig.ownAddress,
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x1234', // Non-empty callData
        maxFee: '0',
      };

      await expect(sendIntents(invoiceId, [nonEmptyCallDataIntent], mockDeps, mockConfig)).rejects.toThrow(
        'intent.callData (0x1234) must be 0x',
      );
    });

    it('should throw an error when intent.to does not match ownAddress for EOA destination', async () => {
      const configWithEOADestination = {
        ...mockConfig,
        chains: {
          '1': { providers: ['provider1'] },
          '8453': { providers: ['provider2'] }, // EOA destination (no Zodiac config)
        },
      } as unknown as MarkConfiguration;

      const wrongToAddressIntent = {
        origin: '1',
        destinations: ['8453'],
        to: '0xwrongaddress', // Should be ownAddress for EOA
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      };

      await expect(sendIntents(invoiceId, [wrongToAddressIntent], mockDeps, configWithEOADestination)).rejects.toThrow(
        `intent.to (0xwrongaddress) must be ownAddress (${mockConfig.ownAddress}) for destination 8453`,
      );
    });

    it('should throw an error when intent.to does not match safeAddress for Zodiac destination', async () => {
      const safeAddress = '0x9876543210987654321098765432109876543210';
      const configWithZodiacDestination = {
        ...mockConfig,
        chains: {
          '1': { providers: ['provider1'] },
          '8453': {
            providers: ['provider2'],
            zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
            zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
            gnosisSafeAddress: safeAddress,
          },
        },
      } as unknown as MarkConfiguration;

      const wrongToAddressIntent = {
        origin: '1',
        destinations: ['8453'],
        to: '0xwrongaddress', // Should be safeAddress for Zodiac
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      };

      await expect(
        sendIntents(invoiceId, [wrongToAddressIntent], mockDeps, configWithZodiacDestination),
      ).rejects.toThrow(`intent.to (0xwrongaddress) must be safeAddress (${safeAddress}) for destination 8453`);
    });

    it('should treat chain with only gnosisSafeAddress as EOA (not Zodiac)', async () => {
      const safeAddress = '0x9876543210987654321098765432109876543210';
      const configWithOnlySafeAddress = {
        ...mockConfig,
        chains: {
          '1': { providers: ['provider1'] },
          '8453': {
            providers: ['provider2'],
            gnosisSafeAddress: safeAddress,
            // No zodiacRoleModuleAddress or zodiacRoleKey - should be treated as EOA
          },
        },
      } as unknown as MarkConfiguration;

      const intentToOwnAddress = {
        origin: '1',
        destinations: ['8453'],
        to: mockConfig.ownAddress, // Should validate against ownAddress, not safeAddress
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      };

      // This should pass because the chain is treated as EOA
      const result = await sendIntents(invoiceId, [intentToOwnAddress], mockDeps, configWithOnlySafeAddress);
      expect(result).toHaveLength(1);
    });

    it('should pass validation when intent.to matches ownAddress for EOA destination', async () => {
      const configWithEOADestination = {
        ...mockConfig,
        chains: {
          '1': { providers: ['provider1'] },
          '8453': { providers: ['provider2'] }, // EOA destination
        },
      } as unknown as MarkConfiguration;

      const validEOAIntent = {
        origin: '1',
        destinations: ['8453'],
        to: mockConfig.ownAddress, // Correct for EOA
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      };

      const result = await sendIntents(invoiceId, [validEOAIntent], mockDeps, configWithEOADestination);
      expect(result).toHaveLength(1);
    });

    it('should pass validation when intent.to matches safeAddress for Zodiac destination', async () => {
      const safeAddress = '0x9876543210987654321098765432109876543210';
      const configWithZodiacDestination = {
        ...mockConfig,
        chains: {
          '1': { providers: ['provider1'] },
          '8453': {
            providers: ['provider2'],
            zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
            zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
            gnosisSafeAddress: safeAddress,
          },
        },
      } as unknown as MarkConfiguration;

      const validZodiacIntent = {
        origin: '1',
        destinations: ['8453'],
        to: safeAddress, // Correct for Zodiac
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      };

      const result = await sendIntents(invoiceId, [validZodiacIntent], mockDeps, configWithZodiacDestination);
      expect(result).toHaveLength(1);
    });

    it('should handle case-insensitive token address comparison', async () => {
      const sameTokenDifferentCaseIntents = [
        {
          origin: '1',
          destinations: ['8453'],
          to: mockConfig.ownAddress,
          inputAsset: '0xToken1', // Mixed case
          amount: '1000',
          callData: '0x',
          maxFee: '0',
        },
        {
          origin: '1',
          destinations: ['42161'],
          to: mockConfig.ownAddress,
          inputAsset: '0xTOKEN1', // Different case but same token
          amount: '2000',
          callData: '0x',
          maxFee: '0',
        },
      ];

      // Should not throw error for same token with different cases
      const result = await sendIntents(invoiceId, sameTokenDifferentCaseIntents, mockDeps, mockConfig);
      expect(result).toHaveLength(1);
    });

    it('should validate multiple destinations for the same intent', async () => {
      const safeAddress1 = '0x1111111111111111111111111111111111111111';
      const safeAddress2 = '0x2222222222222222222222222222222222222222';

      const configWithMultipleDestinations = {
        ...mockConfig,
        chains: {
          '1': { providers: ['provider1'] },
          '8453': {
            providers: ['provider2'],
            zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
            zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
            gnosisSafeAddress: safeAddress1,
          },
          '42161': {
            providers: ['provider3'],
            zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
            zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
            gnosisSafeAddress: safeAddress2,
          },
        },
      } as unknown as MarkConfiguration;

      // This should fail because intent.to can only match one safeAddress
      const multiDestinationIntent = {
        origin: '1',
        destinations: ['8453', '42161'], // Multiple destinations with different safe addresses
        to: safeAddress1, // Can only match one
        inputAsset: '0xtoken1',
        amount: '1000',
        callData: '0x',
        maxFee: '0',
      };

      await expect(
        sendIntents(invoiceId, [multiDestinationIntent], mockDeps, configWithMultipleDestinations),
      ).rejects.toThrow(`intent.to (${safeAddress1}) must be safeAddress (${safeAddress2}) for destination 42161`);
    });
  });
});

describe('sendIntentsMulticall', () => {
  let mockIntent: NewIntentParams;
  let mockDeps: MarkAdapters;
  let mockConfig: MarkConfiguration;
  let mockPermit2Functions: {
    generatePermit2Nonce: SinonStub<[], string>;
    generatePermit2Deadline: SinonStub<[], number>;
    getPermit2Signature: SinonStub<
      [
        signer: Web3Signer | Wallet,
        chainId: number,
        token: string,
        spender: string,
        amount: string,
        nonce: string,
        deadline: number,
        config: MarkConfiguration,
      ],
      Promise<string>
    >;
    approvePermit2: SinonStub<
      [tokenAddress: string, chainService: ChainService, config: MarkConfiguration],
      Promise<string>
    >;
  };
  const MOCK_TOKEN1 = '0x1234567890123456789012345678901234567890';
  const MOCK_DEST1 = '0xddddddddddddddddddddddddddddddddddddddd1';
  const MOCK_DEST2 = '0xddddddddddddddddddddddddddddddddddddddd2';
  const MOCK_MULTICALL_ADDRESS = '0xmulticall3';

  beforeEach(async () => {
    mockDeps = {
      everclear: createStubInstance(EverclearAdapter, {
        createNewIntent: stub(),
      }),
      chainService: createStubInstance(ChainService, {
        submitAndMonitor: stub(),
        readTx: stub(),
      }),
      logger: createStubInstance(Logger),
      web3Signer: createStubInstance(Wallet, {
        signTypedData: stub(),
      }),
      purchaseCache: createStubInstance(PurchaseCache),
      rebalance: createStubInstance(RebalanceAdapter),
      prometheus: createStubInstance(PrometheusAdapter),
      database: createMinimalDatabaseMock(),
    };

    mockConfig = {
      ownAddress: '0xdeadbeef1234567890deadbeef1234567890dead',
      chains: {
        '1': {
          providers: ['provider1'],
          deployments: {
            everclear: '0xspoke',
            multicall3: MOCK_MULTICALL_ADDRESS,
            permit2: '0xpermit2address',
          },
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
      generatePermit2Nonce: stub<[], string>().returns('0x123456'),
      generatePermit2Deadline: stub<[], number>().returns(1735689600), // Some future timestamp
      getPermit2Signature: stub<
        [Web3Signer | Wallet, number, string, string, string, string, number, MarkConfiguration],
        Promise<string>
      >().resolves('0xsignature'),
      approvePermit2: stub<[string, ChainService, MarkConfiguration], Promise<string>>().resolves('0xapprovalTx'),
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
    await expect(sendIntentsMulticall([], mockDeps, mockConfig)).rejects.toThrow('No intents provided for multicall');
  });

  it('should handle errors when Permit2 approval fails', async () => {
    // Mock token contract with zero allowance for Permit2
    const tokenContract = {
      address: MOCK_TOKEN1,
      read: {
        allowance: stub().resolves(BigInt('0')), // No allowance for Permit2
      },
    } as unknown as GetContractReturnType;

    stub(contractHelpers, 'getERC20Contract').resolves(
      tokenContract as unknown as Awaited<ReturnType<typeof contractHelpers.getERC20Contract>>,
    );

    // Mock approvePermit2 to throw an error
    const errorMessage = 'Failed to approve Permit2';
    mockPermit2Functions.approvePermit2.rejects(new Error(errorMessage));

    // Create an intent to test
    const intents = [mockIntent];

    // Verify that the error is properly caught, logged, and rethrown
    await expect(sendIntentsMulticall(intents, mockDeps, mockConfig)).rejects.toThrow(errorMessage);

    // Verify that the error was logged with the correct parameters
    expect(
      (mockDeps.logger.error as SinonStub).calledWith('Error signing/submitting Permit2 approval', {
        error: errorMessage,
        chainId: '1',
      }),
    ).toBe(true);
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

    stub(contractHelpers, 'getERC20Contract').resolves(
      tokenContract as unknown as Awaited<ReturnType<typeof contractHelpers.getERC20Contract>>,
    );

    // Mock approvePermit2 to succeed but not actually change the allowance
    const txHash = '0xapprovalTxHash';
    mockPermit2Functions.approvePermit2.resolves(txHash);

    // Create an intent to test
    const intents = [mockIntent];

    // Verify that the error is properly thrown with the expected message
    await expect(sendIntentsMulticall(intents, mockDeps, mockConfig)).rejects.toThrow(
      `Permit2 approval transaction was submitted (${txHash}) but allowance is still zero`,
    );
  });

  it('should handle errors when signing Permit2 message or fetching transaction data', async () => {
    // Mock token contract with sufficient allowance for Permit2
    const tokenContract = {
      address: MOCK_TOKEN1,
      read: {
        allowance: stub().resolves(BigInt('1000000000000000000')), // Already approved for Permit2
      },
    } as unknown as GetContractReturnType;

    stub(contractHelpers, 'getERC20Contract').resolves(
      tokenContract as unknown as Awaited<ReturnType<typeof contractHelpers.getERC20Contract>>,
    );

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
        to: MOCK_DEST2,
      },
    ];

    // Verify that the error is properly caught, logged, and rethrown
    await expect(sendIntentsMulticall(intents, mockDeps, mockConfig)).rejects.toThrow(errorMessage);

    // Verify that the error was logged with the correct parameters
    expect(
      (mockDeps.logger.error as SinonStub).calledWith('Error signing Permit2 message or fetching transaction data', {
        error: errorMessage,
        tokenAddress: MOCK_TOKEN1,
        spender: '0xspoke',
        amount: '1000',
        nonce: '0x123456',
        deadline: '1735689600',
      }),
    ).toBe(true);
  });

  it('should add 0x prefix to nonce when it does not have one', async () => {
    // Mock token contract with sufficient allowance for Permit2
    const tokenContract = {
      address: MOCK_TOKEN1,
      read: {
        allowance: stub().resolves(BigInt('1000000000000000000')), // Already approved for Permit2
      },
    } as unknown as GetContractReturnType;

    stub(contractHelpers, 'getERC20Contract').resolves(
      tokenContract as unknown as Awaited<ReturnType<typeof contractHelpers.getERC20Contract>>,
    );

    // Return a nonce without 0x prefix
    mockPermit2Functions.generatePermit2Nonce.returns('123456');

    // Mock getPermit2Signature to succeed
    mockPermit2Functions.getPermit2Signature.resolves('0xsignature');

    // Mock everclear.createNewIntent to return valid transaction data
    (mockDeps.everclear.createNewIntent as SinonStub).callsFake((intentWithPermit) => {
      // Verify that the nonce has been prefixed with 0x
      // The nonce will have the index suffix (00) appended to it
      expect(intentWithPermit.permit2Params.nonce).toBe('0x12345600');
      return Promise.resolve({
        to: zeroAddress,
        data: '0xintentdata',
        chainId: 1,
      });
    });

    // Mock chainService to return a successful receipt
    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xmulticallTx',
      cumulativeGasUsed: 200000n,
      effectiveGasPrice: 5n,
      logs: [
        {
          topics: [
            '0x5c5c7ce44a0165f76ea4e0a89f0f7ac5cce7b2c1d1b91d0f49c1f219656b7d8c',
            '0x0000000000000000000000000000000000000000000000000000000000000001',
            '0x0000000000000000000000000000000000000000000000000000000000000002',
          ],
          data: '0x000000000000000000000000000000000000000000000000000000000000074d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000015a7ca97d1ed168fb34a4055cefa2e2f9bdb6c75000000000000000000000000b60d0c2e8309518373b40f8eaa2cad0d1de3decb000000000000000000000000fde4c96c8593536e31f229ea8f37b2ada2699bb2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002105000000000000000000000000000000000000000000000000000000000000074d0000000000000000000000000000000000000000000000000000000067f1620f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000a86a0000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000a4b1000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    });

    // Call the function with a single intent
    await sendIntentsMulticall([mockIntent], mockDeps, mockConfig);

    // Verify that createNewIntent was called with the correct parameters
    expect((mockDeps.everclear.createNewIntent as SinonStub).called).toBe(true);
  });

  it('should prepare and send a multicall transaction with multiple intents', async () => {
    // Mock token contract with sufficient allowance for Permit2
    const tokenContract = {
      address: MOCK_TOKEN1,
      read: {
        allowance: stub().resolves(BigInt('1000000000000000000')), // Already approved for Permit2
      },
    } as unknown as GetContractReturnType;

    stub(contractHelpers, 'getERC20Contract').resolves(
      tokenContract as unknown as Awaited<ReturnType<typeof contractHelpers.getERC20Contract>>,
    );

    // Mock everclear.createNewIntent to return valid transaction data
    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xintentdata',
      chainId: 1,
    });

    // Mock chainService to return a successful receipt with intent IDs in logs
    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xmulticallTx',
      cumulativeGasUsed: 200000n,
      effectiveGasPrice: 5n,
      logs: [
        createMockTransactionReceipt(
          '0xmulticallTx',
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        ).logs[0],
        createMockTransactionReceipt(
          '0xmulticallTx',
          '0x0000000000000000000000000000000000000000000000000000000000000002',
        ).logs[0],
      ],
    });

    // Create two intents with different destinations
    const intents = [
      { ...mockIntent, to: MOCK_DEST1 },
      { ...mockIntent, to: MOCK_DEST2 },
    ];

    const result = await sendIntentsMulticall(intents, mockDeps, mockConfig);

    // Verify the structure of the result
    expect(result).toEqual({
      transactionHash: '0xmulticallTx',
      chainId: '1',
      intentId: MOCK_DEST1,
    });

    // Verify everclear.createNewIntent was called for each intent
    expect((mockDeps.everclear.createNewIntent as SinonStub).callCount).toBe(2);

    // Verify chainService.submitAndMonitor was called with multicall data
    expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).toBe(1);
    const submitCall = (mockDeps.chainService.submitAndMonitor as SinonStub).firstCall.args[1];
    expect(submitCall.to).toBe(MOCK_MULTICALL_ADDRESS);

    // Verify prometheus metrics were updated
    expect((mockDeps.prometheus.updateGasSpent as SinonStub).calledOnce).toBe(true);
  });

  it('should construct the correct multicall payload from multiple intents', async () => {
    // Mock token contract with sufficient allowance
    const tokenContract = {
      address: MOCK_TOKEN1,
      read: {
        allowance: stub().resolves(BigInt('1000000000000000000')),
      },
    } as unknown as GetContractReturnType;

    stub(contractHelpers, 'getERC20Contract').resolves(
      tokenContract as unknown as Awaited<ReturnType<typeof contractHelpers.getERC20Contract>>,
    );

    // Mock intent creation to return different data for each intent
    const intentData = [
      { to: zeroAddress, data: '0xintent1data', chainId: 1 },
      { to: zeroAddress, data: '0xintent2data', chainId: 1 },
    ];

    const createNewIntentStub = mockDeps.everclear.createNewIntent as SinonStub;
    createNewIntentStub.onFirstCall().resolves(intentData[0]);
    createNewIntentStub.onSecondCall().resolves(intentData[1]);

    // Mock successful transaction submission
    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xmulticallTx',
      cumulativeGasUsed: 200000n,
      effectiveGasPrice: 5n,
      logs: [],
    });

    const intents = [
      { ...mockIntent, to: MOCK_DEST1 },
      { ...mockIntent, to: MOCK_DEST2 },
    ];

    await sendIntentsMulticall(intents, mockDeps, mockConfig);

    // Check that chainService was called with correct multicall data
    const submitCall = (mockDeps.chainService.submitAndMonitor as SinonStub).firstCall.args[1];

    // The multicall should contain both intent calls
    expect(submitCall.to).toBe(MOCK_MULTICALL_ADDRESS);
    // The data should be a multicall encoding containing both intent data
    const data = submitCall.data;
    expect(data).toMatch(/^0x/); // Should be hex
    // Both intent data strings should be included in the multicall data
    expect(data.includes('0xintent1data'.substring(2))).toBe(true);
    expect(data.includes('0xintent2data'.substring(2))).toBe(true);
  });

  it('should throw an error if chainService.submitAndMonitor fails', async () => {
    // Mock token contract with sufficient allowance
    const tokenContract = {
      address: MOCK_TOKEN1,
      read: {
        allowance: stub().resolves(BigInt('1000000000000000000')),
      },
    } as unknown as GetContractReturnType;

    stub(contractHelpers, 'getERC20Contract').resolves(
      tokenContract as unknown as Awaited<ReturnType<typeof contractHelpers.getERC20Contract>>,
    );

    // Mock intent creation success
    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: zeroAddress,
      data: '0xintentdata',
      chainId: 1,
    });

    // Mock transaction submission failure
    const txError = new Error('Transaction failed');
    (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(txError);

    const intents = [{ ...mockIntent, inputAsset: MOCK_TOKEN1 }];

    // The function passes through the original error
    await expect(sendIntentsMulticall(intents, mockDeps, mockConfig)).rejects.toThrow(txError);

    // Verify the error was logged
    expect((mockDeps.logger.error as SinonStub).calledWith('Failed to submit multicall transaction')).toBe(true);
  });
});
