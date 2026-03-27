import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InventoryServiceClient } from '../src';
import { axiosGet, axiosPost } from '@mark/core';
import { Logger } from '@mark/logger';
import axios from 'axios';

jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core') as any;
  return { ...actual, axiosGet: jest.fn(), axiosPost: jest.fn() };
});

jest.mock('axios', () => ({ put: jest.fn(), delete: jest.fn() }));

jest.mock('@mark/logger', () => ({
  jsonifyError: jest.fn((error: any) => ({ message: error?.message || 'Unknown error' })),
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), logger: {},
  })),
}));

describe('InventoryServiceClient', () => {
  const apiUrl = 'https://api.everclear.org';
  let client: InventoryServiceClient;
  let logger: Logger;
  let mockAxiosGet: jest.MockedFunction<typeof axiosGet>;
  let mockAxiosPost: jest.MockedFunction<typeof axiosPost>;
  let mockAxiosPut: jest.MockedFunction<typeof axios.put>;
  let mockAxiosDelete: jest.MockedFunction<typeof axios.delete>;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = new Logger({ service: 'test' });
    client = new InventoryServiceClient(apiUrl, logger);
    mockAxiosGet = axiosGet as jest.MockedFunction<typeof axiosGet>;
    mockAxiosPost = axiosPost as jest.MockedFunction<typeof axiosPost>;
    mockAxiosPut = axios.put as jest.MockedFunction<typeof axios.put>;
    mockAxiosDelete = axios.delete as jest.MockedFunction<typeof axios.delete>;
  });

  describe('createReservation', () => {
    const params = { chainId: '1', asset: '0xUSDC', amount: '1000000', operationType: 'MARK_PURCHASE' as const, operationId: 'i-1', requestedBy: 'mark' };

    it('should create reservation successfully', async () => {
      const res = { id: 'res-1', ...params, priority: 4, status: 'PENDING' };
      mockAxiosPost.mockResolvedValue({ data: res } as any);
      expect(await client.createReservation(params)).toEqual(res);
      expect(mockAxiosPost).toHaveBeenCalledWith(`${apiUrl}/inventory/reserve`, params, undefined, 1, 0);
    });

    it('should return undefined on error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('fail'));
      expect(await client.createReservation(params)).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('updateReservationStatus', () => {
    it('should update successfully', async () => {
      mockAxiosPut.mockResolvedValue({ data: { id: 'res-1', status: 'ACTIVE' } } as any);
      expect(await client.updateReservationStatus('res-1', 'ACTIVE')).toEqual({ id: 'res-1', status: 'ACTIVE' });
    });

    it('should pass metadata', async () => {
      mockAxiosPut.mockResolvedValue({ data: {} } as any);
      await client.updateReservationStatus('res-1', 'COMPLETED', { txHash: '0x1' });
      expect(mockAxiosPut).toHaveBeenCalledWith(`${apiUrl}/inventory/reserve/res-1/status`, { status: 'COMPLETED', metadata: { txHash: '0x1' } });
    });

    it('should return undefined on error', async () => {
      mockAxiosPut.mockRejectedValue(new Error('fail'));
      expect(await client.updateReservationStatus('res-1', 'ACTIVE')).toBeUndefined();
    });
  });

  describe('deleteReservation', () => {
    it('should return true on success', async () => {
      mockAxiosDelete.mockResolvedValue({ data: { success: true } } as any);
      expect(await client.deleteReservation('res-1')).toBe(true);
    });

    it('should return false on error', async () => {
      mockAxiosDelete.mockRejectedValue(new Error('fail'));
      expect(await client.deleteReservation('res-1')).toBe(false);
    });
  });

  describe('getInventoryBalance', () => {
    it('should return balance', async () => {
      const balance = { chainId: '1', asset: '0xU', totalBalance: '5000000', availableBalance: '3000000', reservedByType: {}, pendingInbound: '0', pendingIntents: '0', reservationCount: 0, timestamp: Date.now() };
      mockAxiosGet.mockResolvedValue({ data: balance } as any);
      expect(await client.getInventoryBalance('1', '0xU')).toEqual(balance);
    });

    it('should return undefined on error', async () => {
      mockAxiosGet.mockRejectedValue(new Error('fail'));
      expect(await client.getInventoryBalance('1', '0xU')).toBeUndefined();
    });
  });

  describe('getReservationsByOperation', () => {
    it('should return reservations', async () => {
      mockAxiosGet.mockResolvedValue({ data: { reservations: [{ id: 'r1' }] } } as any);
      expect(await client.getReservationsByOperation('op-1')).toEqual([{ id: 'r1' }]);
    });

    it('should return empty array on error', async () => {
      mockAxiosGet.mockRejectedValue(new Error('fail'));
      expect(await client.getReservationsByOperation('op-1')).toEqual([]);
    });
  });

  describe('assignNonce', () => {
    it('should assign nonce', async () => {
      const assignment = { nonce: 42, nonceId: '1:0xw:42', chainId: '1', wallet: '0xw', assignedAt: Date.now() };
      mockAxiosPost.mockResolvedValue({ data: assignment } as any);
      expect(await client.assignNonce('1', '0xw', 'op-1')).toEqual(assignment);
    });

    it('should return undefined on error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('fail'));
      expect(await client.assignNonce('1', '0xw')).toBeUndefined();
    });
  });

  describe('confirmNonce', () => {
    it('should confirm', async () => {
      mockAxiosPost.mockResolvedValue({ data: { success: true } } as any);
      await client.confirmNonce('1', '0xw', 42, '0xtx');
      expect(mockAxiosPost).toHaveBeenCalledWith(`${apiUrl}/inventory/nonce/confirm`, { chainId: '1', wallet: '0xw', nonce: 42, txHash: '0xtx' }, undefined, 1, 0);
    });

    it('should not throw on error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('fail'));
      await expect(client.confirmNonce('1', '0xw', 42)).resolves.toBeUndefined();
    });
  });

  describe('failNonce', () => {
    it('should report failure', async () => {
      mockAxiosPost.mockResolvedValue({ data: { success: true } } as any);
      await client.failNonce('1', '0xw', 42);
      expect(mockAxiosPost).toHaveBeenCalledWith(`${apiUrl}/inventory/nonce/fail`, { chainId: '1', wallet: '0xw', nonce: 42 }, undefined, 1, 0);
    });

    it('should not throw on error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('fail'));
      await expect(client.failNonce('1', '0xw', 42)).resolves.toBeUndefined();
    });
  });

  describe('registerInbound', () => {
    it('should register', async () => {
      const params = { chainId: '42161', asset: '0xU', amount: '1000000', sourceChain: '1', operationType: 'REBALANCE_ONDEMAND', operationId: 'op-1', expectedArrivalSeconds: 1800 };
      mockAxiosPost.mockResolvedValue({ data: { id: 'inb-1', ...params, status: 'PENDING' } } as any);
      const result = await client.registerInbound(params);
      expect(result?.id).toBe('inb-1');
    });

    it('should return undefined on error', async () => {
      mockAxiosPost.mockRejectedValue(new Error('fail'));
      expect(await client.registerInbound({ chainId: '1', asset: '0x', amount: '0', sourceChain: '2', operationType: 'REBALANCE_ONDEMAND', operationId: 'x' })).toBeUndefined();
    });
  });

  describe('confirmInbound', () => {
    it('should confirm', async () => {
      mockAxiosPost.mockResolvedValue({ data: { id: 'inb-1', status: 'CONFIRMED' } } as any);
      expect((await client.confirmInbound('inb-1', '0xtx'))?.status).toBe('CONFIRMED');
    });
  });

  describe('cancelInbound', () => {
    it('should cancel', async () => {
      mockAxiosPost.mockResolvedValue({ data: { id: 'inb-1', status: 'CANCELLED' } } as any);
      expect((await client.cancelInbound('inb-1', 'reason'))?.status).toBe('CANCELLED');
    });
  });

  describe('reportTransactionSuccess', () => {
    it('should call updateReservationStatus with COMPLETED', async () => {
      mockAxiosPut.mockResolvedValue({ data: {} } as any);
      await client.reportTransactionSuccess('res-1', '0xtx', '1', { bridge: 'across' });
      expect(mockAxiosPut).toHaveBeenCalledWith(`${apiUrl}/inventory/reserve/res-1/status`, { status: 'COMPLETED', metadata: { txHash: '0xtx', chainId: '1', bridge: 'across' } });
    });
  });

  describe('reportTransactionFailure', () => {
    it('should call updateReservationStatus with FAILED', async () => {
      mockAxiosPut.mockResolvedValue({ data: {} } as any);
      await client.reportTransactionFailure('res-1', 'gas too low');
      expect(mockAxiosPut).toHaveBeenCalledWith(`${apiUrl}/inventory/reserve/res-1/status`, { status: 'FAILED', metadata: { failureReason: 'gas too low' } });
    });
  });

  describe('URL handling', () => {
    it('should strip trailing slash', () => {
      const c = new InventoryServiceClient('https://api.everclear.org/', logger);
      mockAxiosPost.mockResolvedValue({ data: {} } as any);
      c.assignNonce('1', '0xw');
      expect(mockAxiosPost).toHaveBeenCalledWith('https://api.everclear.org/inventory/nonce/assign', expect.any(Object), undefined, 1, 0);
    });
  });
});
