import {
  initializeDatabase,
  closeDatabase,
  createEarmark,
  getEarmarks,
  getEarmarkForInvoice,
  removeEarmark,
  CreateEarmarkInput,
  GetEarmarksFilter,
  DatabaseConfig,
} from '../src';

// Mock configuration for testing
const mockConfig: DatabaseConfig = {
  connectionString: 'postgresql://localhost:5432/test_db',
  maxConnections: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 1000,
};

// Mock client object for transaction testing
const mockClientInstance = {
  query: jest.fn(),
  release: jest.fn(),
};

// Create a mock pool object
const mockPoolInstance = {
  query: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
  connect: jest.fn().mockResolvedValue(mockClientInstance),
};

// Mock pg Pool for testing
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => mockPoolInstance),
}));

describe('Core Earmark CRUD Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    initializeDatabase(mockConfig);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  describe('createEarmark', () => {
    const mockEarmarkResult = {
      id: 'earmark-123',
      invoiceId: 'inv-456',
      destinationChainId: 1,
      ticker: 'USDC',
      invoiceAmount: '100.00',
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('should create earmark with basic data', async () => {
      // Mock transaction flow
      mockClientInstance.query
        .mockResolvedValueOnce({ command: 'BEGIN', rows: [] }) // BEGIN transaction
        .mockResolvedValueOnce({ rows: [mockEarmarkResult], command: 'INSERT' }) // INSERT earmark
        .mockResolvedValueOnce({ command: 'INSERT', rows: [] }) // INSERT audit log
        .mockResolvedValueOnce({ command: 'COMMIT', rows: [] }); // COMMIT transaction
      const input: CreateEarmarkInput = {
        invoiceId: 'inv-456',
        destinationChainId: 1,
        ticker: 'USDC',
        invoiceAmount: '100.00',
      };

      const result = await createEarmark(input);

      expect(result).toEqual(mockEarmarkResult);
      expect(mockClientInstance.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClientInstance.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO earmarks'), [
        'inv-456',
        1,
        'USDC',
        '100.00',
        'pending',
      ]);
      expect(mockClientInstance.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClientInstance.release).toHaveBeenCalled();
    });

    it('should create earmark with initial rebalance operations', async () => {
      const input: CreateEarmarkInput = {
        invoiceId: 'inv-456',
        destinationChainId: 1,
        ticker: 'USDC',
        invoiceAmount: '100.00',
        initialRebalanceOperations: [
          {
            originChainId: 137,
            amount: '50.00',
            slippage: '0.01',
          },
          {
            originChainId: 42161,
            amount: '50.00',
          },
        ],
      };

      // Add mock responses for rebalance operations
      mockClientInstance.query
        .mockResolvedValueOnce({ command: 'BEGIN', rows: [] })
        .mockResolvedValueOnce({ rows: [mockEarmarkResult], command: 'INSERT' })
        .mockResolvedValueOnce({ command: 'INSERT', rows: [] }) // First rebalance operation
        .mockResolvedValueOnce({ command: 'INSERT', rows: [] }) // Second rebalance operation
        .mockResolvedValueOnce({ command: 'INSERT', rows: [] }) // Audit log
        .mockResolvedValueOnce({ command: 'COMMIT', rows: [] });

      const result = await createEarmark(input);

      expect(result).toEqual(mockEarmarkResult);
      expect(mockClientInstance.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO rebalance_operations'),
        ['earmark-123', 137, 1, 'USDC', '50.00', '0.01', 'pending'],
      );
      expect(mockClientInstance.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO rebalance_operations'),
        ['earmark-123', 42161, 1, 'USDC', '50.00', '0.005', 'pending'],
      );
    });

    it('should rollback transaction on error', async () => {
      const input: CreateEarmarkInput = {
        invoiceId: 'inv-456',
        destinationChainId: 1,
        ticker: 'USDC',
        invoiceAmount: '100.00',
      };

      // Mock transaction failure
      mockClientInstance.query
        .mockResolvedValueOnce({ command: 'BEGIN', rows: [] })
        .mockRejectedValueOnce(new Error('Database error'));

      await expect(createEarmark(input)).rejects.toThrow('Database error');
      expect(mockClientInstance.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientInstance.release).toHaveBeenCalled();
    });
  });

  describe('getEarmarks', () => {
    const mockEarmarks = [
      {
        id: 'earmark-1',
        invoiceId: 'inv-1',
        destinationChainId: 1,
        ticker: 'USDC',
        invoiceAmount: '100.00',
        status: 'pending',
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
      },
      {
        id: 'earmark-2',
        invoiceId: 'inv-2',
        destinationChainId: 137,
        ticker: 'ETH',
        invoiceAmount: '0.5',
        status: 'completed',
        created_at: new Date('2024-01-02'),
        updated_at: new Date('2024-01-02'),
      },
    ];

    it('should get all earmarks without filter', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: mockEarmarks });

      const result = await getEarmarks();

      expect(result).toEqual(mockEarmarks);
      expect(mockPoolInstance.query).toHaveBeenCalledWith('SELECT * FROM earmarks ORDER BY created_at DESC', []);
    });

    it('should filter by status', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [mockEarmarks[0]] });

      const filter: GetEarmarksFilter = { status: 'pending' };
      const result = await getEarmarks(filter);

      expect(result).toEqual([mockEarmarks[0]]);
      expect(mockPoolInstance.query).toHaveBeenCalledWith(
        'SELECT * FROM earmarks WHERE status = $1 ORDER BY created_at DESC',
        ['pending'],
      );
    });

    it('should filter by multiple statuses', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: mockEarmarks });

      const filter: GetEarmarksFilter = { status: ['pending', 'completed'] };
      const result = await getEarmarks(filter);

      expect(result).toEqual(mockEarmarks);
      expect(mockPoolInstance.query).toHaveBeenCalledWith(
        'SELECT * FROM earmarks WHERE status IN ($1, $2) ORDER BY created_at DESC',
        ['pending', 'completed'],
      );
    });

    it('should filter by destinationChainId and ticker', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [mockEarmarks[0]] });

      const filter: GetEarmarksFilter = {
        destinationChainId: 1,
        ticker: 'USDC',
      };
      const result = await getEarmarks(filter);

      expect(result).toEqual([mockEarmarks[0]]);
      expect(mockPoolInstance.query).toHaveBeenCalledWith(
        'SELECT * FROM earmarks WHERE destinationChainId = $1 AND ticker = $2 ORDER BY created_at DESC',
        [1, 'USDC'],
      );
    });

    it('should filter by date range', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: mockEarmarks });

      const filter: GetEarmarksFilter = {
        createdAfter: new Date('2024-01-01'),
        createdBefore: new Date('2024-01-03'),
      };
      const result = await getEarmarks(filter);

      expect(result).toEqual(mockEarmarks);
      expect(mockPoolInstance.query).toHaveBeenCalledWith(
        'SELECT * FROM earmarks WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC',
        [new Date('2024-01-01'), new Date('2024-01-03')],
      );
    });
  });

  describe('getEarmarkForInvoice', () => {
    const mockEarmark = {
      id: 'earmark-123',
      invoiceId: 'inv-456',
      destinationChainId: 1,
      ticker: 'USDC',
      invoiceAmount: '100.00',
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('should return earmark for valid invoice', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [mockEarmark] });

      const result = await getEarmarkForInvoice('inv-456');

      expect(result).toEqual(mockEarmark);
      expect(mockPoolInstance.query).toHaveBeenCalledWith('SELECT * FROM earmarks WHERE invoiceId = $1', ['inv-456']);
    });

    it('should return null for non-existent invoice', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [] });

      const result = await getEarmarkForInvoice('inv-nonexistent');

      expect(result).toBeNull();
    });

    it('should throw error for duplicate invoices', async () => {
      mockPoolInstance.query.mockResolvedValue({ rows: [mockEarmark, mockEarmark] });

      await expect(getEarmarkForInvoice('inv-duplicate')).rejects.toThrow(
        'Multiple earmarks found for invoice inv-duplicate',
      );
    });
  });

  describe('removeEarmark', () => {
    const mockEarmark = {
      id: 'earmark-123',
      invoiceId: 'inv-456',
      destinationChainId: 1,
      ticker: 'USDC',
      invoiceAmount: '100.00',
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('should remove earmark with cascading cleanup', async () => {
      // Mock successful transaction flow
      mockClientInstance.query
        .mockResolvedValueOnce({ command: 'BEGIN', rows: [] })
        .mockResolvedValueOnce({ rows: [mockEarmark], command: 'SELECT' }) // SELECT earmark
        .mockResolvedValueOnce({ command: 'INSERT', rows: [] }) // INSERT audit log
        .mockResolvedValueOnce({ command: 'DELETE', rows: [] }) // DELETE rebalance operations
        .mockResolvedValueOnce({ command: 'DELETE', rows: [] }) // DELETE earmark
        .mockResolvedValueOnce({ command: 'COMMIT', rows: [] });
      await removeEarmark('earmark-123');

      expect(mockClientInstance.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClientInstance.query).toHaveBeenCalledWith('SELECT * FROM earmarks WHERE id = $1', ['earmark-123']);
      expect(mockClientInstance.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO earmark_audit_log'), [
        'earmark-123',
        'DELETE',
        'pending',
        expect.any(String),
      ]);
      expect(mockClientInstance.query).toHaveBeenCalledWith('DELETE FROM rebalance_operations WHERE earmarkId = $1', [
        'earmark-123',
      ]);
      expect(mockClientInstance.query).toHaveBeenCalledWith('DELETE FROM earmarks WHERE id = $1', ['earmark-123']);
      expect(mockClientInstance.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClientInstance.release).toHaveBeenCalled();
    });

    it('should throw error for non-existent earmark', async () => {
      mockClientInstance.query
        .mockResolvedValueOnce({ command: 'BEGIN', rows: [] })
        .mockResolvedValueOnce({ rows: [], command: 'SELECT' }); // No earmark found

      await expect(removeEarmark('earmark-nonexistent')).rejects.toThrow(
        'Earmark with id earmark-nonexistent not found',
      );

      expect(mockClientInstance.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should rollback transaction on deletion error', async () => {
      mockClientInstance.query
        .mockResolvedValueOnce({ command: 'BEGIN', rows: [] })
        .mockResolvedValueOnce({ rows: [mockEarmark], command: 'SELECT' })
        .mockResolvedValueOnce({ command: 'INSERT', rows: [] }) // Audit log
        .mockRejectedValueOnce(new Error('Delete failed')); // DELETE operations fails

      await expect(removeEarmark('earmark-123')).rejects.toThrow('Delete failed');
      expect(mockClientInstance.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientInstance.release).toHaveBeenCalled();
    });
  });
});
