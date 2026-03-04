export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ServiceName = 'eva' | 'agent' | 'vision' | 'audio';
export type LogStream = 'stdout' | 'stderr';

export type ConsoleMode =
  | 'compact'
  | 'follow'
  | 'service:eva'
  | 'service:agent'
  | 'service:vision'
  | 'service:audio';

export interface LoggingConfig {
  enabled: boolean;
  dir: string;
  rotation: { maxBytes: number; maxFiles: number };
  retention: { maxRuns: number };
  console: { mode: ConsoleMode; timestamps: boolean };
}
