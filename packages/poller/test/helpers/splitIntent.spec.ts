import { expect } from 'chai';
import { stub, createStubInstance, SinonStubbedInstance, restore as sinonRestore, SinonStub } from 'sinon';
import { EverclearAdapter } from '@mark/everclear';
import { Logger } from '@mark/logger';
import { Invoice, MarkConfiguration } from '@mark/core';
import { calculateSplitIntents } from '../../src/helpers/splitIntent';
import * as balanceHelpers from '../../src/helpers/balance';

describe('Split Intent Helper Functions', () => {
  let everclear: SinonStubbedInstance<EverclearAdapter>;
  let logger: SinonStubbedInstance<Logger>;
  let config: MarkConfiguration;
  let getCustodiedBalancesStub: SinonStub;

  beforeEach(() => {
    everclear = createStubInstance(EverclearAdapter);
    logger = createStubInstance(Logger);
    getCustodiedBalancesStub = stub(balanceHelpers, 'getCustodiedBalances');

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
      getCustodiedBalancesStub.resolves(balances);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
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
      getCustodiedBalancesStub.resolves(custodiedBalances);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
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
      getCustodiedBalancesStub.resolves(custodiedBalances);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
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
      getCustodiedBalancesStub.resolves(custodiedBalances2);

      const result = await calculateSplitIntents(
        invoice,
        minAmounts,
        config,
        balances,
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
  });
});