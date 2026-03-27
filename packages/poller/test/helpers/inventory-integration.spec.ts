import { SinonStubbedInstance, stub, createStubInstance, restore } from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import * as assetModule from '../../src/helpers/asset';
import * as zodiacModule from '../../src/helpers/zodiac';
import { getMarkBalances } from '../../src/helpers/balance';
import { submitTransactionWithLogging } from '../../src/helpers/transactions';
import { AssetConfiguration, MarkConfiguration, WalletType } from '@mark/core';
import { PrometheusAdapter } from '@mark/prometheus';
import { ChainService } from '@mark/chainservice';
import { InventoryServiceClient } from '@mark/inventory';

describe('Inventory Integration', () => {
  const mockAssetConfig: AssetConfiguration = { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, tickerHash: '0xusdc', isNative: false, balanceThreshold: '10000000000' };
  const mockConfig = { ownAddress: '0xOwnAddress', ownSolAddress: 'SolAddress', chains: { '1': { providers: ['https://rpc'], assets: [mockAssetConfig] } } } as unknown as MarkConfiguration;

  let prometheus: SinonStubbedInstance<PrometheusAdapter>;
  let chainService: SinonStubbedInstance<ChainService>;
  let inventory: SinonStubbedInstance<InventoryServiceClient>;

  beforeEach(() => {
    prometheus = createStubInstance(PrometheusAdapter);
    chainService = createStubInstance(ChainService);
    inventory = createStubInstance(InventoryServiceClient);
    chainService.getAddress.resolves({ '1': '0xOwnAddress' });
    stub(assetModule, 'getTickers').returns(['0xusdc']);
    stub(assetModule, 'convertTo18Decimals').callsFake((val: bigint) => val * 10n ** 12n);
  });

  afterEach(() => { restore(); });

  describe('getMarkBalances with inventory (double-counting fix)', () => {
    it('should use inventory availableBalance for EVM chains', async () => {
      inventory.getInventoryBalance.resolves({ chainId: '1', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', totalBalance: '5000000', availableBalance: '3000000', reservedByType: {}, pendingInbound: '0', pendingIntents: '0', reservationCount: 2, timestamp: Date.now() });
      const balances = await getMarkBalances(mockConfig, chainService, prometheus, inventory);
      expect(inventory.getInventoryBalance.calledOnce).toBe(true);
      expect(balances.get('0xusdc')!.get('1')).toBe(3000000n * 10n ** 12n);
    });

    it('should return 0n when inventory returns undefined (conservative)', async () => {
      inventory.getInventoryBalance.resolves(undefined);
      const balances = await getMarkBalances(mockConfig, chainService, prometheus, inventory);
      expect(balances.get('0xusdc')!.get('1')).toBe(0n);
    });

    it('should use on-chain balance when no inventory provided', async () => {
      const mockContract = { read: { balanceOf: stub().resolves(5000000n) } };
      stub(contractModule, 'getERC20Contract').resolves(mockContract as any);
      stub(zodiacModule, 'getValidatedZodiacConfig').returns({ walletType: WalletType.EOA });
      stub(zodiacModule, 'getActualOwner').returns('0xOwnAddress');
      const balances = await getMarkBalances(mockConfig, chainService, prometheus);
      expect(balances.get('0xusdc')!.get('1')).toBe(5000000n * 10n ** 12n);
    });
  });

  describe('submitTransactionWithLogging nonce management', () => {
    const baseTx = { to: '0xAddr', data: '0x1234', chainId: 1, from: '0xOwner', value: '0', funcSig: 'test()' };
    const mockReceipt = { transactionHash: '0xtxhash', from: '0xOwner', to: '0xAddr', cumulativeGasUsed: '21000', effectiveGasPrice: '1000000000', blockNumber: 100, status: 1, logs: [], confirmations: 1 };
    let mockLogger: any;

    beforeEach(() => { mockLogger = { info: stub(), warn: stub(), error: stub(), debug: stub() }; });

    it('should assign nonce and confirm on success', async () => {
      inventory.assignNonce.resolves({ nonce: 42, nonceId: '1:0xw:42', chainId: '1', wallet: '0xw', assignedAt: Date.now() });
      chainService.submitAndMonitor.resolves(mockReceipt);
      const result = await submitTransactionWithLogging({ chainService, logger: mockLogger, chainId: '1', txRequest: baseTx, zodiacConfig: { walletType: WalletType.EOA }, inventory, walletAddress: '0xOwner', operationId: 'op-1' });
      expect(inventory.assignNonce.calledOnce).toBe(true);
      expect(inventory.confirmNonce.calledOnce).toBe(true);
      expect(inventory.confirmNonce.firstCall.args).toEqual(['1', '0xOwner', 42, '0xtxhash']);
      expect(result.nonceAssignment?.nonce).toBe(42);
    });

    it('should report nonce failure on tx error', async () => {
      inventory.assignNonce.resolves({ nonce: 43, nonceId: '1:0xw:43', chainId: '1', wallet: '0xw', assignedAt: Date.now() });
      chainService.submitAndMonitor.rejects(new Error('reverted'));
      await expect(submitTransactionWithLogging({ chainService, logger: mockLogger, chainId: '1', txRequest: baseTx, zodiacConfig: { walletType: WalletType.EOA }, inventory, walletAddress: '0xOwner' })).rejects.toThrow('reverted');
      expect(inventory.failNonce.calledOnce).toBe(true);
      expect(inventory.confirmNonce.called).toBe(false);
    });

    it('should fall back when inventory nonce unavailable', async () => {
      inventory.assignNonce.resolves(undefined);
      chainService.submitAndMonitor.resolves(mockReceipt);
      const result = await submitTransactionWithLogging({ chainService, logger: mockLogger, chainId: '1', txRequest: baseTx, zodiacConfig: { walletType: WalletType.EOA }, inventory, walletAddress: '0xOwner' });
      expect(inventory.confirmNonce.called).toBe(false);
      expect(result.nonceAssignment).toBeUndefined();
    });

    it('should not assign nonce without walletAddress', async () => {
      chainService.submitAndMonitor.resolves(mockReceipt);
      await submitTransactionWithLogging({ chainService, logger: mockLogger, chainId: '1', txRequest: baseTx, zodiacConfig: { walletType: WalletType.EOA }, inventory });
      expect(inventory.assignNonce.called).toBe(false);
    });

    it('should not assign nonce without inventory', async () => {
      chainService.submitAndMonitor.resolves(mockReceipt);
      const result = await submitTransactionWithLogging({ chainService, logger: mockLogger, chainId: '1', txRequest: baseTx, zodiacConfig: { walletType: WalletType.EOA } });
      expect(result.hash).toBe('0xtxhash');
    });
  });
});
