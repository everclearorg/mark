import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EverclearAdapter } from '../src';
import { Invoice, axiosGet } from '@mark/core';
import { Logger } from '@mark/logger';

// Mock axiosGet
jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core') as any;
  return {
    ...actual,
    axiosGet: jest.fn(),
  };
});

// Mock logger
jest.mock('@mark/logger', () => {
  return {
    jsonifyError: jest.fn((error: any) => ({ message: error?.message || 'Unknown error' })),
    Logger: jest.fn().mockImplementation(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      logger: {},
    })),
  };
});

describe('EverclearAdapter', () => {
  const apiUrl = 'https://local.everclear.org';
  let adapter: EverclearAdapter;
  let logger: Logger;
  let mockAxiosGet: jest.MockedFunction<typeof axiosGet>;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = new Logger({ service: 'test-service' });
    adapter = new EverclearAdapter(apiUrl, logger);
    mockAxiosGet = axiosGet as jest.MockedFunction<typeof axiosGet>;
  });

  describe('fetchInvoiceById', () => {
    const mockInvoice: Invoice = {
      intent_id: 'invoice-123',
      amount: '1000',
      owner: '0x1234567890123456789012345678901234567890',
      entry_epoch: 1,
      origin: '1',
      destinations: ['2'],
      ticker_hash: '0xabc',
      discountBps: 0,
      hub_status: 'INVOICED',
      hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000),
    };

    it('should fetch invoice by ID successfully', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          invoice: mockInvoice,
        },
      } as any);

      const result = await adapter.fetchInvoiceById('invoice-123');

      expect(result).toEqual(mockInvoice);
      expect(mockAxiosGet).toHaveBeenCalledWith(`${apiUrl}/invoices/invoice-123`);
    });

    it('should throw error when invoice not found', async () => {
      const error = new Error('Not found');
      mockAxiosGet.mockRejectedValue(error);

      await expect(adapter.fetchInvoiceById('invoice-123')).rejects.toThrow('Not found');
      expect(mockAxiosGet).toHaveBeenCalledWith(`${apiUrl}/invoices/invoice-123`);
    });

    it('should handle API errors', async () => {
      const error = new Error('API error');
      mockAxiosGet.mockRejectedValue(error);

      await expect(adapter.fetchInvoiceById('invoice-123')).rejects.toThrow('API error');
    });
  });

  describe('fetchInvoicesByTxNonce', () => {
    const mockInvoices: Invoice[] = [
      {
        intent_id: 'invoice-1',
        amount: '1000',
        owner: '0x1234567890123456789012345678901234567890',
        entry_epoch: 1,
        origin: '1',
        destinations: ['2'],
        ticker_hash: '0xabc',
        discountBps: 0,
        hub_status: 'INVOICED',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000),
      },
      {
        intent_id: 'invoice-2',
        amount: '2000',
        owner: '0x9876543210987654321098765432109876543210',
        entry_epoch: 2,
        origin: '1',
        destinations: ['2'],
        ticker_hash: '0xdef',
        discountBps: 0,
        hub_status: 'INVOICED',
        hub_invoice_enqueued_timestamp: Math.floor(Date.now() / 1000),
      },
    ];

    it('should fetch invoices without cursor', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          invoices: mockInvoices,
          nextCursor: 'cursor-123',
        },
      } as any);

      const result = await adapter.fetchInvoicesByTxNonce(null, 100);

      expect(result.invoices).toEqual(mockInvoices);
      expect(result.nextCursor).toBe('cursor-123');
      expect(mockAxiosGet).toHaveBeenCalledWith(`${apiUrl}/invoices`, {
        params: {
          limit: 100,
          sortOrderByDiscount: 'asc',
        },
      });
    });

    it('should fetch invoices with cursor', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          invoices: mockInvoices,
          nextCursor: 'cursor-456',
        },
      } as any);

      const result = await adapter.fetchInvoicesByTxNonce('cursor-123', 50);

      expect(result.invoices).toEqual(mockInvoices);
      expect(result.nextCursor).toBe('cursor-456');
      expect(mockAxiosGet).toHaveBeenCalledWith(`${apiUrl}/invoices`, {
        params: {
          limit: 50,
          sortOrderByDiscount: 'asc',
          cursor: 'cursor-123',
        },
      });
    });

    it('should handle empty invoice list', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          invoices: [],
          nextCursor: null,
        },
      } as any);

      const result = await adapter.fetchInvoicesByTxNonce(null, 100);

      expect(result.invoices).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it('should handle missing invoices field', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          nextCursor: 'cursor-123',
        },
      } as any);

      const result = await adapter.fetchInvoicesByTxNonce(null, 100);

      expect(result.invoices).toEqual([]);
      expect(result.nextCursor).toBe('cursor-123');
    });

    it('should handle missing nextCursor field', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          invoices: mockInvoices,
        },
      } as any);

      const result = await adapter.fetchInvoicesByTxNonce(null, 100);

      expect(result.invoices).toEqual(mockInvoices);
      expect(result.nextCursor).toBeNull();
    });

    it('should use default limit when not provided', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          invoices: mockInvoices,
          nextCursor: null,
        },
      } as any);

      await adapter.fetchInvoicesByTxNonce(null);

      expect(mockAxiosGet).toHaveBeenCalledWith(`${apiUrl}/invoices`, {
        params: {
          limit: 100,
          sortOrderByDiscount: 'asc',
        },
      });
    });

    it('should handle API errors', async () => {
      const error = new Error('API error');
      mockAxiosGet.mockRejectedValue(error);

      await expect(adapter.fetchInvoicesByTxNonce(null, 100)).rejects.toThrow('API error');
    });
  });
});
