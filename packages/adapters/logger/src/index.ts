import pino from 'pino';
import ddTrace from 'dd-trace';
import { ILogger } from '@mark/core';

export interface LoggerConfig {
  service: string;
  environment?: string;
  level?: string;
}

// Re-export ILogger for convenience
export { ILogger };

export function jsonifyMap(map: Map<string, unknown>): Record<string, unknown> {
  const jsonObject: Record<string, unknown> = {};

  for (const [key, value] of map.entries()) {
    if (value instanceof Map) {
      jsonObject[key] = jsonifyMap(value);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jsonObject[key] = typeof value === 'object' ? JSON.stringify(value) : (value as any).toString();
    }
  }

  return jsonObject;
}

interface ErrorWithContext extends Error {
  context: object;
}

interface ErrorWithOwnContext extends Error {
  context?: Record<string, unknown>;
}

export const jsonifyError = (err: unknown, ctx: object = {}): ErrorWithContext => {
  const error = err as ErrorWithOwnContext;

  // Merge the error's own context (e.g., from AxiosQueryError) with passed context
  // This ensures API response data (like 400 error details) is surfaced in logs
  const errorContext = error?.context ?? {};
  const mergedContext = { ...errorContext, ...ctx };

  return {
    name: error?.name ?? 'unknown',
    message: error?.message ?? 'unknown',
    stack: error?.stack ?? 'unknown',
    context: mergedContext,
  };
};

export class Logger implements ILogger {
  private readonly logger: pino.Logger;

  constructor(config: LoggerConfig) {
    // Initialize DataDog tracer
    ddTrace.init({
      runtimeMetrics: true, // collects Node.js runtime metrics
      logInjection: true, // enriches logs
      profiling: true, // enables continuous profiler
      service: config.service,
      env: config.environment || process.env.NODE_ENV || 'development',
    });

    this.logger = pino({
      name: config.service,
      level: config.level || 'info',
      messageKey: 'message',
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    });
  }

  info(message: string, context?: Record<string, unknown>) {
    this.logger.info(context || {}, message);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.logger.error(context || {}, message);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.logger.warn(context || {}, message);
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.logger.debug(context || {}, message);
  }
}
