export interface RequestContext {
  id: string;
}

export interface MethodContext {
  method: string;
}

export interface LoggingContext {
  requestId?: string;
  invoiceId?: string;
  chainId?: string | number;
  transactionHash?: string;
  origin?: string | number;
  destination?: string | number;
  amount?: string;
  asset?: string;
  bridge?: string;
  useZodiac?: boolean;
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ILogger {
  info(message: string, context?: object): void;
  error(message: string, context?: object): void;
  warn(message: string, context?: object): void;
  debug(message: string, context?: object): void;
}
