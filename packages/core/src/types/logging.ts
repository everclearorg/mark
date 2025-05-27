export interface RequestContext {
  id: string;
}

export interface MethodContext {
  method: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ILogger {
  info(message: string, context?: object): void;
  error(message: string, context?: object): void;
  warn(message: string, context?: object): void;
  debug(message: string, context?: object): void;
}
