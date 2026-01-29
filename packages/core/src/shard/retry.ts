/**
 * Retry utilities for handling transient failures in cloud operations.
 */

import { ShardError, ShardErrorCode } from './types';

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 100) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 5000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 (default: 0.1) */
  jitter?: number;
  /** Function to determine if error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Optional logger for retry attempts */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Default function to determine if an error is retryable.
 * Retries on network errors and 5xx errors.
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Network errors
  if (
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('network')
  ) {
    return true;
  }

  // Rate limiting
  if (message.includes('rate limit') || message.includes('429') || message.includes('quota')) {
    return true;
  }

  // Server errors (5xx)
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
    return true;
  }

  // GCP-specific transient errors
  if (message.includes('unavailable') || message.includes('deadline exceeded') || message.includes('aborted')) {
    return true;
  }

  return false;
}

/**
 * Execute a function with retry logic using exponential backoff.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries fail
 *
 * @example
 * const result = await withRetry(
 *   () => getGcpSecret('project', 'secret'),
 *   { maxAttempts: 3 }
 * );
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    jitter = 0.1,
    isRetryable = isRetryableError,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry on non-retryable errors or last attempt
      if (!isRetryable(lastError) || attempt === maxAttempts) {
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
      const jitterAmount = cappedDelay * jitter * (Math.random() * 2 - 1);
      const delay = Math.round(cappedDelay + jitterAmount);

      onRetry?.(attempt, lastError, delay);

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new ShardError('Retry failed with no error', ShardErrorCode.RECONSTRUCTION_FAILED);
}

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a promise that rejects after a timeout.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param errorMessage - Optional error message
 * @returns The promise result or throws on timeout
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage?: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new ShardError(errorMessage ?? `Operation timed out after ${timeoutMs}ms`, ShardErrorCode.GCP_ACCESS_FAILED, {
          timeoutMs,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}
