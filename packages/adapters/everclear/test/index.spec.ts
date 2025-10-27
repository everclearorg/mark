import { EverclearAdapter } from '../src';
import { Logger } from '@mark/logger';
import { axiosGet, axiosPost } from '@mark/core';

// Mock dependencies
jest.mock('@mark/logger', () => {
  return {
    jsonifyError: jest.fn((e) => ({ message: e.message, name: e.name })),
    Logger: jest.fn().mockImplementation(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      logger: {},
    })),
  };
});

jest.mock('@mark/core', () => {
  const actual = jest.requireActual('@mark/core');
  return {
    ...actual,
    axiosGet: jest.fn(),
    axiosPost: jest.fn(),
  };
});

describe('EverclearAdapter', () => {
  const apiUrl = 'https://local.everclear.org';

  let adapter: EverclearAdapter;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = new Logger({ service: 'test-service' });
    adapter = new EverclearAdapter(apiUrl, logger);
  });

  describe('getMinAmounts', () => {
    it('should fetch and return min amounts for an invoice', async () => {
      const invoiceId = '0xinvoice-123';
      const mockResponse = {
        invoiceAmount: '1000000000000000000',
        amountAfterDiscount: '950000000000000000',
        discountBps: '500',
        custodiedAmounts: {
          '1': '100000000000000000',
          '10': '200000000000000000',
        },
        minAmounts: {
          '1': '50000000000000000',
          '10': '100000000000000000',
        },
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockResponse });

      const response = await adapter.getMinAmounts(invoiceId);

      expect(response).toEqual(mockResponse);
      expect(axiosGet).toHaveBeenCalledWith(`${apiUrl}/invoices/${invoiceId}/min-amounts`);
    });
  });

  describe('fetchInvoices', () => {
    it('should fetch invoices with destination filter', async () => {
      const mockInvoices = [
        { intent_id: 'invoice-1', amount: '1000', destinations: ['1', '10'] },
        { intent_id: 'invoice-2', amount: '2000', destinations: ['42161'] },
      ];

      const mockDestinations = {
        '1': {} as any,
        '10': {} as any,
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: { invoices: mockInvoices } });

      const result = await adapter.fetchInvoices(mockDestinations);

      expect(result).toEqual(mockInvoices);
      expect(axiosGet).toHaveBeenCalledWith(
        `${apiUrl}/invoices?limit=100`,
        expect.objectContaining({
          params: { destinations: ['1', '10'] },
        }),
      );
    });
  });

  describe('intentStatus', () => {
    it('should return intent status', async () => {
      const mockIntent = {
        intent: {
          intent_id: 'intent-123',
          status: 'ADDED',
        },
      };

      (axiosGet as jest.Mock).mockResolvedValue({ data: mockIntent });

      const result = await adapter.intentStatus('intent-123');

      expect(result).toBe('ADDED');
      expect(axiosGet).toHaveBeenCalledWith(`${apiUrl}/intents/intent-123`);
    });

    it('should return NONE on error', async () => {
      (axiosGet as jest.Mock).mockRejectedValue(new Error('API error'));

      const result = await adapter.intentStatus('intent-fail');

      expect(result).toBe('NONE');
      expect(logger.error).toHaveBeenCalledWith('Failed to get intent status', expect.any(Object));
    });
  });
})
