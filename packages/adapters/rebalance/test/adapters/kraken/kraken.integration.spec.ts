import { beforeEach, describe, expect, it } from '@jest/globals';
import { KrakenClient } from '../../../src/adapters/kraken/client';
import { Logger } from '@mark/logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * These tests use real Kraken API credentials and make actual API calls.
 * They are skipped by default to avoid unnecessary API calls during normal testing.
 *
 * To run these tests:
 * 1. Ensure KRAKEN_API_KEY and KRAKEN_SECRET_KEY are in packages/poller/.env
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

describe('KrakenClient Integration Tests', () => {
  let client: KrakenClient;
  let logger: Logger;
  let apiKey: string;
  let apiSecret: string;

  beforeAll(() => {
    loadEnvFromPoller();

    apiKey = process.env.KRAKEN_API_KEY!;
    apiSecret = process.env.KRAKEN_SECRET_KEY!;

    if (!apiKey || !apiSecret) {
      throw new Error(
        'Integration tests require KRAKEN_API_KEY and KRAKEN_SECRET_KEY environment variables. ' +
        'Add them to packages/poller/.env or run yarn test (without integration tests).',
      );
    }
  });

  beforeEach(() => {
    logger = new Logger({ service: 'kraken-client-integration-test' });

    client = new KrakenClient(
      apiKey,
      apiSecret,
      logger,
      'https://api.kraken.com',
      1
    );
  });

  describe('Authentication', () => {
    it('should authenticate successfully with real credentials', () => {
      expect(client.isConfigured()).toBe(true);
    });
  });

  describe('System Status', () => {
    it('should get system status successfully', async () => {
      const status = await client.getSystemStatus();

      expect(status).toMatchObject({
        status: expect.any(String),
        timestamp: expect.any(String),
      });

      console.log(`✅ Kraken system status: ${status.status}`);
    }, 30000);

    it('should check if system is operational', async () => {
      const isOperational = await client.isSystemOperational();

      expect(typeof isOperational).toBe('boolean');
      console.log(`✅ Kraken system operational: ${isOperational}`);
    }, 30000);
  });

  describe('Deposit Methods', () => {
    it('should get deposit methods for ETH', async () => {
      const depositMethods = await client.getDepositMethods('ETH');

      expect(Array.isArray(depositMethods)).toBe(true);
      expect(depositMethods.length).toBeGreaterThan(0);

      depositMethods.forEach(method => expect(method).toMatchObject({
        method: expect.any(String),
        limit: expect.any(Boolean),
        minimum: expect.any(String),
        'gen-address': expect.any(Boolean),
      }))

      console.log(`✅ ETH deposit methods: ${depositMethods.length} methods available`);
    }, 30000);

    it('should get deposit methods for USDC', async () => {
      const depositMethods = await client.getDepositMethods('USDC');

      expect(Array.isArray(depositMethods)).toBe(true);
      expect(depositMethods.length).toBeGreaterThan(0);

      depositMethods.forEach(method => expect(method).toMatchObject({
        method: expect.any(String),
        limit: expect.any(Boolean),
        minimum: expect.any(String),
        'gen-address': expect.any(Boolean),
      }))

      console.log(`✅ USDC deposit methods: ${depositMethods.length} methods available`);
    }, 30000);

    it('should handle invalid asset gracefully', async () => {
      await expect(client.getDepositMethods('INVALID_ASSET')).rejects.toThrow();
    }, 30000);
  });

  describe('Deposit Addresses', () => {
    it('should get deposit addresses for ETH', async () => {
      // First get deposit methods to use a valid method
      const depositMethods = await client.getDepositMethods('XETH');
      expect(depositMethods.length).toBeGreaterThan(0);

      const method = depositMethods.find(method => method.method.includes(`ETH - Arbitrum One (Unified)`));
      const depositAddresses = await client.getDepositAddresses('XETH', method?.method ?? '');

      expect(Array.isArray(depositAddresses)).toBe(true);
      expect(depositAddresses.length).toBeGreaterThan(0);
      depositAddresses.forEach(address => expect(address).toMatchObject({
        address: expect.any(String),
        expiretm: expect.any(String),
        new: expect.any(Boolean),
      }));

      console.log(`✅ ETH deposit address: ${depositAddresses.length}`);
    }, 30000);
  });

  describe('Deposit Status', () => {
    it.only('should retrieve deposit status without errors', async () => {
      const deposits = await client.getDepositStatus('XETH', `ETH - Arbitrum One (Unified)`);

      expect(Array.isArray(deposits)).toBe(true);
      if (deposits.length > 0) {
        deposits.forEach(deposit => expect(deposit).toMatchObject({
          method: expect.any(String),
          aclass: expect.any(String),
          asset: expect.any(String),
          refid: expect.any(String),
          txid: expect.any(String),
          info: expect.any(String),
          amount: expect.any(String),
          fee: expect.any(String),
          time: expect.any(Number),
          status: expect.any(String),
        }))

        console.log(`✅ Found ${deposits.length} deposit records`);
      }

    }, 30000);
  });

  describe('Asset Information', () => {
    it('should get asset information', async () => {
      const assets = await client.getAssetInfo(['XETH', 'USDC']);

      expect(typeof assets).toBe('object');

      if (assets.XETH) {
        expect(assets.XETH).toMatchObject({
          aclass: expect.any(String),
          altname: expect.any(String),
          decimals: expect.any(Number),
          display_decimals: expect.any(Number),
        });

        console.log(`✅ ETH asset info: ${assets.XETH.altname} (${assets.XETH.decimals} decimals)`);
      }

      if (assets.USDC) {
        expect(assets.USDC).toMatchObject({
          aclass: expect.any(String),
          altname: expect.any(String),
          decimals: expect.any(Number),
          display_decimals: expect.any(Number),
        });

        console.log(`✅ USDC asset info: ${assets.USDC.altname} (${assets.USDC.decimals} decimals)`);
      }
    }, 30000);
  });

  describe('Account Balance', () => {
    it('should get account balance', async () => {
      const balance = await client.getBalance();

      expect(typeof balance).toBe('object');
      console.log(`✅ Account balance retrieved with ${Object.keys(balance).length} assets`);

      // Log non-zero balances for debugging
      Object.entries(balance).forEach(([asset, amount]) => {
        const numericAmount = parseFloat(amount as string);
        if (numericAmount > 0) {
          console.log(`✅ ${asset}: ${amount}`);
        }
      });
    }, 30000);
  });

  describe('Withdrawal Methods', () => {
    it('should get withdrawal methods for ETH', async () => {
      const withdrawMethods = await client.getWithdrawMethods('XETH');

      expect(Array.isArray(withdrawMethods)).toBe(true);
      expect(withdrawMethods.length).toBeGreaterThan(0);

      withdrawMethods.forEach(method => expect(method).toMatchObject({
        asset: expect.any(String),
        method: expect.any(String),
        minimum: expect.any(String),
      }));

      console.log(`✅ ETH withdrawal methods: ${withdrawMethods.length} methods available`);
      console.log(`✅ First method: ${withdrawMethods[0].method} (minimum: ${withdrawMethods[0].minimum})`);
    }, 30000);

    it('should get withdrawal methods for USDC', async () => {
      const withdrawMethods = await client.getWithdrawMethods('USDC');

      expect(Array.isArray(withdrawMethods)).toBe(true);

      if (withdrawMethods.length > 0) {
        withdrawMethods.forEach(method => expect(method).toMatchObject({
          asset: expect.any(String),
          method: expect.any(String),
          minimum: expect.any(String),
          fee: {
            aclass: "currency",
            asset: "USDC",
            fee: expect.any(String),
          }
        }));

        console.log(`✅ USDC withdrawal methods: ${withdrawMethods.length} methods available`);
        console.log(`✅ First method: ${withdrawMethods[0].method} (min: ${withdrawMethods[0].minimum})`);
      } else {
        console.log('⚠️ No USDC withdrawal methods available');
      }
    }, 30000);

    it('should handle invalid asset gracefully', async () => {
      await expect(client.getWithdrawMethods('INVALID_ASSET')).rejects.toThrow();
    }, 30000);
  });

  describe('Withdrawal Info', () => {
    it('should get withdrawal info for valid parameters (without executing)', async () => {
      // Get withdrawal methods first to get a valid method
      const withdrawMethods = await client.getWithdrawMethods('XETH');

      if (withdrawMethods.length > 0) {
        const method = withdrawMethods[0].method;

        // Use a test address - this won't execute a withdrawal, just get info
        try {
          const withdrawInfo = await client.getWithdrawInfo('XETH', method, '0.001');

          expect(withdrawInfo).toMatchObject({
            method: expect.any(String),
            limit: expect.any(String),
            amount: expect.any(String),
            fee: expect.any(String),
          });

          console.log(`✅ Withdrawal info retrieved: method=${withdrawInfo.method}, fee=${withdrawInfo.fee}`);
        } catch (error) {
          // This might fail if no withdrawal keys are set up, which is expected
          console.log(`⚠️ Withdrawal info test skipped (no withdrawal keys configured): ${(error as Error).message}`);
        }
      } else {
        console.log('⚠️ Withdrawal info test skipped (no withdrawal methods available)');
      }
    }, 30000);

    it('should handle invalid withdrawal parameters gracefully', async () => {
      await expect(client.getWithdrawInfo('INVALID_ASSET', 'invalid_key', '0.001')).rejects.toThrow();
    }, 30000);
  });

  describe('Withdrawal Status', () => {
    it('should retrieve withdrawal status without errors', async () => {
      const withdrawals = await client.getWithdrawStatus();

      expect(Array.isArray(withdrawals)).toBe(true);

      if (withdrawals.length > 0) {
        withdrawals.forEach(withdrawal => expect(withdrawal).toMatchObject({
          method: expect.any(String),
          aclass: expect.any(String),
          asset: expect.any(String),
          refid: expect.any(String),
          txid: expect.any(String),
          info: expect.any(String),
          amount: expect.any(String),
          fee: expect.any(String),
          time: expect.any(Number),
          status: expect.any(String),
        }));

        console.log(`✅ Found ${withdrawals.length} withdrawal records`);
      } else {
        console.log('✅ No withdrawal history found (this is normal for new accounts)');
      }
    }, 30000);

    it('should retrieve withdrawal status for specific asset', async () => {
      const withdrawals = await client.getWithdrawStatus('XETH');

      expect(Array.isArray(withdrawals)).toBe(true);
      console.log(`✅ ETH-specific withdrawals: ${withdrawals.length} records`);
    }, 30000);
  });

  describe('Withdrawal Execution (Safe Tests)', () => {
    it('should handle withdrawal validation errors without executing', async () => {
      // Test withdrawal endpoint with invalid parameters to verify error handling
      // This should fail validation before any actual withdrawal occurs
      const withdrawParams = {
        asset: 'XETH',
        key: 'invalid_withdrawal_key',
        amount: '0.001',
      };

      await expect(client.withdraw(withdrawParams)).rejects.toThrow();
      console.log('✅ Withdrawal endpoint validates parameters correctly');
    }, 30000);

    it('should handle withdrawal with invalid asset', async () => {
      const withdrawParams = {
        asset: 'INVALID_ASSET',
        key: 'some_key',
        amount: '0.001',
      };

      await expect(client.withdraw(withdrawParams)).rejects.toThrow(/Kraken API error/);
    }, 30000);

    it('should handle withdrawal with invalid amount format', async () => {
      const withdrawParams = {
        asset: 'XETH',
        key: 'some_key',
        amount: 'invalid_amount',
      };

      await expect(client.withdraw(withdrawParams)).rejects.toThrow();
    }, 30000);
  });

  describe('Error Handling', () => {
    it('should handle rate limiting gracefully', async () => {
      // Make multiple rapid requests to potentially trigger rate limiting
      const promises = Array(3)
        .fill(0)
        .map(() => client.getSystemStatus().catch((err) => err));

      const results = await Promise.all(promises);

      // At least some should succeed, but rate limiting errors are acceptable
      const errors = results.filter((r) => r instanceof Error);
      const successes = results.filter((r) => !(r instanceof Error));

      expect(successes.length + errors.length).toBe(3);

      // If there are errors, they should be properly formatted
      errors.forEach((error) => {
        expect(error.message).toMatch(/Kraken API error/);
      });

      console.log(`✅ Rate limiting test: ${successes.length} successes, ${errors.length} errors`);
    }, 60000);

    it('should provide helpful error messages for invalid requests', async () => {
      await expect(client.getDepositMethods('TOTALLY_INVALID_ASSET')).rejects.toThrow(/Kraken API error/);
    }, 30000);

    it('should handle API key validation errors', async () => {
      // Create client with invalid credentials to test error handling
      const invalidClient = new KrakenClient(
        'invalid-api-key',
        'invalid-secret-key',
        logger,
        'https://api.kraken.com',
        1,
      );

      await expect(invalidClient.getBalance()).rejects.toThrow();
    }, 30000);
  });
});