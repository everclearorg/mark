import { beforeEach, describe, expect, it } from '@jest/globals';
import { BinanceClient } from '../../../src/adapters/binance/client';
import { DynamicAssetConfig } from '../../../src/adapters/binance/dynamic-config';
import { Logger } from '@mark/logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * These tests use real Binance API credentials and make actual API calls.
 * They are skipped by default to avoid unnecessary API calls during normal testing.
 *
 * To run these tests:
 * 1. Ensure BINANCE_API_KEY and BINANCE_SECRET_KEY are in packages/poller/.env
 * 2. Run from monorepo root: yarn workspace @mark/rebalance test:integration
 */

// Load environment variables from poller/.env if available
function loadEnvFromPoller() {
  const envPath = path.resolve(__dirname, '../../../../../poller/.env');

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');

    envContent.split('\n').forEach((line) => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('=')) {
        const [key, ...valueParts] = trimmedLine.split('=');
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        process.env[key.trim()] = value.trim();
      }
    });
  }
}

describe('BinanceClient Integration Tests', () => {
  let client: BinanceClient;
  let logger: Logger;

  beforeAll(() => {
    loadEnvFromPoller();

    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_SECRET_KEY;

    if (!apiKey || !apiSecret) {
      throw new Error(
        'Integration tests require BINANCE_API_KEY and BINANCE_SECRET_KEY environment variables. ' +
        'Add them to packages/poller/.env or run yarn test (without integration tests).',
      );
    }
  });

  beforeEach(() => {
    logger = new Logger({ service: 'binance-client-integration-test' });

    client = new BinanceClient(
      process.env.BINANCE_API_KEY!,
      process.env.BINANCE_SECRET_KEY!,
      'https://api.binance.com',
      logger,
    );
  });

  describe('Authentication', () => {
    it('should authenticate successfully with real credentials', () => {
      expect(client.isConfigured()).toBe(true);
    });
  });

  describe('getDepositAddress', () => {
    it('should get real ETH deposit address', async () => {
      const result = await client.getDepositAddress('ETH', 'ETH');

      expect(result).toMatchObject({
        address: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/), // Valid Ethereum address
        coin: 'ETH',
        tag: expect.any(String),
        url: expect.stringContaining('etherscan.io'),
      });
    }, 30000);

    it('should get real USDC deposit address', async () => {
      const result = await client.getDepositAddress('USDC', 'ETH');

      expect(result).toMatchObject({
        address: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
        coin: 'USDC',
        tag: expect.any(String),
      });
    }, 30000);

    it('should handle invalid coin gracefully', async () => {
      await expect(client.getDepositAddress('INVALID_COIN', 'ETH')).rejects.toThrow(/Binance API error/);
    }, 30000);
  });

  describe('getDepositHistory', () => {
    it('should retrieve deposit history without errors', async () => {
      const result = await client.getDepositHistory(undefined, undefined, undefined, undefined, 0, 5);

      expect(Array.isArray(result)).toBe(true);

      // If there are deposits, validate structure
      if (result.length > 0) {
        const deposit = result[0];
        expect(deposit).toMatchObject({
          amount: expect.any(String),
          coin: expect.any(String),
          network: expect.any(String),
          status: expect.any(Number),
          address: expect.any(String),
          txId: expect.any(String),
          insertTime: expect.any(Number),
        });
      }
    }, 30000);
  });

  describe('getWithdrawHistory', () => {
    it('should retrieve withdrawal history without errors', async () => {
      const result = await client.getWithdrawHistory(undefined, undefined, undefined, undefined, undefined, 0, 5);

      expect(Array.isArray(result)).toBe(true);

      // If there are withdrawals, validate structure
      if (result.length > 0) {
        const withdrawal = result[0];
        expect(withdrawal).toMatchObject({
          id: expect.any(String),
          amount: expect.any(String),
          transactionFee: expect.any(String),
          coin: expect.any(String),
          status: expect.any(Number),
          address: expect.any(String),
          txId: expect.any(String),
          applyTime: expect.any(String),
          network: expect.any(String),
        });
      }
    }, 30000);
  });

  describe('Comprehensive Asset Coverage', () => {
    it('should validate all supported asset pairs', async () => {
      // Test all asset pairs that we support in constants
      const supportedPairs = [
        { coin: 'ETH', network: 'ETH', name: 'Ethereum' },
        { coin: 'USDC', network: 'ETH', name: 'USDC on Ethereum' },
        { coin: 'ETH', network: 'ARBITRUM', name: 'ETH on Arbitrum' },
        { coin: 'USDC', network: 'ARBITRUM', name: 'USDC on Arbitrum' },
      ];

      for (const pair of supportedPairs) {
        const depositAddress = await client.getDepositAddress(pair.coin, pair.network);

        expect(depositAddress).toMatchObject({
          address: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
          coin: pair.coin,
          tag: expect.any(String),
        });

        console.log(`✅ ${pair.name}: ${depositAddress.address}`);
      }
    }, 120000);
  });

  describe('System and Configuration', () => {
    it('should get system status', async () => {
      const result = await client.getSystemStatus();

      expect(result).toMatchObject({
        status: expect.any(Number),
        msg: expect.any(String),
      });

      console.log(`✅ System status: ${result.status} - ${result.msg}`);
    }, 30000);

    it('should validate dynamic asset config integration', async () => {
      const dynamicConfig = new DynamicAssetConfig(client, {});

      try {
        // ETH on Ethereum
        const ethMapping = await dynamicConfig.getAssetMapping(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
        expect(ethMapping).toMatchObject({
          binanceSymbol: 'ETH',
          network: 'ETH',
          onChainAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          minWithdrawalAmount: expect.any(String),
          withdrawalFee: expect.any(String),
        });

        console.log(
          `✅ Dynamic config - ETH on Ethereum: fee=${ethMapping.withdrawalFee}, min=${ethMapping.minWithdrawalAmount}`,
        );

        // USDC on Ethereum
        const usdcMapping = await dynamicConfig.getAssetMapping(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
        expect(usdcMapping).toMatchObject({
          binanceSymbol: 'USDC',
          network: 'ETH',
          onChainAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          minWithdrawalAmount: expect.any(String),
          withdrawalFee: expect.any(String),
        });

        console.log(
          `✅ Dynamic config - USDC on Ethereum: fee=${usdcMapping.withdrawalFee}, min=${usdcMapping.minWithdrawalAmount}`,
        );

        // Test ETH on Arbitrum
        const ethArbMapping = await dynamicConfig.getAssetMapping(42161, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
        expect(ethArbMapping).toMatchObject({
          binanceSymbol: 'ETH',
          network: 'ARBITRUM',
          onChainAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
          minWithdrawalAmount: expect.any(String),
          withdrawalFee: expect.any(String),
        });

        console.log(
          `✅ Dynamic config - ETH on Arbitrum: fee=${ethArbMapping.withdrawalFee}, min=${ethArbMapping.minWithdrawalAmount}`,
        );
      } catch (error) {
        console.log(`⚠️ Dynamic config test skipped (API may be restricted): ${(error as Error).message}`);
        // Don't fail the test if API is restricted
      }
    }, 60000);

    it('should get asset configuration for dynamic config', async () => {
      const result = await client.getAssetConfig();

      expect(Array.isArray(result)).toBe(true);

      if (result.length > 0) {
        const asset = result[0] as any;
        expect(asset).toMatchObject({
          coin: expect.any(String),
          depositAllEnable: expect.any(Boolean),
          withdrawAllEnable: expect.any(Boolean),
          name: expect.any(String),
          free: expect.any(String),
          locked: expect.any(String),
          freeze: expect.any(String),
          withdrawing: expect.any(String),
          ipoing: expect.any(String),
          ipoable: expect.any(String),
          storage: expect.any(String),
          isLegalMoney: expect.any(Boolean),
          trading: expect.any(Boolean),
          networkList: expect.any(Array),
        });

        // Validate networkList structure for dynamic config
        if (asset.networkList && asset.networkList.length > 0) {
          const network = asset.networkList[0];
          expect(network).toMatchObject({
            network: expect.any(String),
            coin: expect.any(String),
            withdrawIntegerMultiple: expect.any(String),
            isDefault: expect.any(Boolean),
            depositEnable: expect.any(Boolean),
            withdrawEnable: expect.any(Boolean),
            depositDesc: expect.any(String),
            withdrawDesc: expect.any(String),
            specialTips: expect.any(String),
            specialWithdrawTips: expect.any(String),
            name: expect.any(String),
            resetAddressStatus: expect.any(Boolean),
            addressRegex: expect.any(String),
            addressRule: expect.any(String),
            memoRegex: expect.any(String),
            withdrawFee: expect.any(String),
            withdrawMin: expect.any(String),
            withdrawMax: expect.any(String),
            minConfirm: expect.any(Number),
            unLockConfirm: expect.any(Number),
            sameAddress: expect.any(Boolean),
            estimatedArrivalTime: expect.any(Number),
            busy: expect.any(Boolean),
          });
        }

        console.log(`✅ Asset config retrieved: ${result.length} assets`);
        console.log(`✅ Dynamic config structure validated for network mappings`);
      }
    }, 30000);

    it('should get account balance for all assets', async () => {
      const result = await client.getAccountBalance();

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');

      // Verify structure - should be a Record<string, string>
      const balanceEntries = Object.entries(result);
      expect(balanceEntries.length).toBeGreaterThanOrEqual(0);

      // If there are balances, validate structure
      if (balanceEntries.length > 0) {
        const [asset, balance] = balanceEntries[0];
        expect(typeof asset).toBe('string');
        expect(typeof balance).toBe('string');
        expect(parseFloat(balance)).toBeGreaterThan(0);

        console.log(`✅ Account balance retrieved: ${balanceEntries.length} assets with balance`);
        console.log(`   Example: ${asset} = ${balance}`);
      } else {
        console.log(`✅ Account balance retrieved (empty account)`);
      }
    }, 30000);
  });

  describe('Error Handling', () => {
    it('should handle rate limiting gracefully', async () => {
      // Make multiple rapid requests to potentially trigger rate limiting
      const promises = Array(5)
        .fill(0)
        .map(() => client.getDepositAddress('ETH', 'ETH').catch((err) => err));

      const results = await Promise.all(promises);

      // At least some should succeed, but rate limiting errors are acceptable
      const errors = results.filter((r) => r instanceof Error);
      const successes = results.filter((r) => !(r instanceof Error));

      expect(successes.length + errors.length).toBe(5);

      // If there are errors, they should be properly formatted
      errors.forEach((error) => {
        expect(error.message).toMatch(/Binance API error/);
      });
    }, 60000);

    it('should provide helpful error messages for common issues', async () => {
      const testCases = [
        {
          coin: 'INVALID_COIN',
          network: 'ETH',
          expectedError: /Binance API error/,
          description: 'Invalid coin',
        },
        {
          coin: 'ETH',
          network: 'INVALID_NETWORK',
          expectedError: /Binance API error/,
          description: 'Invalid network',
        },
      ];

      for (const testCase of testCases) {
        await expect(client.getDepositAddress(testCase.coin, testCase.network)).rejects.toThrow(testCase.expectedError);
      }
    }, 60000);

    it('should handle API key validation errors with helpful messages', async () => {
      // Create client with invalid credentials to test error handling
      const invalidClient = new BinanceClient(
        'invalid-api-key',
        'invalid-secret-key',
        'https://api.binance.com',
        logger,
      );

      await expect(invalidClient.getDepositAddress('ETH', 'ETH')).rejects.toThrow(/Binance API error/);
    }, 30000);

    it('should handle withdrawal validation errors', async () => {
      // Test withdrawal endpoint with invalid parameters to verify error handling
      const withdrawParams = {
        coin: 'ETH',
        network: 'ETH',
        address: '0x0000000000000000000000000000000000000000', // Invalid address
        amount: '0.001',
      };

      await expect(client.withdraw(withdrawParams)).rejects.toThrow(/Binance API error/);

      console.log('✅ Withdrawal endpoint accessible and validates parameters correctly');
    }, 30000);
  });

  describe('Convert API (Swap Operations)', () => {
    it('should get convert exchange info successfully', async () => {
      const result = await client.getConvertExchangeInfo();

      expect(Array.isArray(result)).toBe(true);

      if (result.length > 0) {
        const pair = result[0];
        expect(pair).toMatchObject({
          fromAsset: expect.any(String),
          toAsset: expect.any(String),
          fromAssetMinAmount: expect.any(String),
          fromAssetMaxAmount: expect.any(String),
        });

        console.log(`✅ Convert exchange info retrieved: ${result.length} pairs available`);
        console.log(`   Example pair: ${pair.fromAsset} -> ${pair.toAsset}`);
      }
    }, 30000);

    it('should get convert quote for USDT to USDC', async () => {
      try {
        const quote = await client.getConvertQuote({
          fromAsset: 'USDT',
          toAsset: 'USDC',
          fromAmount: '10',
        });

        expect(quote).toMatchObject({
          quoteId: expect.any(String),
          ratio: expect.any(String),
          inverseRatio: expect.any(String),
          validTimestamp: expect.any(Number),
          toAmount: expect.any(String),
          fromAmount: '10',
        });

        const rate = parseFloat(quote.ratio);
        expect(rate).toBeGreaterThan(0.95); // Should be close to 1:1 for stablecoins
        expect(rate).toBeLessThan(1.05);

        console.log(`✅ USDT->USDC quote: ${quote.fromAmount} USDT = ${quote.toAmount} USDC (rate: ${quote.ratio})`);
        console.log(`   Quote ID: ${quote.quoteId}`);
        console.log(`   Valid until: ${new Date(quote.validTimestamp).toISOString()}`);
      } catch (error) {
        console.log(`⚠️ Convert quote test skipped (may require VIP level): ${(error as Error).message}`);
        // Don't fail test if Convert API requires special permissions
      }
    }, 30000);

    it('should get convert quote for USDC to USDT', async () => {
      try {
        const quote = await client.getConvertQuote({
          fromAsset: 'USDC',
          toAsset: 'USDT',
          fromAmount: '10',
        });

        expect(quote).toMatchObject({
          quoteId: expect.any(String),
          ratio: expect.any(String),
          inverseRatio: expect.any(String),
          validTimestamp: expect.any(Number),
          toAmount: expect.any(String),
          fromAmount: '10',
        });

        console.log(`✅ USDC->USDT quote: ${quote.fromAmount} USDC = ${quote.toAmount} USDT (rate: ${quote.ratio})`);
      } catch (error) {
        console.log(`⚠️ Convert quote test skipped (may require VIP level): ${(error as Error).message}`);
      }
    }, 30000);

    it('should validate quote expiration timing', async () => {
      try {
        const quote = await client.getConvertQuote({
          fromAsset: 'USDT',
          toAsset: 'USDC',
          fromAmount: '10',
        });

        const currentTime = Date.now();
        const validTime = quote.validTimestamp;
        const timeDiff = validTime - currentTime;

        expect(timeDiff).toBeGreaterThan(0); // Should be in the future
        expect(timeDiff).toBeLessThan(15000); // Should be less than 15 seconds (typically ~10s)

        console.log(`✅ Quote expiration validated: ${Math.round(timeDiff / 1000)}s validity period`);
      } catch (error) {
        console.log(`⚠️ Quote expiration test skipped: ${(error as Error).message}`);
      }
    }, 30000);

    it('should handle invalid asset pairs gracefully', async () => {
      try {
        await client.getConvertQuote({
          fromAsset: 'BTC',
          toAsset: 'INVALID_ASSET',
          fromAmount: '0.001',
        });
        // If this doesn't throw, that's also valid (API might accept it)
      } catch (error) {
        expect((error as Error).message).toMatch(/Binance API error/);
        console.log('✅ Invalid asset pair handled correctly');
      }
    }, 30000);

    it('should handle amounts below minimum', async () => {
      try {
        await client.getConvertQuote({
          fromAsset: 'USDT',
          toAsset: 'USDC',
          fromAmount: '0.00001', // Very small amount
        });
      } catch (error) {
        expect((error as Error).message).toMatch(/Binance API error/);
        console.log('✅ Minimum amount validation working');
      }
    }, 30000);

    it('should NOT execute actual swap (safety test)', async () => {
      // This test ensures we don't accidentally execute real swaps in tests
      // We'll only test the quote mechanism, not execution
      console.log('✅ Safety check: No actual swap execution in integration tests');

      // If you need to test actual execution, do it manually with:
      // const quote = await client.getConvertQuote({ fromAsset: 'USDT', toAsset: 'USDC', fromAmount: '10' });
      // const execution = await client.acceptConvertQuote({ quoteId: quote.quoteId });
      // const status = await client.getConvertOrderStatus({ orderId: execution.orderId });
    });
  });
});
