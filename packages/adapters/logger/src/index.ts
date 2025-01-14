import pino from 'pino';
import ddTrace from 'dd-trace';

export interface LoggerConfig {
  service: string;
  environment?: string;
  level?: string;
}

export class Logger {
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
