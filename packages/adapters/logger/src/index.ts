import pino from 'pino';
import ddTrace from 'dd-trace';

export interface LoggerConfig {
  service: string;
  environment?: string;
  level?: string;
}

export interface ILogger {
  info(message: string, context?: object): void;
  error(message: string, context?: object): void;
  warn(message: string, context?: object): void;
  debug(message: string, context?: object): void;
}

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
export const jsonifyError = (err: unknown, ctx: object = {}): ErrorWithContext => {
  const error = err as Error;
  return {
    name: error?.name ?? 'unknown',
    message: error?.message ?? 'unknown',
    stack: error?.stack ?? 'unknown',
    context: ctx,
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
