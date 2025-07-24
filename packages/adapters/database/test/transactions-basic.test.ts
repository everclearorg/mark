import { DatabaseError, ConnectionError } from '../src';

describe('Basic Transaction Error Types', () => {
  describe('DatabaseError', () => {
    it('should create DatabaseError with retryable flag', () => {
      const error = new DatabaseError('Test error', 'TEST_CODE', true);
      expect(error.name).toBe('DatabaseError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.retryable).toBe(true);
    });

    it('should create DatabaseError with default non-retryable flag', () => {
      const error = new DatabaseError('Test error', 'TEST_CODE');
      expect(error.name).toBe('DatabaseError');
      expect(error.retryable).toBe(false);
    });
  });

  describe('ConnectionError', () => {
    it('should create ConnectionError as retryable', () => {
      const error = new ConnectionError('Connection failed');
      expect(error.name).toBe('ConnectionError');
      expect(error.retryable).toBe(true);
      expect(error.code).toBe('CONNECTION_FAILED');
    });

    it('should inherit from DatabaseError', () => {
      const error = new ConnectionError('Connection failed');
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toBeInstanceOf(Error);
    });
  });
});
