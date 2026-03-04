import type { ConsoleMode, LogLevel, LogStream, ServiceName } from './types.js';

type SubprocessService = Exclude<ServiceName, 'eva'>;

const COMPACT_STDOUT_PASSTHROUGH_REGEX = /\b(warn|warning|error|failed|fatal)\b/i;

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
} as const;

function colorize(text: string, color: string): string {
  return `${color}${text}${ANSI.reset}`;
}

function timePrefix(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const mmm = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function serviceColor(service: ServiceName): string {
  switch (service) {
    case 'eva':
      return ANSI.green;
    case 'agent':
      return ANSI.cyan;
    case 'vision':
      return ANSI.magenta;
    case 'audio':
      return ANSI.yellow;
    default:
      return ANSI.reset;
  }
}

export class ConsoleRenderer {
  private readonly mode: ConsoleMode;
  private readonly timestamps: boolean;

  public constructor(opts: { mode: ConsoleMode; timestamps: boolean }) {
    this.mode = opts.mode;
    this.timestamps = opts.timestamps;
  }

  public echoEva(level: LogLevel, message: string): void {
    const levelTag = `[${level}]`;
    const text = `${levelTag} ${message}`;

    if (level === 'error') {
      this.emitLine('eva', text, 'stderr');
      return;
    }

    this.emitLine('eva', text, 'stdout');
  }

  public echoSubprocessLine(service: SubprocessService, stream: LogStream, line: string): void {
    if (!this.shouldEchoSubprocessLine(service, stream, line)) {
      return;
    }

    this.emitLine(service, line, stream);
  }

  public echoLifecycle(message: string): void {
    this.emitLine('eva', message, 'stdout');
  }

  private shouldEchoSubprocessLine(service: SubprocessService, stream: LogStream, line: string): boolean {
    if (this.mode === 'follow') {
      return true;
    }

    if (this.mode.startsWith('service:')) {
      return this.mode === `service:${service}`;
    }

    if (this.mode !== 'compact') {
      return true;
    }

    if (line.length === 0) {
      return false;
    }

    if (stream === 'stderr') {
      return true;
    }

    return COMPACT_STDOUT_PASSTHROUGH_REGEX.test(line);
  }

  private emitLine(service: ServiceName, message: string, stream: LogStream): void {
    const serviceTag = colorize(`[${service}]`, serviceColor(service));
    const streamMessage = stream === 'stderr' ? colorize(message, ANSI.red) : message;

    const line = this.timestamps
      ? `${colorize(timePrefix(new Date()), ANSI.dim)}  ${serviceTag} ${streamMessage}`
      : `${serviceTag} ${streamMessage}`;

    if (stream === 'stderr') {
      console.error(line);
      return;
    }

    console.log(line);
  }
}
