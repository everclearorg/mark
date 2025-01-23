export interface RequestContext {
  id: string;
}

export interface MethodContext {
  method: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
