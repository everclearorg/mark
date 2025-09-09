import { stub, createStubInstance, SinonStubbedInstance, SinonStub, restore as sinonRestore } from 'sinon';
import {
  INTENT_ADDED_TOPIC0,
  sendIntents,
} from '../../src/helpers/intent';
import { LookupTableNotFoundError } from '@mark/everclear';
import { MarkConfiguration, NewIntentParams, TransactionSubmissionType } from '@mark/core';
import { Logger } from '@mark/logger';
import { Log, TransactionReceipt, zeroAddress } from 'viem';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { MarkAdapters } from '../../src/init';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { RebalanceAdapter } from '@mark/rebalance';
import { createMinimalDatabaseMock } from '../mocks/database';
import { Web3Signer } from '@mark/web3signer';
import * as contractHelpers from '../../src/helpers/contracts';

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
      web3Signer: createStubInstance(Web3Signer, {
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

describe('SVM Chain Handling', () => {
  let mockDeps: SinonStubbedInstance<MarkAdapters>;
  let mockConfig: MarkConfiguration;
  const invoiceId = '0xmockinvoice';
  const requestId = 'test-request-id';

  beforeEach(() => {
    mockDeps = {
      everclear: createStubInstance(EverclearAdapter, {
        solanaCreateNewIntent: stub(),
        solanaCreateLookupTable: stub(),
        getMinAmounts: stub(),
      }),
      chainService: createStubInstance(ChainService, {
        submitAndMonitor: stub(),
        deriveProgramAddress: stub(),
      }),
      logger: createStubInstance(Logger),
      web3Signer: createStubInstance(Web3Signer),
      purchaseCache: createStubInstance(PurchaseCache),
      rebalance: createStubInstance(RebalanceAdapter),
      prometheus: createStubInstance(PrometheusAdapter),
      database: createMinimalDatabaseMock(),
    };

    mockConfig = {
      ownSolAddress: 'SolanaAddressExample123456789012345678901234',
      chains: {
        '1399811149': { // SVM chain ID (Solana)
          providers: ['solana-provider'],
          deployments: {
            everclear: '0x1234567890123456789012345678901234567890123456789012345678901234',
          },
        },
      },
    } as unknown as MarkConfiguration;
  });

  afterEach(() => {
    sinonRestore();
  });

  it('should handle SVM intents successfully', async () => {
    const svmIntent: NewIntentParams = {
      origin: '1399811149', // SVM chain
      destinations: ['1'],
      to: mockConfig.ownSolAddress,
      inputAsset: 'SolanaTokenAddress123456789012345678901234',
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.everclear.solanaCreateNewIntent as SinonStub).resolves({
      to: 'SolanaContractAddress',
      data: 'solana-tx-data',
      value: '0',
    });

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '1399811149': '500000' }
    });

    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xsolanatxhash',
    });

    const result = await sendIntents(invoiceId, [svmIntent], mockDeps, mockConfig, requestId);

    expect(result).toHaveLength(1);
    expect(result[0].transactionHash).toBe('0xsolanatxhash');
    expect(result[0].chainId).toBe('1399811149');
    expect((mockDeps.everclear.solanaCreateNewIntent as SinonStub).called).toBe(true);
  });

  it('should handle lookup table creation for SVM intents when LookupTableNotFoundError occurs', async () => {
    const svmIntent: NewIntentParams = {
      origin: '1399811149',
      destinations: ['1'],
      to: mockConfig.ownSolAddress,
      inputAsset: 'SolanaTokenAddress123456789012345678901234',
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    // First call fails with LookupTableNotFoundError, then succeeds
    (mockDeps.everclear.solanaCreateNewIntent as SinonStub)
      .onFirstCall().rejects(new LookupTableNotFoundError('Lookup table not found'))
      .onSecondCall().resolves({
        to: 'SolanaContractAddress',
        data: 'solana-tx-data',
        value: '0',
      });

    (mockDeps.everclear.solanaCreateLookupTable as SinonStub).resolves({
      to: 'LookupTableContract',
      data: 'lookup-table-data',
      value: '0',
    });

    (mockDeps.chainService.deriveProgramAddress as SinonStub)
      .onFirstCall().resolves(['userTokenAccount'])
      .onSecondCall().resolves(['programVault'])
      .onThirdCall().resolves(['programVaultAccount']);

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '1399811149': '500000' }
    });

    (mockDeps.chainService.submitAndMonitor as SinonStub)
      .onFirstCall().resolves({ transactionHash: '0xlookuptablehash' }) // Lookup table creation
      .onSecondCall().resolves({ transactionHash: '0xsolanatxhash' }); // Intent creation

    const result = await sendIntents(invoiceId, [svmIntent], mockDeps, mockConfig, requestId);

    expect(result).toHaveLength(1);
    expect((mockDeps.everclear.solanaCreateLookupTable as SinonStub).called).toBe(true);
    expect((mockDeps.chainService.submitAndMonitor as SinonStub).callCount).toBe(2);
  });

  it('should handle SVM intents with different input assets error', async () => {
    const svmIntents: NewIntentParams[] = [
      {
        origin: '1399811149',
        destinations: ['1'],
        to: mockConfig.ownSolAddress,
        inputAsset: 'SolanaToken1',
        amount: '1000000',
        callData: '0x',
        maxFee: '0',
      },
      {
        origin: '1399811149',
        destinations: ['1'],
        to: mockConfig.ownSolAddress,
        inputAsset: 'SolanaToken2', // Different input asset
        amount: '1000000',
        callData: '0x',
        maxFee: '0',
      }
    ];

    await expect(sendIntents(invoiceId, svmIntents, mockDeps, mockConfig, requestId))
      .rejects.toThrow('Cannot process multiple intents with different input assets');
  });

  it('should handle SVM intent min amount warning', async () => {
    const svmIntent: NewIntentParams = {
      origin: '1399811149',
      destinations: ['1'],
      to: mockConfig.ownSolAddress,
      inputAsset: 'SolanaTokenAddress123456789012345678901234',
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.everclear.solanaCreateNewIntent as SinonStub).resolves({
      to: 'SolanaContractAddress',
      data: 'solana-tx-data',
      value: '0',
    });

    // Min amount is smaller than intent amount (reversed condition to trigger warning)
    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '1399811149': '500000' } // smaller than 1000000
    });

    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xsolanatxhash',
    });

    const result = await sendIntents(invoiceId, [svmIntent], mockDeps, mockConfig, requestId);

    expect(result).toHaveLength(1);
    expect((mockDeps.logger.warn as SinonStub).called).toBe(true);
  });

  it('should rethrow non-LookupTableNotFoundError from SVM intent creation', async () => {
    const svmIntent: NewIntentParams = {
      origin: '1399811149',
      destinations: ['1'],
      to: mockConfig.ownSolAddress,
      inputAsset: 'SolanaTokenAddress123456789012345678901234',
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    const apiError = new Error('API connection failed');
    (mockDeps.everclear.solanaCreateNewIntent as SinonStub).rejects(apiError);

    await expect(sendIntents(invoiceId, [svmIntent], mockDeps, mockConfig, requestId))
      .rejects.toThrow('API connection failed');
  });
});

describe('TVM Chain Handling', () => {
  let mockDeps: SinonStubbedInstance<MarkAdapters>;
  let mockConfig: MarkConfiguration;
  const invoiceId = '0xmockinvoice';
  const requestId = 'test-request-id';

  beforeEach(() => {
    mockDeps = {
      everclear: createStubInstance(EverclearAdapter, {
        tronCreateNewIntent: stub(),
        getMinAmounts: stub(),
      }),
      chainService: createStubInstance(ChainService, {
        submitAndMonitor: stub(),
        readTx: stub(),
        getAddress: stub(),
      }),
      logger: createStubInstance(Logger),
      web3Signer: createStubInstance(Web3Signer),
      purchaseCache: createStubInstance(PurchaseCache),
      rebalance: createStubInstance(RebalanceAdapter),
      prometheus: createStubInstance(PrometheusAdapter),
      database: createMinimalDatabaseMock(),
    };

    mockConfig = {
      ownAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      chains: {
        '728126428': { // TVM chain ID for Tron
          providers: ['tron-provider'],
          deployments: {
            everclear: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          },
        },
      },
    } as unknown as MarkConfiguration;
  });

  afterEach(() => {
    sinonRestore();
  });

  it('should handle TVM intents successfully', async () => {
    const tvmIntent: NewIntentParams = {
      origin: '728126428', // TVM chain
      destinations: ['1'],
      to: mockConfig.ownAddress,
      inputAsset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT on Tron
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.chainService.getAddress as SinonStub).resolves({
      '728126428': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    });

    (mockDeps.everclear.tronCreateNewIntent as SinonStub).resolves({
      to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      data: 'tron-tx-data',
      value: '0',
    });

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '728126428': BigInt(tvmIntent.amount).toString() }
    });

    // Mock successful allowance check (sufficient allowance)
    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000f4240'; // 1000000n in hex
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xtrontxhash',
      cumulativeGasUsed: '100000',
      effectiveGasPrice: '10000000000',
      logs: [{
        topics: [
          INTENT_ADDED_TOPIC0 as `0x${string}`,
          '0x0000000000000000000000000000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000000000000000000000000000002'
        ],
        data: '0x000000000000000000000000000000000000000000000000000000000000074d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000015a7ca97d1ed168fb34a4055cefa2e2f9bdb6c75000000000000000000000000b60d0c2e8309518373b40f8eaa2cad0d1de3decb000000000000000000000000fde4c96c8593536e31f229ea8f37b2ada2699bb2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002105000000000000000000000000000000000000000000000000000000000000074d0000000000000000000000000000000000000000000000000000000067f1620f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000a86a0000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000a4b1000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000'
      }]
    });

    const result = await sendIntents(invoiceId, [tvmIntent], mockDeps, mockConfig, requestId);

    expect(result).toHaveLength(1);
    expect(result[0].transactionHash).toBe('0xtrontxhash');
    expect(result[0].chainId).toBe('728126428');
    expect((mockDeps.everclear.tronCreateNewIntent as SinonStub).called).toBe(true);
  });

  it('should handle TVM intents with different input assets error', async () => {
    const tvmIntents: NewIntentParams[] = [
      {
        origin: '728126428',
        destinations: ['1'],
        to: mockConfig.ownAddress,
        inputAsset: 'TronToken1',
        amount: '1000000',
        callData: '0x',
        maxFee: '0',
      },
      {
        origin: '728126428',
        destinations: ['1'],
        to: mockConfig.ownAddress,
        inputAsset: 'TronToken2', // Different input asset
        amount: '1000000',
        callData: '0x',
        maxFee: '0',
      }
    ];

    await expect(sendIntents(invoiceId, tvmIntents, mockDeps, mockConfig, requestId))
      .rejects.toThrow('Cannot process multiple intents with different input assets');
  });

  it('should handle TVM intents with Zodiac destination validation', async () => {
    const safeAddress = '0x9876543210987654321098765432109876543210';
    const configWithZodiac = {
      ...mockConfig,
      chains: {
        ...mockConfig.chains,
        '1': {
          providers: ['provider1'],
          assets: [],
          invoiceAge: 3600,
          gasThreshold: '1000000000000000000',
          deployments: {
            everclear: '0x1234567890123456789012345678901234567890',
          },
          zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
          zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
          gnosisSafeAddress: safeAddress,
        },
      },
    } as unknown as MarkConfiguration;

    const tvmIntent: NewIntentParams = {
      origin: '728126428',
      destinations: ['1'], // Zodiac destination
      to: safeAddress, // Must match safe address for Zodiac destination
      inputAsset: 'TronToken1',
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.chainService.getAddress as SinonStub).resolves({
      '728126428': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    });

    (mockDeps.everclear.tronCreateNewIntent as SinonStub).resolves({
      to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      data: 'tron-tx-data',
      value: '0',
    });

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '728126428': BigInt(tvmIntent.amount).toString() }
    });

    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000f4240';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xtrontxhash',
      cumulativeGasUsed: '100000',
      effectiveGasPrice: '10000000000',
      logs: [{
        topics: [
          INTENT_ADDED_TOPIC0 as `0x${string}`,
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ],
        data: '0x000000000000000000000000000000000000000000000000000000000000074d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000015a7ca97d1ed168fb34a4055cefa2e2f9bdb6c75000000000000000000000000b60d0c2e8309518373b40f8eaa2cad0d1de3decb000000000000000000000000fde4c96c8593536e31f229ea8f37b2ada2699bb2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002105000000000000000000000000000000000000000000000000000000000000074d0000000000000000000000000000000000000000000000000000000067f1620f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000a86a0000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000a4b1000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000'
      }]
    });

    const result = await sendIntents(invoiceId, [tvmIntent], mockDeps, configWithZodiac, requestId);
    expect(result).toHaveLength(1);
  });

  it('should handle TVM intents with approval error', async () => {
    const tvmIntent: NewIntentParams = {
      origin: '728126428',
      destinations: ['1'],
      to: mockConfig.ownAddress,
      inputAsset: 'TronToken1',
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.chainService.getAddress as SinonStub).resolves({
      '728126428': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    });

    (mockDeps.everclear.tronCreateNewIntent as SinonStub).resolves({
      to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      data: 'tron-tx-data',
      value: '0',
    });

    // Mock insufficient allowance
    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000001f4'; // 500n in hex
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    // Mock approval failure
    (mockDeps.chainService.submitAndMonitor as SinonStub).rejects(new Error('TRC20 approval failed'));

    await expect(sendIntents(invoiceId, [tvmIntent], mockDeps, mockConfig, requestId))
      .rejects.toThrow('TRC20 approval failed');

    expect((mockDeps.logger.error as SinonStub).calledWith('Failed to approve TRC20 on Tron')).toBe(true);
  });

  it('should handle TVM intents with multiple intents warning (only processes first)', async () => {
    const tvmIntents: NewIntentParams[] = [
      {
        origin: '728126428',
        destinations: ['1'],
        to: mockConfig.ownAddress,
        inputAsset: 'TronToken1',
        amount: '1000000',
        callData: '0x',
        maxFee: '0',
      },
      {
        origin: '728126428',
        destinations: ['2'],
        to: mockConfig.ownAddress,
        inputAsset: 'TronToken1', // Same token
        amount: '2000000',
        callData: '0x',
        maxFee: '0',
      }
    ];

    (mockDeps.chainService.getAddress as SinonStub).resolves({
      '728126428': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    });

    (mockDeps.everclear.tronCreateNewIntent as SinonStub).resolves({
      to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      data: 'tron-tx-data',
      value: '0',
    });

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '728126428': tvmIntents[0].amount }
    });

    const encodedAllowance = '0x00000000000000000000000000000000000000000000003635c9adc5dea00000'; // Large allowance
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xtrontxhash',
      cumulativeGasUsed: '100000',
      effectiveGasPrice: '10000000000',
      logs: [{
        topics: [
          INTENT_ADDED_TOPIC0 as `0x${string}`,
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ],
        data: '0x000000000000000000000000000000000000000000000000000000000000074d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000015a7ca97d1ed168fb34a4055cefa2e2f9bdb6c75000000000000000000000000b60d0c2e8309518373b40f8eaa2cad0d1de3decb000000000000000000000000fde4c96c8593536e31f229ea8f37b2ada2699bb2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002105000000000000000000000000000000000000000000000000000000000000074d0000000000000000000000000000000000000000000000000000000067f1620f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000a86a0000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000a4b1000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000'
      }]
    });

    const result = await sendIntents(invoiceId, tvmIntents, mockDeps, mockConfig, requestId);

    expect(result).toHaveLength(1); // Only first intent processed
    expect((mockDeps.logger.warn as SinonStub).calledWith('Tron API currently only supports single intents, processing first intent only')).toBe(true);
  });

  it('should handle TVM intents with gas metrics update failure', async () => {
    const tvmIntent: NewIntentParams = {
      origin: '728126428',
      destinations: ['1'],
      to: mockConfig.ownAddress,
      inputAsset: 'TronToken1',
      amount: '1000000',
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.chainService.getAddress as SinonStub).resolves({
      '728126428': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    });

    (mockDeps.everclear.tronCreateNewIntent as SinonStub).resolves({
      to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      data: 'tron-tx-data',
      value: '0',
    });

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '728126428': tvmIntent.amount }
    });

    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000f4240';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xtrontxhash',
      cumulativeGasUsed: '100000',
      effectiveGasPrice: '10000000000',
      logs: [{
        topics: [
          INTENT_ADDED_TOPIC0 as `0x${string}`,
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ],
        data: '0x000000000000000000000000000000000000000000000000000000000000074d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000015a7ca97d1ed168fb34a4055cefa2e2f9bdb6c75000000000000000000000000b60d0c2e8309518373b40f8eaa2cad0d1de3decb000000000000000000000000fde4c96c8593536e31f229ea8f37b2ada2699bb2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002105000000000000000000000000000000000000000000000000000000000000074d0000000000000000000000000000000000000000000000000000000067f1620f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000a86a0000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000a4b1000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000'
      }]
    });

    // Mock prometheus to throw an error
    (mockDeps.prometheus.updateGasSpent as SinonStub).throws(new Error('Prometheus update failed'));

    const result = await sendIntents(invoiceId, [tvmIntent], mockDeps, mockConfig, requestId);

    expect(result).toHaveLength(1);
    expect((mockDeps.logger.warn as SinonStub).calledWith('Failed to update gas spent')).toBe(true);
  });
});

describe('Destination Validation for SVM Chains', () => {
  let mockDeps: SinonStubbedInstance<MarkAdapters>;
  let mockConfig: MarkConfiguration;
  const invoiceId = '0xmockinvoice';
  const requestId = 'test-request-id';

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
      web3Signer: createStubInstance(Web3Signer),
      purchaseCache: createStubInstance(PurchaseCache),
      rebalance: createStubInstance(RebalanceAdapter),
      prometheus: createStubInstance(PrometheusAdapter),
      database: createMinimalDatabaseMock(),
    };

    mockConfig = {
      ownAddress: '0xdeadbeef1234567890deadbeef1234567890dead',
      ownSolAddress: 'SolanaAddressExample123456789012345678901234',
      chains: {
        '1': {
          providers: ['eth-provider'],
        },
        '1399811149': { // SVM destination
          providers: ['solana-provider'],
        },
      },
    } as unknown as MarkConfiguration;
  });

  afterEach(() => {
    sinonRestore();
  });

  it('should validate intent.to matches ownSolAddress for SVM destination', async () => {
    const evmToSvmIntent: NewIntentParams = {
      origin: '1', // EVM origin
      destinations: ['1399811149'], // SVM destination
      to: mockConfig.ownSolAddress, // Should be ownSolAddress for SVM destination
      inputAsset: '0xtoken1',
      amount: '1000',
      callData: '0x',
      maxFee: '0',
    };

    (mockDeps.everclear.createNewIntent as SinonStub).resolves({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xdata',
      value: '0',
    });

    (mockDeps.everclear.getMinAmounts as SinonStub).resolves({
      minAmounts: { '1': '500' }
    });

    const encodedAllowance = '0x00000000000000000000000000000000000000000000000000000000000007d0';
    (mockDeps.chainService.readTx as SinonStub).resolves(encodedAllowance);

    (mockDeps.chainService.submitAndMonitor as SinonStub).resolves({
      transactionHash: '0xevmtxhash',
      cumulativeGasUsed: 100n,
      effectiveGasPrice: 1n,
      logs: [{
        topics: [
          INTENT_ADDED_TOPIC0 as `0x${string}`,
          '0x0000000000000000000000000000000000000000000000000000000000000001'
        ],
        data: '0x000000000000000000000000000000000000000000000000000000000000074d000000000000000000000000000000000000000000000000000000000000004000000000000000000000000015a7ca97d1ed168fb34a4055cefa2e2f9bdb6c75000000000000000000000000b60d0c2e8309518373b40f8eaa2cad0d1de3decb000000000000000000000000fde4c96c8593536e31f229ea8f37b2ada2699bb2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002105000000000000000000000000000000000000000000000000000000000000074d0000000000000000000000000000000000000000000000000000000067f1620f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000a86a0000000000000000000000000000000000000000000000000000000000000089000000000000000000000000000000000000000000000000000000000000a4b1000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000'
      }]
    });

    const result = await sendIntents(invoiceId, [evmToSvmIntent], mockDeps, mockConfig, requestId);
    expect(result).toHaveLength(1);
  });

  it('should throw error when intent.to does not match ownSolAddress for SVM destination', async () => {
    const evmToSvmIntent: NewIntentParams = {
      origin: '1', // EVM origin
      destinations: ['1399811149'], // SVM destination
      to: 'WrongSolanaAddress123456789012345678901', // Wrong address for SVM destination
      inputAsset: '0xtoken1',
      amount: '1000',
      callData: '0x',
      maxFee: '0',
    };

    await expect(sendIntents(invoiceId, [evmToSvmIntent], mockDeps, mockConfig, requestId))
      .rejects.toThrow(`intent.to (WrongSolanaAddress123456789012345678901) must be ownSolAddress (${mockConfig.ownSolAddress}) for destination 1399811149`);
  });

  it('should validate intent destinations length for SVM destination', async () => {
    const evmToSvmIntent: NewIntentParams = {
      origin: '1', // EVM origin
      destinations: ['1399811149', '42161'], // Multiple destinations including SVM - should fail
      to: mockConfig.ownSolAddress,
      inputAsset: '0xtoken1',
      amount: '1000',
      callData: '0x',
      maxFee: '0',
    };

    await expect(sendIntents(invoiceId, [evmToSvmIntent], mockDeps, mockConfig, requestId))
      .rejects.toThrow('intent.destination must be length 1 for intents towards SVM');
  });
});
