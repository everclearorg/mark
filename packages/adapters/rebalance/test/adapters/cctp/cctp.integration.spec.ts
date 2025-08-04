import { describe, it, expect, beforeEach } from '@jest/globals';
import { CctpBridgeAdapter } from '../../../src/adapters/cctp/cctp';
import { Logger } from '@mark/logger';
import { USDC_CONTRACTS } from '../../../src/adapters/cctp/constants';
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import { AssetConfiguration } from '@mark/core';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const mockAssets: Record<string, AssetConfiguration> = {
  ETH: {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'ETH',
      decimals: 18,
      tickerHash: '0xETHHash',
      isNative: true,
      balanceThreshold: '0',
  },
  USDC_ETH: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
      tickerHash: '0xUSDCHash',
      isNative: false,
      balanceThreshold: '0',
  },
  USDC_ARB: {
      address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      symbol: 'USDC',
      decimals: 6,
      tickerHash: '0xUSDCHash',
      isNative: false,
      balanceThreshold: '0',
  },
};

const mockChains: Record<string, any> = {
  '1': {
      assets: [mockAssets.ETH, mockAssets.USDC_ETH],
      providers: ['https://eth.llamarpc.com'],
      invoiceAge: 3600,
      gasThreshold: '100000000000',
      deployments: {
          everclear: '0xEverclearAddress',
          permit2: '0xPermit2Address',
          multicall3: '0xMulticall3Address',
      },
  },
  '8453': { // Base chain
      assets: [mockAssets.ETH, mockAssets.USDC_ETH],
      providers: ['https://mainnet.base.org'],
      invoiceAge: 3600,
      gasThreshold: '100000000000',
      deployments: {
          everclear: '0xEverclearAddress',
          permit2: '0xPermit2Address',
          multicall3: '0xMulticall3Address',
      },
  },
  '42161': { // Arbitrum chain
      assets: [mockAssets.ETH, mockAssets.USDC_ARB],
      providers: ['https://arb1.arbitrum.io/rpc'],
      invoiceAge: 3600,
      gasThreshold: '100000000000',
      deployments: {
          everclear: '0xEverclearAddress',
          permit2: '0xPermit2Address',
          multicall3: '0xMulticall3Address',
      },
  },
};

const sender = '0x8c0bcb51508675535e43760fb93B7F5dcD1b73d0';
const recipient = '0x8c0bcb51508675535e43760fb93B7F5dcD1b73d0';
const amount = '1000000';
const route = { asset: USDC_CONTRACTS['arbitrum'], origin: 42161, destination: 8453 };

// V1
describe('CctpBridgeAdapter Integration (V1)', () => {
  let adapter: CctpBridgeAdapter;

  beforeEach(() => {
    adapter = new CctpBridgeAdapter('v1', mockChains, mockLogger);
  });

  it('should return the minimum fee for standard transfer from getReceivedAmount', async () => {
    const testRoute = { asset: USDC_CONTRACTS['arbitrum'], origin: 42161, destination: 10 };
    const result = await adapter.getReceivedAmount(amount, testRoute);
    expect(typeof result).toBe("string");
    expect(Number(result)).not.toBeNaN();
  });

  it('should throw an error if fast transfer is called on V1 from getReceivedAmountFast', async () => {
    const testRoute = { asset: USDC_CONTRACTS['arbitrum'], origin: 42161, destination: 10 };
    await expect(adapter.getReceivedAmountFast(amount, testRoute)).rejects.toThrow('Fast transfer is not supported for CCTP v1');
  });

  it('should throw an error if asset is not supported from getReceivedAmount', async () => {
    const testRoute = { asset: '0x0000000000000000000000000000000000000000', origin: 42161, destination: 10 };
    await expect(adapter.getReceivedAmount(amount, testRoute)).rejects.toThrow('Asset 0x0000000000000000000000000000000000000000 is not a supported asset for CCTP');
  });

  it('should generate approval and burn transactions from send', async () => {
    const txs = await adapter.send(sender, recipient, amount, route);
    expect(txs.length).toBeGreaterThan(0);
    expect(txs.some(tx => tx.transaction.data)).toBe(true);
  });

  it('should throw an error if asset is not supported from send', async () => {
    const testRoute = { asset: '0x0000000000000000000000000000000000000000', origin: 42161, destination: 10 };
    await expect(adapter.send(sender, recipient, amount, testRoute)).rejects.toThrow('Asset 0x0000000000000000000000000000000000000000 is not a supported asset for CCTP');
  });

  it('should check readyOnDestination', async () => {
    const transactionHash = '0x7a97c8a0dfdb9f5016a11c9f5f4ddf12f79151ffa61f76eb4e75f63b84e19d7b';
    const client = createPublicClient({
      chain: arbitrum,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    const ready = await adapter.readyOnDestination(amount, route, receipt);
    expect(typeof ready).toBe('boolean');
    expect(ready).toBe(true);
  });

  it('should poll attestation and return true when ready (real call)', async () => {
    const messageHash = '0xee99e47c242fce95623a2d07410c0ca13c1f3e484d257fc1913e0a0c2034ff2b';
    const ready = await (adapter as any).pollAttestation(messageHash, 'arbitrum');
    expect(typeof ready).toBe('boolean');
  });

  it('should fetch attestation and return messageBytes and attestation (real call)', async () => {
    const messageHash = '0xee99e47c242fce95623a2d07410c0ca13c1f3e484d257fc1913e0a0c2034ff2b';
    const result = await (adapter as any).fetchAttestation(messageHash, 'arbitrum');
    expect(result).toHaveProperty('messageBytes');
    expect(result).toHaveProperty('attestation');
  });

  it('should generate mint transaction after attestation from destinationCallback', async () => {
    const transactionHash = '0x7a97c8a0dfdb9f5016a11c9f5f4ddf12f79151ffa61f76eb4e75f63b84e19d7b';
    const client = createPublicClient({
      chain: arbitrum,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    const tx = await adapter.destinationCallback(route, receipt);
    expect(tx && tx.transaction.data).toBeDefined();
  });
});

// V2 Tests
describe('CctpBridgeAdapter Integration (V2)', () => {
  let v2adapter: CctpBridgeAdapter;

  beforeEach(() => {
    v2adapter = new CctpBridgeAdapter('v2', mockChains, mockLogger);
  });

  it('should return the minimum fee for standard transfer from getReceivedAmount', async () => {
    const testRoute = { asset: USDC_CONTRACTS['arbitrum'], origin: 42161, destination: 10 };
    const result = await v2adapter.getReceivedAmount(amount, testRoute);
    expect(typeof result).toBe("string");
    expect(Number(result)).not.toBeNaN();
  });

  it('should return the highest minimumFee as a string from the API response (V2)', async () => {
    const testRoute = { asset: USDC_CONTRACTS['arbitrum'], origin: 42161, destination: 10 };
    const result = await v2adapter.getReceivedAmountFast(amount, testRoute);
    expect(typeof result).toBe("string");
    expect(Number(result)).not.toBeNaN();
  });

  it('should throw an error if asset is not supported from getReceivedAmount', async () => {
    const testRoute = { asset: '0x0000000000000000000000000000000000000000', origin: 42161, destination: 10 };
    await expect(v2adapter.getReceivedAmount(amount, testRoute)).rejects.toThrow('Asset 0x0000000000000000000000000000000000000000 is not a supported asset for CCTP');
  });

  it('should throw an error if asset is not supported from getReceivedAmountFast', async () => {
    const testRoute = { asset: '0x0000000000000000000000000000000000000000', origin: 42161, destination: 10 };
    await expect(v2adapter.getReceivedAmountFast(amount, testRoute)).rejects.toThrow('Asset 0x0000000000000000000000000000000000000000 is not a supported asset for CCTP');
  });

  it('should generate approval and burn transactions from send', async () => {
    const txs = await v2adapter.send(sender, recipient, amount, route);
    expect(txs.length).toBeGreaterThan(0);
    expect(txs.some(tx => tx.transaction.data)).toBe(true);
  });

  it('should throw an error if asset is not supported from send', async () => {
    const testRoute = { asset: '0x0000000000000000000000000000000000000000', origin: 42161, destination: 10 };
    await expect(v2adapter.send(sender, recipient, amount, testRoute)).rejects.toThrow('Asset 0x0000000000000000000000000000000000000000 is not a supported asset for CCTP');
  });

  it('should check readyOnDestination', async () => {
    const transactionHash = '0x291db8e84ad8e7a11364fc276f3e2bd128de18374a0c8e24cbfdb1b3cc728f17';
    const client = createPublicClient({
      chain: arbitrum,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    const ready = await v2adapter.readyOnDestination(amount, route, receipt);
    expect(typeof ready).toBe('boolean');
  });

  it('should poll attestation and return true/false when ready (real call)', async () => {
    const transactionHash = '0x291db8e84ad8e7a11364fc276f3e2bd128de18374a0c8e24cbfdb1b3cc728f17';
    const ready = await (v2adapter as any).pollAttestation(transactionHash, 3);
    expect(ready).toBe(true);
  });

  it('should fetch attestation and return messageBytes and attestation (real call)', async () => {
    const transactionHash = '0x291db8e84ad8e7a11364fc276f3e2bd128de18374a0c8e24cbfdb1b3cc728f17';
    const result = await (v2adapter as any).fetchAttestation(transactionHash, 3);
    expect(result).toHaveProperty('messageBytes');
    expect(result).toHaveProperty('attestation');
  });

  it('should generate mint transaction after attestation from destinationCallback', async () => {
    const transactionHash = '0x291db8e84ad8e7a11364fc276f3e2bd128de18374a0c8e24cbfdb1b3cc728f17';
    const client = createPublicClient({
      chain: arbitrum,
      transport: http('https://arb1.arbitrum.io/rpc'),
    });
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    const tx = await v2adapter.destinationCallback(route, receipt);
    expect(tx && tx.transaction.data).toBeDefined();
  });
});