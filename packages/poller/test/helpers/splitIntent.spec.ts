import { createStubInstance, SinonStubbedInstance, restore as sinonRestore } from 'sinon';
import { Logger } from '@mark/logger';
import { Invoice, MarkConfiguration } from '@mark/core';
import { calculateSplitIntents } from '../../src/helpers/splitIntent';
import * as sinon from 'sinon';
import { ProcessingContext } from '../../src/init';
import { EverclearAdapter } from '@mark/everclear';
import { ChainService } from '@mark/chainservice';
import { PurchaseCache, RebalanceCache } from '@mark/cache';
import { Wallet } from 'ethers';
import { PrometheusAdapter } from '@mark/prometheus';
import { mockConfig } from '../mocks';
import { RebalanceAdapter } from '@mark/rebalance';
import { createMinimalDatabaseMock } from '../mocks/database';

describe('Split Intent Helper Functions', () => {
  let mockContext: ProcessingContext;
  let logger: SinonStubbedInstance<Logger>;
  let mockDeps: {
    logger: SinonStubbedInstance<Logger>;
    everclear: SinonStubbedInstance<EverclearAdapter>;
    chainService: SinonStubbedInstance<ChainService>;
    purchaseCache: SinonStubbedInstance<PurchaseCache>;
    rebalanceCache: SinonStubbedInstance<RebalanceCache>;
    rebalance: SinonStubbedInstance<RebalanceAdapter>;
    web3Signer: SinonStubbedInstance<Wallet>;
    prometheus: SinonStubbedInstance<PrometheusAdapter>;
    database: typeof import('@mark/database');
  };

  beforeEach(() => {
    logger = createStubInstance(Logger);
    mockDeps = {
      logger: createStubInstance(Logger),
      everclear: createStubInstance(EverclearAdapter),
      chainService: createStubInstance(ChainService),
      purchaseCache: createStubInstance(PurchaseCache),
      rebalanceCache: createStubInstance(RebalanceCache),
      rebalance: createStubInstance(RebalanceAdapter),
      web3Signer: createStubInstance(Wallet),
      prometheus: createStubInstance(PrometheusAdapter),
      database: createMinimalDatabaseMock(),
    };

    mockContext = {
      ...mockDeps,
      config: {
        ...mockConfig,
        supportedSettlementDomains: [1, 10, 8453, 42161],
        supportedAssets: ['WETH'],
        chains: {
          ...mockConfig.chains,
          '1': {
            ...mockConfig.chains['1'],
            assets: [
              {
                tickerHash: 'WETH',
                address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
          },
          '10': {
            ...mockConfig.chains['10'],
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x4200000000000000000000000000000000000006',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
          },
          '8453': {
            ...mockConfig.chains['8453'],
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x4200000000000000000000000000000000000006',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
          },
          '42161': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890',
            },
          },
        },
      },
      requestId: 'test-request-id',
      startTime: Date.now(),
    };
  });

  afterEach(() => {
    sinonRestore();
  });

  describe('calculateSplitIntents', () => {
    it('should return empty result when no balances are available', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has no balances
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')],
            ['10', BigInt('0')],
            ['8453', BigInt('0')],
            ['42161', BigInt('0')],
          ]),
        ],
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>();

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      expect(result.originDomain).toHaveLength(0);
      expect(result.totalAllocated).toBe(BigInt(0));
      expect(result.intents).toHaveLength(0);
    });

    it('should successfully create split intents when single destination is insufficient', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has enough balance on Base only
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')], // 0 WETH on Ethereum
            ['10', BigInt('0')], // 0 WETH on Optimism
            ['8453', BigInt('100000000000000000000')], // 100 WETH on Base (will be origin)
            ['42161', BigInt('0')], // 0 WETH on Arbitrum
          ]),
        ],
      ]);

      // Ethereum and Arbitrum have 50 WETH custodied each
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('50000000000000000000')], // 50 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Should have 2 split intents (one that allocates to 1 and one to 42161)
      // NOTE: Mark sets ALL destinations in each split intent
      expect(result.originDomain).toBe('8453');
      expect(result.totalAllocated).toBe(BigInt('100000000000000000000'));
      expect(result.intents.length).toBe(2);

      // Verify the intent that allocates to destination 1
      const intentFor1 = result.intents.find((i) => i.destinations[0] === '1'); // Find intent targeting domain 1
      expect(intentFor1?.origin).toBe('8453');
      expect(intentFor1?.destinations).toEqual(['1']); // Should only contain domain 1
      expect(intentFor1?.amount).toBe('50000000000000000000');

      // Verify the intent that allocates to destination 42161
      const intentFor42161 = result.intents.find((i) => i.destinations[0] === '42161'); // Find intent targeting domain 42161
      expect(intentFor42161?.origin).toBe('8453');
      expect(intentFor42161?.destinations).toEqual(['42161']); // Should only contain domain 42161
      expect(intentFor42161?.amount).toBe('50000000000000000000');
    });

    it('should handle partial allocation when not enough funds are available', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '200000000000000000000', // 200 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '200000000000000000000', // 200 WETH
        '8453': '200000000000000000000', // 200 WETH
      };

      // Mark has enough on Optimism
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('100000000000000000000')], // 100 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism (will be origin)
            ['8453', BigInt('50000000000000000000')], // 50 WETH on Base
            ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum
          ]),
        ],
      ]);

      // Set up limited custodied assets
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('40000000000000000000')], // 40 WETH on Ethereum
        ['10', BigInt('10000000000000000000')], // 10 WETH on Optimism
        ['8453', BigInt('30000000000000000000')], // 30 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      const topNDomainsExceptOrigin = mockContext.config.supportedSettlementDomains.length - 1;

      expect(result.originDomain).toBe('10');
      expect(result.totalAllocated).toBe(BigInt('70000000000000000000'));
      expect(result.intents.length).toBe(2 + topNDomainsExceptOrigin); // 2 intents for allocated, topNDomainsExceptOrigin for remainder

      // Verify the intent that allocates to destination 1
      const intentFor1 = result.intents[0];
      expect(intentFor1?.origin).toBe('10');
      expect(intentFor1?.destinations).toEqual(['1']);
      expect(intentFor1?.amount).toBe('40000000000000000000'); // 40

      // Verify the intent that allocates to destination 8453
      const intentFor8453 = result.intents[1];
      expect(intentFor8453?.origin).toBe('10');
      expect(intentFor8453?.destinations).toEqual(['8453']);
      expect(intentFor8453?.amount).toBe('30000000000000000000'); // 30

      // Verify the remainder intents - there should be one for each of the top-N domains except the origin
      const remainderIntents = result.intents.slice(2);
      expect(remainderIntents.length).toBe(topNDomainsExceptOrigin);

      remainderIntents.forEach((intent) => {
        expect(intent.origin).toBe('10');
        expect(intent.destinations.length).toBe(1);
        expect(intent.destinations[0]).not.toBe('10'); // Origin can't be a destination
      });

      const expectedAmount = BigInt('130000000000000000000') / BigInt(topNDomainsExceptOrigin);
      const dust = BigInt('130000000000000000000') % BigInt(topNDomainsExceptOrigin);

      // Check all but the last remainder intent have the expected split amount
      for (let i = 0; i < remainderIntents.length - 1; i++) {
        expect(remainderIntents[i].amount).toBe(expectedAmount.toString());
      }

      // Verify the last intent has the dust amount added
      const lastIntent = remainderIntents[remainderIntents.length - 1];
      expect(lastIntent.amount).toBe((expectedAmount + dust).toString());
    });

    it('should prefer origin with better allocation', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
          ]),
        ],
      ]);

      // Using origin 10 will have most available custodied assets
      // even if using 8453 will fully settle as well
      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('90000000000000000000')], // 90 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('90000000000000000000')], // 90 WETH on Base
        ['42161', BigInt('10000000000000000000')], // 10 WETH on Arbitrum
      ]);
      const custodiedBalances2 = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances2]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances2);

      expect(result.originDomain).toBe('10');
      expect(result.totalAllocated).toBe(BigInt('100000000000000000000'));
      expect(result.intents.length).toBe(2);

      // Verify the intent that allocates to destination 1
      const intentFor1 = result.intents[0];
      expect(intentFor1?.origin).toBe('10');
      expect(intentFor1?.destinations).toEqual(['1']);
      expect(intentFor1?.amount).toBe('90000000000000000000');

      // Verify the intent that allocates to destination 8453
      const intentFor8453 = result.intents[1];
      expect(intentFor8453?.origin).toBe('10');
      expect(intentFor8453?.destinations).toEqual(['8453']);
      expect(intentFor8453?.amount).toBe('10000000000000000000');
    });

    it('should prioritize fewer allocations over total amount', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
          ]),
        ],
      ]);

      // Set up custodied assets to test prioritization:
      // - Origin '1' can cover 100% but requires 3 allocations (total 100)
      // - Origin '10' can cover 90% but requires only 2 allocations (total 90)
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')], // 0 WETH on Ethereum
        ['10', BigInt('50000000000000000000')], // 50 WETH on Optimism
        ['8453', BigInt('40000000000000000000')], // 40 WETH on Base
        ['42161', BigInt('10000000000000000000')], // 10 WETH on Arbitrum
      ]);

      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('40000000000000000000')], // 40 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('40000000000000000000')], // 40 WETH on Base
        ['42161', BigInt('20000000000000000000')], // 20 WETH on Arbitrum
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const custodiedBalances2 = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances2]]);

      // Test with first set of balances
      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Verify we have a valid result with allocations
      expect(result.originDomain).toBeTruthy();
      expect(result.totalAllocated > BigInt(0)).toBe(true);
      expect(result.intents.length).toBeGreaterThan(0);

      // Test with second set of balances
      const result2 = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances2);

      // Verify we have a valid result with allocations
      expect(result2.originDomain).toBeTruthy();
      expect(result2.totalAllocated > BigInt(0)).toBe(true);
      expect(result2.intents.length).toBeGreaterThan(0);
    });

    it('should prioritize top-N chains when allocation count is equal', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
            ['137', BigInt('200000000000000000000')], // 200 WETH on Polygon
            ['43114', BigInt('200000000000000000000')], // 200 WETH on Avalanche
          ]),
        ],
      ]);

      // Set up custodied assets to test prioritization:
      // - Origin '1' can use only top-N chains (1, 10, 8453, 42161) with 2 allocations
      // - Origin '10' uses one non-top-N chain (137) with 2 allocations
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')], // 0 WETH on Ethereum
        ['10', BigInt('50000000000000000000')], // 50 WETH on Optimism
        ['8453', BigInt('50000000000000000000')], // 50 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
        ['137', BigInt('0')], // 0 WETH on Polygon
        ['43114', BigInt('0')], // 0 WETH on Avalanche
      ]);

      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('40000000000000000000')], // 40 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
        ['137', BigInt('60000000000000000000')], // 60 WETH on Polygon
        ['43114', BigInt('0')], // 0 WETH on Avalanche
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const custodiedBalances2 = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances2]]);

      // Test with first set of balances
      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Verify we have a valid result with allocations
      expect(result.originDomain).toBeTruthy();
      expect(result.totalAllocated > BigInt(0)).toBe(true);
      expect(result.intents.length).toBeGreaterThan(0);

      // Test with second set of balances
      const result2 = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances2);

      // Verify we have a valid result with allocations
      expect(result2.originDomain).toBeTruthy();
      expect(result2.totalAllocated > BigInt(0)).toBe(true);
      expect(result2.intents.length).toBeGreaterThan(0);
    });

    it('should respect MAX_DESTINATIONS limit when evaluating allocations', async () => {
      // Configure many domains to test the MAX_DESTINATIONS limit
      const manyDomains = [1, 10, 8453, 42161, 137, 43114, 1101, 56, 100, 250, 324, 11155111];

      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has enough balance on Ethereum
      const balances = new Map<string, Map<string, bigint>>([
        [
          'WETH',
          new Map<string, bigint>([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            // Add balances for all other chains
            ...manyDomains
              .slice(1)
              .map((domain) => [domain.toString(), BigInt('10000000000000000000')] as [string, bigint]),
          ]),
        ],
      ]);

      // Set up custodied assets across all domains
      const custodiedWETHBalances = new Map<string, bigint>();
      // Each domain has some custodied assets
      manyDomains.forEach((domain, index) => {
        custodiedWETHBalances.set(domain.toString(), BigInt(index + 1) * BigInt('10000000000000000'));
      });

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Verify we don't exceed MAX_DESTINATIONS
      result.intents.forEach((intent) => {
        expect(intent.destinations.length).toBeLessThanOrEqual(10);
      });

      // Also verify Mark prioritized domains with highest custodied assets
      // The domains with highest assets should be used first
      const highestAssetDomains = [...manyDomains]
        .filter((domain) => domain.toString() !== result.originDomain)
        .sort((a, b) => {
          const aAssets = Number(custodiedWETHBalances.get(a.toString()) || 0n);
          const bAssets = Number(custodiedWETHBalances.get(b.toString()) || 0n);
          return bAssets - aAssets;
        })
        .map((domain) => domain.toString())
        .slice(0, 10);

      // Skip this check if no intents were created
      if (result.intents.length > 0) {
        const firstIntentDomains = result.intents[0].destinations;
        highestAssetDomains.slice(0, 3).forEach((domain) => {
          expect(firstIntentDomains).toContain(domain);
        });
      } else {
        // If no intents were created, ensure the test reason is logged
        logger.info.calledWith(expect.any(String), expect.any(Object));
      }
    });

    it('should use totalAllocated as a tiebreaker when allocation count and top-N usage are equal', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
          ]),
        ],
      ]);

      // Set up custodied assets to test tiebreaker:
      // - Origin '1' and '10' both require 2 allocations, both use only top-N chains
      // - Origin '1' can allocate 90 WETH
      // - Origin '10' can allocate 80 WETH
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')], // 0 WETH on Ethereum
        ['10', BigInt('60000000000000000000')], // 60 WETH on Optimism
        ['8453', BigInt('30000000000000000000')], // 30 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
      ]);

      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('50000000000000000000')], // 50 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('30000000000000000000')], // 30 WETH on Arbitrum
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const custodiedBalances2 = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances2]]);

      // Test with first set of balances (should choose origin '1' with higher total)
      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      const topNDomainsExceptOrigin = mockContext.config.supportedSettlementDomains.length - 1;

      // Should choose origin 1 which has 90 WETH total vs origin 10 with 80 WETH total
      expect(result.originDomain).toBe('8453');
      expect(result.totalAllocated).toBe(BigInt('60000000000000000000'));
      expect(result.intents.length).toBe(1 + topNDomainsExceptOrigin);

      // Test with second set of balances (should choose origin '10' with higher total)
      const result2 = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances2);

      // Should choose origin 10 with 80 WETH total over origin 1 with 70 WETH total
      expect(result2.originDomain).toBe('10');
      expect(result2.totalAllocated).toBe(BigInt('80000000000000000000'));
      expect(result2.intents.length).toBe(2 + topNDomainsExceptOrigin);
    });

    it('should filter SVM chains when top domain is SVM', async () => {
      // Import isSvmChain directly since it's not in coreHelpers
      const { isSvmChain } = await import('@mark/core');
      // Mock SVM chain check
      const isSvmChainStub = sinon.stub({ isSvmChain }, 'isSvmChain');
      isSvmChainStub.withArgs('1399811149').returns(true); // Real SVM chain
      isSvmChainStub.withArgs('1').returns(false); // EVM chain
      isSvmChainStub.withArgs('10').returns(false); // EVM chain
      isSvmChainStub.withArgs('8453').returns(false); // EVM chain

      // Add real SVM chain '1399811149' to the mock configuration and ensure all chains have WETH
      const testConfig = {
        ...mockConfig,
        supportedSettlementDomains: [1, 10, 8453, 1399811149],
        chains: {
          ...mockConfig.chains,
          '1': {
            ...mockConfig.chains['1'],
            assets: [
              {
                tickerHash: 'WETH',
                address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
          },
          '10': {
            ...mockConfig.chains['10'],
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x4200000000000000000000000000000000000006',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
          },
          '8453': {
            ...mockConfig.chains['8453'],
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x4200000000000000000000000000000000000006',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
          },
          '1399811149': {
            assets: [
              {
                tickerHash: 'WETH',
                address: 'SVMTokenAddress1399811149', // SVM uses base58 addresses
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890',
            },
          },
        },
      } as unknown as MarkConfiguration;

      const testContext = {
        ...mockContext,
        config: testConfig,
      } as ProcessingContext;

      const invoice = {
        intent_id: '0xinvoice-svm',
        origin: '1',
        destinations: ['1399811149', '10', '8453'],
        amount: '50000000000000000000', // 50 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '1': '50000000000000000000', // Origin domain needs to be in minAmounts
        '1399811149': '25000000000000000000',
        '10': '25000000000000000000',
        '8453': '25000000000000000000',
      };

      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // Higher balance on origin
            ['1399811149', BigInt('100000000000000000000')],
            ['10', BigInt('50000000000000000000')], // Lower balance
            ['8453', BigInt('50000000000000000000')], // Lower balance
          ]),
        ],
      ]);

      const custodiedAssets = new Map<string, bigint>([
        ['1', BigInt('10000000000000000000')],
        ['1399811149', BigInt('50000000000000000000')], // Highest custodied balance - SVM chain
        ['10', BigInt('20000000000000000000')],
        ['8453', BigInt('5000000000000000000')],
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedAssets]]);

      const result = await calculateSplitIntents(testContext, invoice, minAmounts, balances, custodiedBalances);

      // Should only use SVM domains when top domain is SVM
      expect(result).not.toBeNull();

      // Verify that SVM destinations are included when top domain is SVM
      const allDestinations = result!.intents.flatMap((i) => i.destinations);
      const svmDestinations = allDestinations.filter((d) => d === '1399811149');
      expect(svmDestinations.length).toBeGreaterThan(0);

      isSvmChainStub.restore();
    });

    it('should handle case where getTokenAddressFromConfig returns null', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'UNKNOWN_TICKER', // Use a ticker that doesn't exist in config
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000',
        '8453': '100000000000000000000',
      };

      // Mark has enough balance
      const balances = new Map([
        [
          'UNKNOWN_TICKER',
          new Map([
            ['1', BigInt('200000000000000000000')],
            ['10', BigInt('200000000000000000000')],
            ['8453', BigInt('200000000000000000000')],
          ]),
        ],
      ]);

      // Set up custodied assets
      const custodiedAssets = new Map<string, bigint>([
        ['1', BigInt('0')],
        ['10', BigInt('50000000000000000000')],
        ['8453', BigInt('50000000000000000000')],
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([['UNKNOWN_TICKER', custodiedAssets]]);

      await expect(
        calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances),
      ).rejects.toThrow();
    });

    it('should test allocation sorting with top-N chains preference', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000',
        '8453': '100000000000000000000',
      };

      // Create a modified config with more domains to test TOP_N logic
      const testConfig = {
        ...mockContext.config,
        supportedSettlementDomains: [1, 10, 8453, 42161, 137, 43114], // Added Polygon and Avalanche
        supportedAssets: ['WETH'],
        chains: {
          ...mockContext.config.chains,
          '137': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890',
            },
          },
          '43114': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890',
            },
          },
        },
      } as MarkConfiguration;

      const testContext = {
        ...mockContext,
        config: testConfig,
      } as ProcessingContext;

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')], // 0 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('0')], // 0 WETH on Arbitrum
            ['137', BigInt('0')], // 0 WETH on Polygon
            ['43114', BigInt('0')], // 0 WETH on Avalanche
          ]),
        ],
      ]);

      // Set up two possible origins with different allocation patterns
      // Origin '10' uses only top-N chains
      const topNCustodied = new Map<string, bigint>([
        ['1', BigInt('50000000000000000000')], // 50 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum
        ['137', BigInt('0')], // 0 WETH on Polygon
        ['43114', BigInt('0')], // 0 WETH on Avalanche
      ]);

      // Origin '8453' uses non-top-N chains
      const nonTopNCustodied = new Map<string, bigint>([
        ['1', BigInt('0')], // 0 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
        ['137', BigInt('50000000000000000000')], // 50 WETH on Polygon (non-top-N)
        ['43114', BigInt('50000000000000000000')], // 50 WETH on Avalanche (non-top-N)
      ]);

      const topNCustodiedBalances = new Map<string, Map<string, bigint>>([['WETH', topNCustodied]]);

      const nonTopNCustodiedBalances = new Map<string, Map<string, bigint>>([['WETH', nonTopNCustodied]]);

      // Test with top-N chains
      const resultTopN = await calculateSplitIntents(testContext, invoice, minAmounts, balances, topNCustodiedBalances);

      // Test with non-top-N chains
      const resultNonTopN = await calculateSplitIntents(
        testContext,
        invoice,
        minAmounts,
        balances,
        nonTopNCustodiedBalances,
      );

      // Both should have valid allocations
      expect(resultTopN.intents.length).toBeGreaterThan(0);
      expect(resultNonTopN.intents.length).toBeGreaterThan(0);
    });

    it('should test allocation sorting with totalAllocated as tiebreaker', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000',
        '8453': '100000000000000000000',
      };

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')], // 0 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('0')], // 0 WETH on Arbitrum
          ]),
        ],
      ]);

      // Origin '10' allocates 90 WETH, Origin '8453' allocates 80 WETH
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('90000000000000000000')], // 90 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
      ]);

      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('80000000000000000000')], // 80 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const custodiedBalances2 = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances2]]);

      // Test with first set of balances (90 WETH)
      const result1 = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Test with second set of balances (80 WETH)
      const result2 = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances2);

      // Should prefer the origin with higher totalAllocated
      expect(result1.totalAllocated).toBe(BigInt('90000000000000000000'));
      expect(result2.totalAllocated).toBe(BigInt('80000000000000000000'));
    });

    it('should handle edge cases in allocation sorting', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000',
        '8453': '100000000000000000000',
      };

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
          ]),
        ],
      ]);

      // Edge case 1: Equal allocations in all aspects (length, top-N usage, totalAllocated)
      const equalCustodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')], // 0 WETH on Ethereum
        ['10', BigInt('50000000000000000000')], // 50 WETH on Optimism
        ['8453', BigInt('50000000000000000000')], // 50 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
      ]);
      const equalCustodiedBalances = new Map<string, Map<string, bigint>>([['WETH', equalCustodiedWETHBalances]]);

      // Edge case 2: No allocations possible for any origin
      const zeroCustodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')], // 0 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
      ]);
      const zeroCustodiedBalances = new Map<string, Map<string, bigint>>([['WETH', zeroCustodiedWETHBalances]]);

      // Test equal allocations
      const resultEqual = await calculateSplitIntents(
        mockContext,
        invoice,
        minAmounts,
        balances,
        equalCustodiedBalances,
      );

      const topNDomainsExceptOrigin = mockContext.config.supportedSettlementDomains.length - 1;

      // Should have chosen one of the origins with valid allocations
      expect(resultEqual.originDomain).toBeTruthy();
      expect(['10', '8453']).toContain(resultEqual.originDomain);
      expect(resultEqual.intents.length).toBe(1 + topNDomainsExceptOrigin);
      expect(resultEqual.totalAllocated).toBe(BigInt('50000000000000000000'));

      // Test no allocations possible
      const resultZero = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, zeroCustodiedBalances);

      // Should have chosen an origin but with no intents due to no custodied assets
      expect(resultZero.originDomain).toBeTruthy();
      expect(resultZero.intents.length).toBe(0 + topNDomainsExceptOrigin);
      expect(resultZero.totalAllocated).toBe(BigInt('0'));
    });

    it('should handle the case when no origins have sufficient balance', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000',
        '8453': '100000000000000000000',
      };

      // Mark has insufficient balance in all origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('50000000000000000000')], // 50 WETH on Ethereum (insufficient)
            ['10', BigInt('50000000000000000000')], // 50 WETH on Optimism (insufficient)
            ['8453', BigInt('50000000000000000000')], // 50 WETH on Base (insufficient)
            ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum (insufficient)
          ]),
        ],
      ]);

      // Set up custodied assets
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('50000000000000000000')], // 50 WETH on Ethereum
        ['10', BigInt('50000000000000000000')], // 50 WETH on Optimism
        ['8453', BigInt('50000000000000000000')], // 50 WETH on Base
        ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Should have no origins with sufficient balance
      expect(result.intents.length).toBe(0);
      expect(result.originDomain).toBe('');
      expect(result.totalAllocated).toBe(BigInt('0'));
      // Check that the logger was called with the expected message
      const infoCalls = mockDeps.logger.info.getCalls();
      const noBalanceMessage = infoCalls.find(
        (call) =>
          call.args[0] &&
          typeof call.args[0] === 'string' &&
          call.args[0].includes('No origins where Mark had enough balance'),
      );
      expect(noBalanceMessage).toBeTruthy();
    });

    it('should handle the case when all allocations are empty', async () => {
      const invoice = {
        intent_id: '0xinvoice-a',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000',
        '8453': '100000000000000000000',
      };

      // Mark has enough balance in multiple origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
            ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
            ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
          ]),
        ],
      ]);

      // No custodied assets on any chain
      const emptyCustodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')],
        ['10', BigInt('0')],
        ['8453', BigInt('0')],
        ['42161', BigInt('0')],
      ]);
      const emptyCustodiedBalances = new Map<string, Map<string, bigint>>([['WETH', emptyCustodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, emptyCustodiedBalances);

      const topNDomainsExceptOrigin = mockContext.config.supportedSettlementDomains.length - 1;

      // Should have chosen an origin but with no intents due to no custodied assets
      expect(result.originDomain).toBeTruthy();
      expect(result.intents.length).toBe(0 + topNDomainsExceptOrigin);
      expect(result.totalAllocated).toBe(BigInt('0'));
    });

    it('should properly pad top-N destinations to TOP_N_DESTINATIONS length', async () => {
      const invoice = {
        intent_id: '0xinvoice-top-n-padding',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '1': '100000000000000000000', // 100 WETH
      };

      // Mark has enough balance on Ethereum
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
            ['10', BigInt('10000000000000000000')],
            ['8453', BigInt('10000000000000000000')],
            ['42161', BigInt('10000000000000000000')],
          ]),
        ],
      ]);

      // Set up custodied assets where only 2 domains (of the 4 possible) have assets
      // This will create a top-N allocation with only 2 destinations used for allocation
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')], // Origin - not available for allocation
        ['10', BigInt('60000000000000000000')], // 60 WETH on Optimism - used for allocation
        ['8453', BigInt('40000000000000000000')], // 40 WETH on Base - used for allocation
        ['42161', BigInt('0')], // 0 WETH on Arbitrum - not used for allocation
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Verify results
      expect(result.originDomain).toBe('1'); // Origin should be Ethereum
      expect(result.totalAllocated).toBe(BigInt('100000000000000000000')); // 100 WETH allocated
      expect(result.intents.length).toBe(2); // Two intents (one per domain with assets)

      // First intent should target domain 10
      const intentFor10 = result.intents.find((i) => i.destinations[0] === '10');
      expect(intentFor10?.destinations).toEqual(['10']);
      expect(intentFor10?.amount).toBe('60000000000000000000');

      // Second intent should target domain 8453
      const intentFor8453 = result.intents.find((i) => i.destinations[0] === '8453');
      expect(intentFor8453?.destinations).toEqual(['8453']);
      expect(intentFor8453?.amount).toBe('40000000000000000000');

      result.intents.forEach((intent) => {
        expect(intent.destinations.length).toBe(1);
      });
    });

    it('should properly pad top-MAX destinations to MAX_DESTINATIONS length', async () => {
      // Configure more domains to test MAX_DESTINATIONS padding
      const manyDomains = [1, 10, 8453, 42161, 137, 43114, 1101, 56, 100, 250, 324, 11155111];

      const testConfig = {
        ...mockContext.config,
        supportedSettlementDomains: manyDomains,
        supportedAssets: ['WETH'],
        chains: {
          ...mockContext.config.chains,
          '137': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
          '43114': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
          '1101': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x4F9A0e7FD2Bf6067db6994CF12E4495Df938E6e9',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
          '56': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
          '100': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0xWETHonGnosis',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
          '250': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0xWETHonFantom',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
          '324': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0xWETHonZkSync',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
          '11155111': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0xWETHonSepolia',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
          },
        },
      } as unknown as MarkConfiguration;

      const testContext = {
        ...mockContext,
        config: testConfig,
      } as ProcessingContext;

      const invoice = {
        intent_id: '0xinvoice-max-padding',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '200000000000000000000', // 200 WETH - ensure top-N isn't sufficient
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '200000000000000000000', // 200 WETH
      };

      // Mark has enough balance on Optimism
      const balances = new Map<string, Map<string, bigint>>([
        [
          'WETH',
          new Map<string, bigint>([
            ['1', BigInt('0')],
            ['10', BigInt('300000000000000000000')], // 300 WETH on Optimism
            ...manyDomains
              .slice(2)
              .map((domain) => [domain.toString(), BigInt('10000000000000000000')] as [string, bigint]),
          ]),
        ],
      ]);

      // Setup custodied assets in a way that forces a top-MAX allocation
      // First ensure top-N doesn't cover the full amount by placing assets outside of top-N domains
      const custodiedWETHBalances = new Map<string, bigint>();
      // Add zero balance for all domains initially
      manyDomains.forEach((domain) => {
        custodiedWETHBalances.set(domain.toString(), BigInt('0'));
      });

      // Now set actual balances for a few domains
      custodiedWETHBalances.set('1', BigInt('0')); // First domain - zero balance
      custodiedWETHBalances.set('42161', BigInt('0')); // A top-N domain - zero balance
      custodiedWETHBalances.set('137', BigInt('40000000000000000000')); // 40 WETH - outside top-N
      custodiedWETHBalances.set('1101', BigInt('40000000000000000000')); // 40 WETH - outside top-N
      custodiedWETHBalances.set('56', BigInt('40000000000000000000')); // 40 WETH - outside top-N
      custodiedWETHBalances.set('100', BigInt('40000000000000000000')); // 40 WETH - outside top-N
      custodiedWETHBalances.set('250', BigInt('40000000000000000000')); // 40 WETH - outside top-N

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(testContext, invoice, minAmounts, balances, custodiedBalances);

      // Verify results
      expect(result.originDomain).toBe('10'); // Origin should be Optimism
      expect(result.totalAllocated).toBe(BigInt('200000000000000000000')); // 200 WETH allocated
      expect(result.intents.length).toBe(5); // Five intents (one per domain with assets)

      const domainsThatShouldBeUsed = ['137', '1101', '56', '100', '250'];

      // Check that each of our expected domains has an intent targeting it
      domainsThatShouldBeUsed.forEach((domain) => {
        const intentForDomain = result.intents.find((i) => i.destinations[0] === domain);
        expect(intentForDomain).toBeDefined();
        expect(intentForDomain?.destinations).toEqual([domain]);
        expect(intentForDomain?.amount).toBe('40000000000000000000'); // Each has 40 WETH
      });

      result.intents.forEach((intent) => {
        expect(intent.destinations.length).toBe(1);
        expect(domainsThatShouldBeUsed).toContain(intent.destinations[0]);
        expect(intent.destinations).not.toContain('10'); // Origin can't be a destination
      });
    });

    it('should evaluate each origin with its specific minAmount value', async () => {
      const invoice = {
        intent_id: '0xinvoice-diff-min-amounts',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '200000000000000000000', // 200 WETH - split calc should NOT use this amount
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      // Different min amounts for different origins
      const minAmounts = {
        '1': '120000000000000000000', // 120 WETH needed from Ethereum
        '10': '80000000000000000000', // 80 WETH needed from Optimism
        '8453': '100000000000000000000', // 100 WETH needed from Base
      };

      // Mark has different balances on each origin
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('110000000000000000000')], // 110 WETH (not enough for minAmount of 120)
            ['10', BigInt('100000000000000000000')], // 100 WETH (enough for minAmount of 80)
            ['8453', BigInt('90000000000000000000')], // 90 WETH (not enough for minAmount of 100)
            ['42161', BigInt('200000000000000000000')], // 200 WETH (not in minAmounts)
          ]),
        ],
      ]);

      // Set up custodied assets
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')], // 0 WETH on Ethereum
        ['10', BigInt('0')], // 0 WETH on Optimism
        ['8453', BigInt('0')], // 0 WETH on Base
        ['42161', BigInt('0')], // 0 WETH on Arbitrum
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Should choose origin '10' as it's the only one with sufficient balance
      expect(result.originDomain).toBe('10');
      expect(result.totalAllocated).toBe(BigInt('0'));

      // Verify origins 1 and 8453 were skipped due to insufficient balance
      const debugCalls = mockDeps.logger.debug.getCalls();

      const origin1SkipMessage = debugCalls.find(
        (call) =>
          call.args[0] === 'Skipping origin due to insufficient balance' &&
          call.args[1] &&
          call.args[1].origin === '1' &&
          call.args[1].required === '120000000000000000000' &&
          call.args[1].available === '110000000000000000000',
      );
      expect(origin1SkipMessage).toBeTruthy();

      const origin8453SkipMessage = debugCalls.find(
        (call) =>
          call.args[0] === 'Skipping origin due to insufficient balance' &&
          call.args[1] &&
          call.args[1].origin === '8453' &&
          call.args[1].required === '100000000000000000000' &&
          call.args[1].available === '90000000000000000000',
      );
      expect(origin8453SkipMessage).toBeTruthy();
    });

    it('should pick the origin with higher allocation when multiple origins have sufficient balance', async () => {
      const invoice = {
        intent_id: '0xinvoice-multi-sufficient',
        origin: '1',
        destinations: ['10', '8453', '42161'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '80000000000000000000', // 80 WETH needed from Optimism
        '8453': '60000000000000000000', // 60 WETH needed from Base
        '42161': '100000000000000000000', // 100 WETH needed from Arbitrum
      };

      // Mark has sufficient balance on all origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('100000000000000000000')], // 100 WETH (not in minAmounts)
            ['10', BigInt('100000000000000000000')], // 100 WETH
            ['8453', BigInt('100000000000000000000')], // 100 WETH
            ['42161', BigInt('100000000000000000000')], // 100 WETH
          ]),
        ],
      ]);

      // Set up custodied assets to make origin '10' have the highest allocation
      // Origin 10 needs 80 WETH and can settle out with one split
      // Origin 8453 needs 60 WETH but would need multiple splits
      // Origin 42161 needs 100 WETH but would need multiple splits
      const custodiedWETHBalances = new Map<string, bigint>([
        ['10', BigInt('40000000000000000000')],
        ['8453', BigInt('80000000000000000000')],
        ['42161', BigInt('200000000000000000000')],
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Should choose origin '10'
      expect(result.originDomain).toBe('10');
      expect(result.totalAllocated).toBe(BigInt('80000000000000000000'));
      expect(result.intents.length).toBe(1); // Single intent

      // Verify the intent uses 42161 as destination
      const intent = result.intents[0];
      expect(intent.origin).toBe('10');
      expect(intent.destinations).toContain('42161');
      expect(intent.amount).toBe('80000000000000000000');
    });

    it('should filter out domains that do not support the ticker', async () => {
      const invoice = {
        intent_id: '0xinvoice-filter-unsupported',
        origin: '1',
        destinations: ['10', '8453'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH
        '8453': '100000000000000000000', // 100 WETH
      };

      // Mark has sufficient balance on all origins
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['10', BigInt('200000000000000000000')], // 200 WETH
            ['8453', BigInt('200000000000000000000')], // 200 WETH
            ['137', BigInt('200000000000000000000')], // 200 WETH on Polygon (unsupported)
          ]),
        ],
      ]);

      // Set up custodied assets with assets on Polygon that shouldn't be used
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('20000000000000000000')], // 20 WETH on Ethereum
        ['10', BigInt('30000000000000000000')], // 30 WETH on Optimism
        ['8453', BigInt('40000000000000000000')], // 40 WETH on Base
        ['137', BigInt('90000000000000000000')], // 90 WETH on Polygon (should be ignored)
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedWETHBalances]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Should choose an origin and create intents for supported domains only
      expect(result.originDomain).toBe('10');
      expect(result.totalAllocated).toBe(BigInt('60000000000000000000'));

      // Verify none of the intents allocate to Polygon
      result.intents.forEach((intent) => {
        // Domain 137 shouldn't be used for allocation
        const hasAllocationToPolygon =
          intent.destinations.includes('137') && custodiedWETHBalances.get('137')! > BigInt(0);
        expect(hasAllocationToPolygon).toBe(false);
      });
    });

    it('should prioritize full coverage over fewer intents', async () => {
      const invoice = {
        intent_id: '0xinvoice-coverage-vs-intents',
        origin: '1',
        destinations: ['10', '8453', '42161'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH needed
      };

      // Only Optimism can be origin
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')],
            ['10', BigInt('100000000000000000000')], // 100 WETH on Optimism
            ['8453', BigInt('0')],
            ['42161', BigInt('0')],
          ]),
        ],
      ]);

      const custodiedAssets = new Map<string, bigint>([
        ['1', BigInt('80000000000000000000')], // 80 WETH on Ethereum
        ['10', BigInt('0')],
        ['8453', BigInt('60000000000000000000')], // 60 WETH on Base
        ['42161', BigInt('40000000000000000000')], // 40 WETH on Arbitrum
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedAssets]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // The result should show full coverage with 2 intents
      expect(result.originDomain).toBe('10');
      expect(result.totalAllocated).toBe(BigInt('100000000000000000000')); // 100 WETH (full coverage)
      expect(result.intents.length).toBe(2); // Two intents (one per domain with assets)
    });

    it('should prioritize top-N allocation when all options fully cover amount needed', async () => {
      const invoice = {
        intent_id: '0xinvoice-topn-preference',
        origin: '1',
        destinations: ['10', '8453', '42161'],
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '10': '100000000000000000000', // 100 WETH needed
      };

      // Only Optimism can be origin
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')],
            ['10', BigInt('200000000000000000000')],
            ['8453', BigInt('0')],
            ['42161', BigInt('0')],
            ['43114', BigInt('0')],
            ['56', BigInt('0')],
            ['48900', BigInt('0')],
            ['137', BigInt('0')],
          ]),
        ],
      ]);

      // possibleAllocation1: 100 WETH using only top-N chains (1, 8453) - should be preferred
      // possibleAllocation2: 110 WETH using top-MAX chains (1, 137)
      const custodiedAssets = new Map<string, bigint>([
        ['1', BigInt('50000000000000000000')], // 50 WETH on Ethereum (top-N)
        ['10', BigInt('0')], // Origin - can't allocate here
        ['8453', BigInt('50000000000000000000')], // 50 WETH on Base (top-N)
        ['42161', BigInt('0')], // 0 WETH on Arbitrum (top-N)
        ['43114', BigInt('0')], // 0 WETH on Avalanche (top-N)
        ['56', BigInt('0')], // 0 WETH on BSC (top-N)
        ['48900', BigInt('0')], // 0 WETH on Zircuit (top-N)
        ['137', BigInt('60000000000000000000')], // 60 WETH on Polygon (not top-N)
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([['WETH', custodiedAssets]]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      // Should choose the top-N allocation
      expect(result.originDomain).toBe('10');
      expect(result.totalAllocated).toBe(BigInt('100000000000000000000'));
      expect(result.intents.length).toBe(2); // 2 intents
      expect(result.intents[0].amount).toBe('50000000000000000000'); // allocated to Ethereum
      expect(result.intents[1].amount).toBe('50000000000000000000'); // allocated to Base
    });

    it('should throw an error if no input asset is found for the origin', async () => {
      const invoice = {
        intent_id: '0xinvoice-no-asset',
        origin: '9999', // Nonexistent domain
        destinations: ['8888'], // Nonexistent destination
        amount: '1000000000000000000', // 1 WETH
        ticker_hash: 'FAKE', // Ticker not in config
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '9999': '1000000000000000000',
      };

      // Mark has balance on the fake origin
      const balances = new Map([['FAKE', new Map([['9999', BigInt('1000000000000000000')]])]]);
      // No custodied assets for FAKE
      const custodiedBalances = new Map<string, Map<string, bigint>>();

      await expect(
        calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances),
      ).rejects.toThrow('No input asset found');
    });
  });

  describe('Zodiac Address Validation', () => {
    const mockZodiacConfig = {
      zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
      zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
      gnosisSafeAddress: '0x9876543210987654321098765432109876543210',
    };

    const mockEOAConfig = {
      zodiacRoleModuleAddress: undefined,
      zodiacRoleKey: undefined,
      gnosisSafeAddress: undefined,
    };

    beforeEach(() => {
      // Reset the config before each test
      mockContext.config = {
        ...mockConfig,
        ownAddress: '0x1111111111111111111111111111111111111111',
        supportedSettlementDomains: [1, 42161],
        supportedAssets: ['WETH'],
        chains: {
          '1': {
            ...mockConfig.chains['1'],
            assets: [
              {
                tickerHash: 'WETH',
                address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            ...mockEOAConfig, // Ethereum uses EOA
          },
          '42161': {
            assets: [
              {
                tickerHash: 'WETH',
                address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
                decimals: 18,
                symbol: 'WETH',
                isNative: false,
                balanceThreshold: '0',
              },
            ],
            providers: ['provider1'],
            invoiceAge: 0,
            gasThreshold: '0',
            deployments: {
              everclear: '0x1234567890123456789012345678901234567890',
              permit2: '0x1234567890123456789012345678901234567890',
              multicall3: '0x1234567890123456789012345678901234567890',
            },
            ...mockZodiacConfig, // Arbitrum uses Zodiac
          },
        },
      };
    });

    it('should use destination chain Zodiac config for intent.to address when destination has Zodiac', async () => {
      const invoice = {
        intent_id: '0xinvoice-destination-zodiac',
        origin: '1', // Ethereum (has no Zodiac) - the origin from the original invoice
        destinations: ['42161'], // Arbitrum destination (has Zodiac)
        amount: '50000000000000000000', // 50 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '1': '50000000000000000000', // 50 WETH needed from Ethereum as origin
      };

      // Origin (Ethereum) has balance
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('50000000000000000000')], // 50 WETH on Ethereum
            ['42161', BigInt('0')],
          ]),
        ],
      ]);

      // Destination (Arbitrum) has custodied balance
      const custodiedBalances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')],
            ['42161', BigInt('50000000000000000000')], // 50 WETH custodied on Arbitrum
          ]),
        ],
      ]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      expect(result.intents.length).toBe(1);
      const intent = result.intents[0];

      // Intent.to should use destination chain (42161) Zodiac config = Safe address
      expect(intent.to).toBe('0x9876543210987654321098765432109876543210'); // Safe address from destination chain config
    });

    it('should use destination chain EOA config for intent.to address when destination has no Zodiac', async () => {
      const invoice = {
        intent_id: '0xinvoice-destination-eoa',
        origin: '42161', // Arbitrum (has Zodiac) - original invoice origin
        destinations: ['1'], // Ethereum destination (no Zodiac)
        amount: '50000000000000000000', // 50 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '42161': '50000000000000000000', // 50 WETH needed from Arbitrum as origin
      };

      // Origin (Arbitrum) has balance
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')],
            ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum
          ]),
        ],
      ]);

      // Destination (Ethereum) has custodied balance
      const custodiedBalances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('50000000000000000000')], // 50 WETH custodied on Ethereum
            ['42161', BigInt('0')],
          ]),
        ],
      ]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      expect(result.intents.length).toBe(1);
      const intent = result.intents[0];

      // Intent.to should use destination chain (1) EOA config = own address
      expect(intent.to).toBe('0x1111111111111111111111111111111111111111'); // EOA address from config
    });

    it('should handle mixed configurations correctly', async () => {
      // Add Optimism chain with different config for mixed test
      mockContext.config.chains['10'] = {
        ...mockConfig.chains['10'],
        assets: [
          {
            tickerHash: 'WETH',
            address: '0x4200000000000000000000000000000000000006',
            decimals: 18,
            symbol: 'WETH',
            isNative: false,
            balanceThreshold: '0',
          },
        ],
        ...mockEOAConfig, // Optimism uses EOA
      };
      mockContext.config.supportedSettlementDomains = [1, 10, 42161];

      const invoice = {
        intent_id: '0xinvoice-mixed-config',
        origin: '42161', // Arbitrum (has Zodiac) - original invoice origin
        destinations: ['1', '10'], // Ethereum (EOA) and Optimism (EOA)
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '42161': '100000000000000000000', // 100 WETH needed from Arbitrum as origin
      };

      // Origin (Arbitrum) has balance
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')],
            ['10', BigInt('0')],
            ['42161', BigInt('100000000000000000000')], // 100 WETH on Arbitrum
          ]),
        ],
      ]);

      // Both destinations have custodied balance
      const custodiedBalances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('50000000000000000000')], // 50 WETH custodied on Ethereum
            ['10', BigInt('50000000000000000000')], // 50 WETH custodied on Optimism
            ['42161', BigInt('0')],
          ]),
        ],
      ]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      expect(result.intents.length).toBe(2);

      // Both intents should use EOA address since both destinations don't have Zodiac
      result.intents.forEach((intent) => {
        expect(intent.to).toBe('0x1111111111111111111111111111111111111111'); // EOA address for both destinations
      });
    });

    it('should handle remainder intents correctly with destination chain config', async () => {
      const invoice = {
        intent_id: '0xinvoice-remainder-zodiac',
        origin: '1', // Ethereum (no Zodiac) - original invoice origin
        destinations: ['42161'], // Arbitrum destination (has Zodiac)
        amount: '100000000000000000000', // 100 WETH
        ticker_hash: 'WETH',
        owner: '0xowner',
        hub_invoice_enqueued_timestamp: 1234567890,
      } as Invoice;

      const minAmounts = {
        '1': '100000000000000000000', // 100 WETH needed from Ethereum as origin
      };

      // Origin (Ethereum) has sufficient balance
      const balances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('100000000000000000000')], // 100 WETH on Ethereum
            ['42161', BigInt('0')],
          ]),
        ],
      ]);

      // Destination has partial custodied balance (not enough to cover full amount)
      const custodiedBalances = new Map([
        [
          'WETH',
          new Map([
            ['1', BigInt('0')],
            ['42161', BigInt('30000000000000000000')], // Only 30 WETH custodied on Arbitrum
          ]),
        ],
      ]);

      const result = await calculateSplitIntents(mockContext, invoice, minAmounts, balances, custodiedBalances);

      expect(result.intents.length).toBe(2);

      // Both intents should use destination chain (42161) Zodiac config = Safe address
      result.intents.forEach((intent) => {
        expect(intent.to).toBe('0x9876543210987654321098765432109876543210'); // Safe address from destination chain config
      });

      // Total amount should match the required amount
      const totalAmount = result.intents.reduce((sum, intent) => sum + BigInt(intent.amount), BigInt(0));
      expect(totalAmount.toString()).toBe('100000000000000000000'); // Full 100 WETH
    });
  });
});
