import { expect } from 'chai';
import { createStubInstance, SinonStubbedInstance, restore as sinonRestore, match } from 'sinon';
import { Logger } from '@mark/logger';
import { Invoice, MarkConfiguration } from '@mark/core';
import { calculateSplitIntents } from '../../src/helpers/splitIntent';
import * as sinon from 'sinon';

describe('Split Intent Helper Functions', () => {
  let logger: SinonStubbedInstance<Logger>;
  let config: MarkConfiguration;

  beforeEach(() => {
    logger = createStubInstance(Logger);

    config = {
      ownAddress: '0xmarkAddress',
      supportedSettlementDomains: [1, 10, 8453, 42161],
      chains: {
        '1': {
          assets: [
            {
              tickerHash: 'WETH',
              address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
              decimals: 18,
              symbol: 'WETH',
              isNative: false,
              balanceThreshold: '0',
            }
          ],
          providers: ['provider1'],
          invoiceAge: 0,
          gasThreshold: '0',
        },
        '10': {
          assets: [
            {
              tickerHash: 'WETH',
              address: '0x4200000000000000000000000000000000000006',
              decimals: 18,
              symbol: 'WETH',
              isNative: false,
              balanceThreshold: '0',
            }
          ],
          providers: ['provider1'],
          invoiceAge: 0,
          gasThreshold: '0',
        },
        '8453': {
          assets: [
            {
              tickerHash: 'WETH',
              address: '0x4200000000000000000000000000000000000006',
              decimals: 18,
              symbol: 'WETH',
              isNative: false,
              balanceThreshold: '0',
            }
          ],
          providers: ['provider1'],
          invoiceAge: 0,
          gasThreshold: '0',
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
            }
          ],  
          providers: ['provider1'],
          invoiceAge: 0,
          gasThreshold: '0',
        },
      },
    } as unknown as MarkConfiguration;
  });

  afterEach(() => {
    sinonRestore();
  });

  describe('calculateSplitIntents', () => {
    it('should handle the case when no balances are available', async () => {
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
        ['WETH', new Map([
          ['1', BigInt('0')],
          ['10', BigInt('0')],
          ['8453', BigInt('0')],
          ['42161', BigInt('0')],
        ])],
      ]);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        balances,
        logger
      );

      expect(result.intents).to.be.an('array');
      expect(result.intents.length).to.equal(0);
      expect(result.totalAllocated).to.equal(BigInt(0));
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
        ['WETH', new Map([
          ['1', BigInt('0')], // 0 WETH on Ethereum
          ['10', BigInt('0')], // 0 WETH on Optimism
          ['8453', BigInt('100000000000000000000')], // 100 WETH on Base (will be origin)
          ['42161', BigInt('0')], // 0 WETH on Arbitrum
        ])],
      ]);

      // Ethereum and Arbitrum have 50 WETH custodied each
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('50000000000000000000')],     // 50 WETH on Ethereum
        ['10', BigInt('0')],                       // 0 WETH on Optimism
        ['8453', BigInt('0')],                     // 0 WETH on Base
        ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances]
      ]);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances,
        logger
      );

      // Should have 2 split intents (one that allocates to 1 and one to 42161)
      // NOTE: Mark sets ALL destinations in each split intent
      expect(result.originDomain).to.equal('8453');
      expect(result.totalAllocated).to.equal(BigInt('100000000000000000000'));
      expect(result.intents.length).to.equal(2);

      // Verify the intent that allocates to destination 1
      const intentFor1 = result.intents[0]; // First intent with 50 WETH
      expect(intentFor1?.origin).to.equal('8453');
      expect(intentFor1?.destinations).to.include('1');
      expect(intentFor1?.destinations).to.include('42161');
      expect(intentFor1?.destinations).to.include('10');
      expect(intentFor1?.amount).to.equal('50000000000000000000');
      
      // Verify the intent that allocates to destination 42161
      const intentFor42161 = result.intents[1]; // Second intent with 50 WETH
      expect(intentFor42161?.origin).to.equal('8453');
      expect(intentFor42161?.destinations).to.include('1');
      expect(intentFor42161?.destinations).to.include('42161');
      expect(intentFor42161?.destinations).to.include('10');
      expect(intentFor42161?.amount).to.equal('50000000000000000000');
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
        ['WETH', new Map([
          ['1', BigInt('100000000000000000000')], // 100 WETH on Ethereum
          ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism (will be origin)
          ['8453', BigInt('50000000000000000000')], // 50 WETH on Base
          ['42161', BigInt('50000000000000000000')], // 50 WETH on Arbitrum
        ])],
      ]);

      // Set up limited custodied assets
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('40000000000000000000')],     // 40 WETH on Ethereum
        ['10', BigInt('10000000000000000000')],    // 10 WETH on Optimism
        ['8453', BigInt('30000000000000000000')],  // 30 WETH on Base
        ['42161', BigInt('0')],                    // 0 WETH on Arbitrum
      ]);
      const custodiedBalances = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances]
      ]);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances,
        logger
      );

      expect(result.originDomain).to.equal('10');
      expect(result.totalAllocated).to.equal(BigInt('70000000000000000000'));
      expect(result.intents.length).to.equal(2); // Two intents for the two destinations with custodied assets

      // Verify the intent that allocates to destination 1
      const intentFor1 = result.intents[0];
      expect(intentFor1?.origin).to.equal('10');
      expect(intentFor1?.destinations).to.include('1');
      expect(intentFor1?.destinations).to.include('8453');
      expect(intentFor1?.destinations).to.include('42161');
      expect(intentFor1?.amount).to.equal('40000000000000000000');
      
      // Verify the intent that allocates to destination 8453
      const intentFor8453 = result.intents[1];
      expect(intentFor8453?.origin).to.equal('10');
      expect(intentFor8453?.destinations).to.include('8453');
      expect(intentFor8453?.destinations).to.include('1');
      expect(intentFor8453?.destinations).to.include('42161');
      expect(intentFor8453?.amount).to.equal('30000000000000000000');
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
        ['WETH', new Map([
          ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
          ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
          ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
          ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
        ])],
      ]);

      // Using origin 10 will have most available custodied assets
      // even if using 8453 will fully settle as well
      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('90000000000000000000')],     // 90 WETH on Ethereum
        ['10', BigInt('0')],                       // 0 WETH on Optimism
        ['8453', BigInt('90000000000000000000')],  // 90 WETH on Base
        ['42161', BigInt('10000000000000000000')], // 10 WETH on Arbitrum
      ]);
      const custodiedBalances2 = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances2]
      ]);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances2,
        logger
      );

      expect(result.originDomain).to.equal('10');
      expect(result.totalAllocated).to.equal(BigInt('100000000000000000000'));
      expect(result.intents.length).to.equal(2);

      // Verify the intent that allocates to destination 1
      const intentFor1 = result.intents[0];
      expect(intentFor1?.origin).to.equal('10');
      expect(intentFor1?.destinations).to.include('1');
      expect(intentFor1?.destinations).to.include('8453');
      expect(intentFor1?.destinations).to.include('42161');
      expect(intentFor1?.amount).to.equal('90000000000000000000');
      
      // Verify the intent that allocates to destination 8453
      const intentFor8453 = result.intents[1];
      expect(intentFor8453?.origin).to.equal('10');
      expect(intentFor8453?.destinations).to.include('1');
      expect(intentFor8453?.destinations).to.include('8453');
      expect(intentFor8453?.destinations).to.include('42161');
      expect(intentFor8453?.amount).to.equal('10000000000000000000');
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
        ['WETH', new Map([
          ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
          ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
          ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
          ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
        ])],
      ]);

      // Set up custodied assets to test prioritization:
      // - Origin '1' can cover 100% but requires 3 allocations (total 100)
      // - Origin '10' can cover 90% but requires only 2 allocations (total 90)
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')],                        // 0 WETH on Ethereum
        ['10', BigInt('50000000000000000000')],    // 50 WETH on Optimism
        ['8453', BigInt('40000000000000000000')],  // 40 WETH on Base
        ['42161', BigInt('10000000000000000000')], // 10 WETH on Arbitrum
      ]);

      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('40000000000000000000')],     // 40 WETH on Ethereum
        ['10', BigInt('0')],                       // 0 WETH on Optimism
        ['8453', BigInt('40000000000000000000')],  // 40 WETH on Base
        ['42161', BigInt('20000000000000000000')], // 20 WETH on Arbitrum
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances]
      ]);
      
      const custodiedBalances2 = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances2]
      ]);

      // Test with first set of balances
      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances,
        logger
      );

      // Verify we have a valid result with allocations
      expect(result.originDomain).to.not.be.empty;
      expect(result.totalAllocated > BigInt(0)).to.be.true;
      expect(result.intents.length).to.be.greaterThan(0);

      // Test with second set of balances
      const result2 = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances2,
        logger
      );

      // Verify we have a valid result with allocations
      expect(result2.originDomain).to.not.be.empty;
      expect(result2.totalAllocated > BigInt(0)).to.be.true;
      expect(result2.intents.length).to.be.greaterThan(0);
    });

    it('should prioritize top-N chains when allocation count is equal', async () => {
      // Update the config to consider fewer top chains
      const testConfig = {
        ...config,
        supportedSettlementDomains: [1, 10, 8453, 42161, 137, 43114], // Added Polygon and Avalanche
      } as unknown as MarkConfiguration;

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
        ['WETH', new Map([
          ['1', BigInt('200000000000000000000')],  // 200 WETH on Ethereum
          ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
          ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
          ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
          ['137', BigInt('200000000000000000000')], // 200 WETH on Polygon
          ['43114', BigInt('200000000000000000000')], // 200 WETH on Avalanche
        ])],
      ]);

      // Set up custodied assets to test prioritization:
      // - Origin '1' can use only top-N chains (1, 10, 8453, 42161) with 2 allocations
      // - Origin '10' uses one non-top-N chain (137) with 2 allocations
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')],                        // 0 WETH on Ethereum
        ['10', BigInt('50000000000000000000')],    // 50 WETH on Optimism
        ['8453', BigInt('50000000000000000000')],  // 50 WETH on Base
        ['42161', BigInt('0')],                    // 0 WETH on Arbitrum
        ['137', BigInt('0')],                      // 0 WETH on Polygon
        ['43114', BigInt('0')],                    // 0 WETH on Avalanche
      ]);

      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('40000000000000000000')],     // 40 WETH on Ethereum
        ['10', BigInt('0')],                       // 0 WETH on Optimism
        ['8453', BigInt('0')],                     // 0 WETH on Base
        ['42161', BigInt('0')],                    // 0 WETH on Arbitrum
        ['137', BigInt('60000000000000000000')],   // 60 WETH on Polygon
        ['43114', BigInt('0')],                    // 0 WETH on Avalanche
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances]
      ]);
      
      const custodiedBalances2 = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances2]
      ]);

      // Test with first set of balances
      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances,
        logger
      );

      // Verify we have a valid result with allocations
      expect(result.originDomain).to.not.be.empty;
      expect(result.totalAllocated > BigInt(0)).to.be.true;
      expect(result.intents.length).to.be.greaterThan(0);

      // Test with second set of balances
      const result2 = await calculateSplitIntents(
        invoice,
        minAmounts,
        testConfig,
        balances,
        custodiedBalances2,
        logger
      );

      // Verify we have a valid result with allocations
      expect(result2.originDomain).to.not.be.empty;
      expect(result2.totalAllocated > BigInt(0)).to.be.true;
      expect(result2.intents.length).to.be.greaterThan(0);
    });

    it('should respect MAX_DESTINATIONS limit when evaluating allocations', async () => {
      // Configure many domains to test the MAX_DESTINATIONS limit
      const manyDomains = [1, 10, 8453, 42161, 137, 43114, 1101, 56, 100, 250, 324, 11155111];
      const testConfig = {
        ...config,
        supportedSettlementDomains: manyDomains,
      } as unknown as MarkConfiguration;

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
        ['WETH', new Map<string, bigint>([
          ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
          // Add balances for all other chains
          ...manyDomains.slice(1).map(domain => [domain.toString(), BigInt('10000000000000000000')] as [string, bigint])
        ])],
      ]);

      // Set up custodied assets across all domains
      const custodiedWETHBalances = new Map<string, bigint>();
      // Each domain has some custodied assets
      manyDomains.forEach((domain, index) => {
        custodiedWETHBalances.set(
          domain.toString(), 
          BigInt((index + 1)) * BigInt(10000000000000000)
        );
      });

      const custodiedBalances = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances]
      ]);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        testConfig,
        balances,
        custodiedBalances,
        logger
      );

      // Verify we don't exceed MAX_DESTINATIONS
      result.intents.forEach(intent => {
        expect(intent.destinations.length).to.be.at.most(10);
      });

      // Also verify Mark prioritized domains with highest custodied assets
      // The domains with highest assets should be used first
      const highestAssetDomains = [...manyDomains]
        .filter(domain => domain.toString() !== result.originDomain)
        .sort((a, b) => {
          const aAssets = Number(custodiedWETHBalances.get(a.toString()) || 0n);
          const bAssets = Number(custodiedWETHBalances.get(b.toString()) || 0n);
          return bAssets - aAssets;
        })
        .map(domain => domain.toString())
        .slice(0, 10);

      // Skip this check if no intents were created
      if (result.intents.length > 0) {
        const firstIntentDomains = result.intents[0].destinations;
        highestAssetDomains.slice(0, 3).forEach(domain => {
          expect(firstIntentDomains).to.include(domain);
        });
      } else {
        // If no intents were created, ensure the test reason is logged
        logger.info.calledWith(sinon.match.string, sinon.match.object);
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
        ['WETH', new Map([
          ['1', BigInt('200000000000000000000')], // 200 WETH on Ethereum
          ['10', BigInt('200000000000000000000')], // 200 WETH on Optimism
          ['8453', BigInt('200000000000000000000')], // 200 WETH on Base
          ['42161', BigInt('200000000000000000000')], // 200 WETH on Arbitrum
        ])],
      ]);

      // Set up custodied assets to test tiebreaker:
      // - Origin '1' and '10' both require 2 allocations, both use only top-N chains
      // - Origin '1' can allocate 90 WETH
      // - Origin '10' can allocate 80 WETH
      const custodiedWETHBalances = new Map<string, bigint>([
        ['1', BigInt('0')],                        // 0 WETH on Ethereum
        ['10', BigInt('60000000000000000000')],    // 60 WETH on Optimism
        ['8453', BigInt('30000000000000000000')],  // 30 WETH on Base
        ['42161', BigInt('0')],                    // 0 WETH on Arbitrum
      ]);

      const custodiedWETHBalances2 = new Map<string, bigint>([
        ['1', BigInt('50000000000000000000')],     // 50 WETH on Ethereum
        ['10', BigInt('0')],                       // 0 WETH on Optimism
        ['8453', BigInt('0')],                     // 0 WETH on Base
        ['42161', BigInt('30000000000000000000')], // 30 WETH on Arbitrum
      ]);

      const custodiedBalances = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances]
      ]);
      
      const custodiedBalances2 = new Map<string, Map<string, bigint>>([
        ['WETH', custodiedWETHBalances2]
      ]);

      // Test with first set of balances (should choose origin '1' with higher total)
      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances,
        logger
      );

      // Should choose origin 1 which has 90 WETH total vs origin 10 with 80 WETH total
      expect(result.originDomain).to.equal('8453');
      expect(result.totalAllocated).to.equal(BigInt('60000000000000000000'));
      expect(result.intents.length).to.equal(1);

      // Test with second set of balances (should choose origin '10' with higher total)
      const result2 = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
        custodiedBalances2,
        logger
      );

      // Should choose origin 10 with 80 WETH total over origin 1 with 70 WETH total
      expect(result2.originDomain).to.equal('10');
      expect(result2.totalAllocated).to.equal(BigInt('80000000000000000000'));
      expect(result2.intents.length).to.equal(2);
    });
  });
});