/**
 * Unit tests for retry.ts
 *
 * Tests retry logic with exponential backoff.
 */

import { withRetry, withTimeout, isRetryableError } from '../../src/shard/retry';
import { ShardError, ShardErrorCode } from '../../src/shard/types';

describe('retry', () => {
  describe('isRetryableError', () => {
    it('should return true for network errors', () => {
      expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    });

    it('should return true for rate limiting', () => {
      expect(isRetryableError(new Error('Rate limit exceeded'))).toBe(true);
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
      expect(isRetryableError(new Error('Quota exceeded'))).toBe(true);
    });

    it('should return true for server errors', () => {
      expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
    });

    it('should return true for GCP transient errors', () => {
      expect(isRetryableError(new Error('UNAVAILABLE'))).toBe(true);
      expect(isRetryableError(new Error('deadline exceeded'))).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      expect(isRetryableError(new Error('NOT_FOUND'))).toBe(false);
      expect(isRetryableError(new Error('Invalid argument'))).toBe(false);
      expect(isRetryableError(new Error('Permission denied'))).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      const result = await withRetry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable errors', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValue('success');

      const result = await withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
      });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-retryable errors', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Invalid argument'));

      await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow('Invalid argument');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw after max attempts', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(
        withRetry(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
        }),
      ).rejects.toThrow('ECONNRESET');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should call onRetry callback', async () => {
      const onRetry = jest.fn();
      const fn = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('success');

      await withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs: 10,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
    });

    it('should use custom isRetryable function', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('custom error'));
      const isRetryable = jest.fn().mockReturnValue(true);

      await expect(
        withRetry(fn, {
          maxAttempts: 2,
          baseDelayMs: 10,
          isRetryable,
        }),
      ).rejects.toThrow('custom error');

      expect(isRetryable).toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should respect maxDelayMs cap', async () => {
      const startTime = Date.now();
      const fn = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(
        withRetry(fn, {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 50,
        }),
      ).rejects.toThrow();

      const elapsed = Date.now() - startTime;
      // With maxDelayMs of 50, total delay should be around 100ms (50+50) + some jitter
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('withTimeout', () => {
    it('should return result if completed before timeout', async () => {
      const promise = Promise.resolve('success');

      const result = await withTimeout(promise, 1000);

      expect(result).toBe('success');
    });

    it('should throw ShardError on timeout', async () => {
      let timeoutHandle: NodeJS.Timeout;
      const promise = new Promise((resolve) => {
        timeoutHandle = setTimeout(resolve, 1000);
      });

      try {
        await expect(withTimeout(promise, 50)).rejects.toThrow(ShardError);
      } finally {
        clearTimeout(timeoutHandle!);
      }
    });

    it('should include custom error message', async () => {
      let timeoutHandle: NodeJS.Timeout;
      const promise = new Promise((resolve) => {
        timeoutHandle = setTimeout(resolve, 1000);
      });

      try {
        await expect(withTimeout(promise, 50, 'Custom timeout message')).rejects.toThrow('Custom timeout message');
      } finally {
        clearTimeout(timeoutHandle!);
      }
    });

    it('should resolve with promise result even when timeout is set', async () => {
      const fastPromise = Promise.resolve('fast result');
      const result = await withTimeout(fastPromise, 5000);
      expect(result).toBe('fast result');
    });
  });
});
