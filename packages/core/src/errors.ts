export class MarkError extends Error {
  constructor(
    public readonly type: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AxiosQueryError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Check if an error represents a "not found" (404) response.
 * Centralizes the detection logic to avoid fragile heuristics scattered across the codebase.
 *
 * @param error - The error to check
 * @returns true if the error indicates a 404/not found response
 */
export function isNotFoundError(error: unknown): boolean {
  // Check for AxiosQueryError with status 404
  if (error instanceof AxiosQueryError) {
    return (error.context?.status as number) === 404;
  }

  // Check various error shapes that might contain status information
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const err = error as any;

  // Check context.status (our AxiosQueryError format)
  if (err?.context?.status === 404) {
    return true;
  }

  // Check response.status (axios error format)
  if (err?.response?.status === 404) {
    return true;
  }

  // Check direct status property
  if (err?.status === 404) {
    return true;
  }

  // Check statusCode property (some libraries use this)
  if (err?.statusCode === 404) {
    return true;
  }

  return false;
}
