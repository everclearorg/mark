// Database type definitions

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}
