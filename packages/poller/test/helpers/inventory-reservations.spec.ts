import { stub, createStubInstance, restore, SinonStub, SinonStubbedInstance } from 'sinon';

jest.mock('@mark/core', () => ({
  ...jest.requireActual('@mark/core'),
  getDecimalsFromConfig: jest.fn(() => 6),
  getTokenAddressFromConfig: jest.fn(() => '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  getIsNativeFromConfig: jest.fn(() => false),
}));

jest.mock('@mark/database', () => ({
  ...jest.requireActual('@mark/database'),
  createEarmark: jest.fn(),
  getEarmarks: jest.fn().mockResolvedValue([]),
  updateEarmarkStatus: jest.fn(),
  getActiveEarmarkForInvoice: jest.fn().mockResolvedValue(null),
  createRebalanceOperation: jest.fn().mockResolvedValue({ id: 'op-1' }),
  getRebalanceOperations: jest.fn().mockResolvedValue({ operations: [], total: 0 }),
  getRebalanceOperationsByEarmark: jest.fn().mockResolvedValue([]),
  initializeDatabase: jest.fn(),
  getPool: jest.fn(),
  isPaused: jest.fn().mockResolvedValue(false),
}));

import * as database from '@mark/database';
import { InventoryServiceClient } from '@mark/inventory';
import { EarmarkStatus, Invoice } from '@mark/core';
import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { PrometheusAdapter } from '@mark/prometheus';
import { PurchaseCache } from '@mark/cache';
import { RebalanceAdapter } from '@mark/rebalance';
import { ProcessingContext } from '../../src/init';
import { checkAndApproveERC20 } from '../../src/helpers/erc20';
import * as balanceHelpers from '../../src/helpers/balance';
import * as transactionHelper from '../../src/helpers/transactions';
import * as callbacks from '../../src/rebalance/callbacks';
import * as assetHelpers from '../../src/helpers/asset';

describe('Inventory Reservations', () => {
  let inventory: SinonStubbedInstance<InventoryServiceClient>;
  let mockLogger: SinonStubbedInstance<Logger>;
  let chainService: SinonStubbedInstance<ChainService>;
  let prometheus: SinonStubbedInstance<PrometheusAdapter>;
  let rebalance: SinonStubbedInstance<RebalanceAdapter>;
  let purchaseCache: SinonStubbedInstance<PurchaseCache>;

  const OWN_ADDR = '0x1111111111111111111111111111111111111111';
  const TOKEN_ADDR = '0x2222222222222222222222222222222222222222';
  const SPENDER_ADDR = '0x3333333333333333333333333333333333333333';

  const makeContext = (overrides?: Partial<ProcessingContext>): ProcessingContext =>
    ({
      config: { ownAddress: OWN_ADDR, ownSolAddress: 'SolAddr', chains: { '1': { providers: ['http://rpc'], assets: [] }, '42161': { providers: ['http://rpc2'], assets: [] } }, onDemandRoutes: [], routes: [], earmarkTTLMinutes: 60 },
      requestId: 'test-req-1', startTime: Date.now(), logger: mockLogger, chainService, prometheus, rebalance, purchaseCache, inventory, everclear: undefined, web3Signer: undefined, database,
      ...overrides,
    }) as unknown as ProcessingContext;

  beforeEach(() => {
    jest.clearAllMocks();
    inventory = createStubInstance(InventoryServiceClient);
    mockLogger = createStubInstance(Logger);
    chainService = createStubInstance(ChainService);
    prometheus = createStubInstance(PrometheusAdapter);
    rebalance = createStubInstance(RebalanceAdapter);
    purchaseCache = createStubInstance(PurchaseCache);
    chainService.getAddress.resolves({ '1': OWN_ADDR, '42161': OWN_ADDR });
  });

  afterEach(() => { restore(); });

  // ── 1.3 On-Demand Rebalance Reservations ────────────────────────

  describe('on-demand rebalance reservations', () => {
    let executeOnDemandRebalancing: typeof import('../../src/rebalance/onDemand').executeOnDemandRebalancing;

    beforeEach(async () => {
      const mod = await import('../../src/rebalance/onDemand');
      executeOnDemandRebalancing = mod.executeOnDemandRebalancing;
    });

    const mockInvoice: Invoice = { intent_id: 'inv-001', amount: '1000000000000000000', owner: '0x4444444444444444444444444444444444444444', entry_epoch: 1, origin: '42161', destinations: ['1'], ticker_hash: '0xusdc', discountBps: 10, hub_status: 'INVOICED', hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000) };

    it('should create reservation BEFORE earmark', async () => {
      const order: string[] = [];
      inventory.createReservation.callsFake(async () => { order.push('reservation'); return { id: 'res-1', status: 'PENDING' } as any; });
      inventory.updateReservationStatus.resolves({ id: 'res-1', status: 'ACTIVE' } as any);
      (database.createEarmark as jest.Mock).mockImplementation(async () => { order.push('earmark'); return { id: 'ear-1', invoiceId: 'inv-001', designatedPurchaseChain: 1, tickerHash: '0xusdc', minAmount: '500000', status: EarmarkStatus.INITIATING }; });

      await executeOnDemandRebalancing(mockInvoice, { canRebalance: true, destinationChain: 1, rebalanceOperations: [], minAmount: '500000' }, makeContext());
      expect(order[0]).toBe('reservation');
      expect(order[1]).toBe('earmark');
    });

    it('should return existing earmark on race condition', async () => {
      inventory.createReservation.resolves({ id: 'res-1' } as any);
      (database.getActiveEarmarkForInvoice as jest.Mock).mockResolvedValue({ id: 'existing-ear', status: EarmarkStatus.PENDING });
      const result = await executeOnDemandRebalancing(mockInvoice, { canRebalance: true, destinationChain: 1, rebalanceOperations: [], minAmount: '500000' }, makeContext());
      expect(result).toBe('existing-ear');
    });

    it('should mark reservation FAILED when no bridge ops', async () => {
      (database.getActiveEarmarkForInvoice as jest.Mock).mockResolvedValue(null);
      inventory.createReservation.resolves({ id: 'res-main', status: 'PENDING' } as any);
      inventory.updateReservationStatus.resolves({ id: 'res-main' } as any);
      (database.createEarmark as jest.Mock).mockResolvedValue({ id: 'ear-1', invoiceId: 'inv-001', designatedPurchaseChain: 1, tickerHash: '0xusdc', minAmount: '500000', status: EarmarkStatus.INITIATING });

      const result = await executeOnDemandRebalancing(mockInvoice, { canRebalance: true, destinationChain: 1, rebalanceOperations: [], minAmount: '500000' }, makeContext());
      expect(result).toBeNull();
      expect(inventory.updateReservationStatus.getCalls().some(c => c.args[1] === 'FAILED')).toBe(true);
    });
  });

  // ── 1.4 Threshold Rebalance Reservations ────────────────────────

  describe('threshold rebalance reservations', () => {
    let rebalanceInventory: typeof import('../../src/rebalance/rebalance').rebalanceInventory;

    beforeEach(async () => {
      const mod = await import('../../src/rebalance/rebalance');
      rebalanceInventory = mod.rebalanceInventory;
      stub(callbacks, 'executeDestinationCallbacks').resolves();
      stub(balanceHelpers, 'getMarkBalances').resolves(new Map([['0xusdc', new Map([['1', 20000000000000000000n]])]]));
      stub(assetHelpers, 'getTickerForAsset').returns('0xusdc');
      const onDemandMod = await import('../../src/rebalance/onDemand');
      stub(onDemandMod, 'getEarmarkedBalance').resolves(0n);
      rebalance.isPaused.resolves(false);
    });

    it('should create REBALANCE_THRESHOLD reservation', async () => {
      inventory.createReservation.resolves({ id: 'res-t-1', status: 'PENDING' } as any);
      inventory.updateReservationStatus.resolves({} as any);
      rebalance.getAdapter.returns({ getReceivedAmount: stub().resolves('19000000000000000000'), send: stub().resolves([]), type: stub().returns('across') } as any);
      const config = { ...makeContext().config, routes: [{ origin: 1, destination: 42161, asset: '0xUSDC', maximum: '10000000000000000000', slippagesDbps: [5000], preferences: ['across'] }] };
      await rebalanceInventory(makeContext({ config } as any));
      expect(inventory.createReservation.called).toBe(true);
      expect(inventory.createReservation.firstCall.args[0].operationType).toBe('REBALANCE_THRESHOLD');
    });

    it('should skip bridge when reservation rejected', async () => {
      inventory.createReservation.resolves(undefined);
      const mockAdapter = { getReceivedAmount: stub(), send: stub(), type: stub().returns('across') };
      rebalance.getAdapter.returns(mockAdapter as any);
      const config = { ...makeContext().config, routes: [{ origin: 1, destination: 42161, asset: '0xUSDC', maximum: '10000000000000000000', slippagesDbps: [5000], preferences: ['across'] }] };
      await rebalanceInventory(makeContext({ config } as any));
      expect(mockAdapter.send.called).toBe(false);
    });
  });

  // ── 1.6 ERC20 Approval Nonce ────────────────────────────────────

  describe('ERC20 approval with inventory nonce', () => {
    let submitStub: SinonStub;

    beforeEach(() => {
      submitStub = stub(transactionHelper, 'submitTransactionWithLogging').resolves({ submissionType: 1, hash: '0xapproval', receipt: { transactionHash: '0xapproval', from: OWN_ADDR, to: TOKEN_ADDR, cumulativeGasUsed: '50000', effectiveGasPrice: '1000000000', blockNumber: 100, status: 1, logs: [], confirmations: 1 } });
    });

    it('should pass inventory to submitTransactionWithLogging for approvals', async () => {
      chainService.readTx.resolves('0x0000000000000000000000000000000000000000000000000000000000000000' as any);
      await checkAndApproveERC20({ config: makeContext().config as any, chainService, logger: mockLogger, chainId: '1', tokenAddress: TOKEN_ADDR, spenderAddress: SPENDER_ADDR, amount: 1000000n, owner: OWN_ADDR, zodiacConfig: { walletType: 'EOA' as any }, inventory, walletAddress: OWN_ADDR });
      expect(submitStub.called).toBe(true);
      expect(submitStub.firstCall.args[0].inventory).toBe(inventory);
      expect(submitStub.firstCall.args[0].walletAddress).toBe(OWN_ADDR);
    });

    it('should work without inventory', async () => {
      chainService.readTx.resolves('0x0000000000000000000000000000000000000000000000000000000000000000' as any);
      await checkAndApproveERC20({ config: makeContext().config as any, chainService, logger: mockLogger, chainId: '1', tokenAddress: TOKEN_ADDR, spenderAddress: SPENDER_ADDR, amount: 1000000n, owner: OWN_ADDR, zodiacConfig: { walletType: 'EOA' as any } });
      expect(submitStub.called).toBe(true);
      expect(submitStub.firstCall.args[0].inventory).toBeUndefined();
    });
  });
});
