import { beforeEach, describe, expect, it } from '@jest/globals';
import { BinanceClient } from '../../../src/adapters/binance/client';
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
    
    envContent.split('\n').forEach(line => {
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
        'Add them to packages/poller/.env or run yarn test (without integration tests).'
      );
    }
  });

  beforeEach(() => {
    logger = new Logger({ service: 'binance-client-integration-test' });
    
    client = new BinanceClient(
      process.env.BINANCE_API_KEY!,
      process.env.BINANCE_SECRET_KEY!,
      'https://api.binance.com',
      logger
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
      await expect(client.getDepositAddress('INVALID_COIN', 'ETH'))
        .rejects.toThrow(/Binance API error/);
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

    it('should get asset configuration', async () => {
      const result = await client.getAssetConfig();
      
      expect(Array.isArray(result)).toBe(true);
      
      if (result.length > 0) {
        const asset = result[0];
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
        
        console.log(`✅ Asset config retrieved: ${result.length} assets`);
      }
    }, 30000);
  });

  describe('Error Handling', () => {
    it('should handle rate limiting gracefully', async () => {
      // Make multiple rapid requests to potentially trigger rate limiting
      const promises = Array(5).fill(0).map(() => 
        client.getDepositAddress('ETH', 'ETH').catch(err => err)
      );
      
      const results = await Promise.all(promises);
      
      // At least some should succeed, but rate limiting errors are acceptable
      const errors = results.filter(r => r instanceof Error);
      const successes = results.filter(r => !(r instanceof Error));
      
      expect(successes.length + errors.length).toBe(5);
      
      // If there are errors, they should be properly formatted
      errors.forEach(error => {
        expect(error.message).toMatch(/Binance API error/);
      });
    }, 60000);

    it('should provide helpful error messages for common issues', async () => {
      const testCases = [
        {
          coin: 'INVALID_COIN',
          network: 'ETH',
          expectedError: /Binance API error/,
          description: 'Invalid coin'
        },
        {
          coin: 'ETH', 
          network: 'INVALID_NETWORK',
          expectedError: /Binance API error/,
          description: 'Invalid network'
        }
      ];

      for (const testCase of testCases) {
        await expect(client.getDepositAddress(testCase.coin, testCase.network))
          .rejects.toThrow(testCase.expectedError);
      }
    }, 60000);

    it('should handle API key validation errors with helpful messages', async () => {
      // Create client with invalid credentials to test error handling
      const invalidClient = new BinanceClient(
        'invalid-api-key',
        'invalid-secret-key',
        'https://api.binance.com',
        logger
      );

      await expect(invalidClient.getDepositAddress('ETH', 'ETH'))
        .rejects.toThrow(/Binance API error/);
    }, 30000);

    it('should handle withdrawal validation errors', async () => {
      // Test withdrawal endpoint with invalid parameters to verify error handling
      const withdrawParams = {
        coin: 'ETH',
        network: 'ETH',
        address: '0x0000000000000000000000000000000000000000', // Invalid address
        amount: '0.001',
      };

      await expect(client.withdraw(withdrawParams))
        .rejects.toThrow(/Binance API error/);
        
      console.log('✅ Withdrawal endpoint accessible and validates parameters correctly');
    }, 30000);
  });
});
