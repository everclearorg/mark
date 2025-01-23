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

export function jsonifyNestedMap(nestedMap: Map<string, Map<string, bigint>>): Record<string, Record<string, string>> {
  const jsonObject: Record<string, Record<string, string>> = {};

  for (const [key, innerMap] of nestedMap.entries()) {
    jsonObject[key] = {};
    for (const [innerKey, value] of innerMap.entries()) {
      jsonObject[key][innerKey] = value.toString();
    }
  }

  return jsonObject;
}

export class Logger implements ILogger {
  private readonly logger: pino.Logger;

  constructor(config: LoggerConfig) {
    // Initialize DataDog tracer
    ddTrace.init({
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
