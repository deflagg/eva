import fs from 'node:fs';
import path from 'node:path';

import { RotatingFileWriter } from './RotatingFileWriter.js';
import { formatIsoTimestamp, makeRunId } from './time.js';
import type { LogLevel, LogStream, LoggingConfig, ServiceName } from './types.js';

type SubprocessService = Exclude<ServiceName, 'eva'>;

function normalizeRecordText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export class LogManager {
  public readonly runId: string;
  public readonly runDir: string;
  public readonly latestFilePath: string;

  private readonly enabled: boolean;
  private readonly baseDir: string;
  private readonly rotation: LoggingConfig['rotation'];
  private readonly retention: LoggingConfig['retention'];

  private evaWriter: RotatingFileWriter | null = null;
  private combinedWriter: RotatingFileWriter | null = null;
  private subprocessWriters: Partial<Record<SubprocessService, RotatingFileWriter>> = {};

  public constructor(opts: { config: LoggingConfig; packageRoot: string }) {
    this.enabled = opts.config.enabled;
    this.rotation = opts.config.rotation;
    this.retention = opts.config.retention;
    this.baseDir = path.isAbsolute(opts.config.dir)
      ? opts.config.dir
      : path.resolve(opts.packageRoot, opts.config.dir);

    this.runId = makeRunId(Date.now(), process.pid);
    this.runDir = path.join(this.baseDir, 'runs', this.runId);
    this.latestFilePath = path.join(this.baseDir, 'latest.txt');
  }

  public init(): void {
    if (!this.enabled) {
      return;
    }

    const runsDir = path.join(this.baseDir, 'runs');

    fs.mkdirSync(this.runDir, { recursive: true });
    this.pruneOldRuns(runsDir);

    this.evaWriter = this.createWriter('eva.log');
    this.combinedWriter = this.createWriter('combined.log');
    this.subprocessWriters.agent = this.createWriter('agent.log');
    this.subprocessWriters.vision = this.createWriter('vision.log');
    this.subprocessWriters.audio = this.createWriter('audio.log');

    fs.writeFileSync(this.latestFilePath, `${this.runDir}\n`, 'utf8');
  }

  public log(service: ServiceName, level: LogLevel, message: string): void {
    if (!this.enabled) {
      return;
    }

    const iso = formatIsoTimestamp(Date.now());
    const normalizedMessage = normalizeRecordText(message);

    const record =
      service === 'eva'
        ? `${iso}  [eva]   [${level}] ${normalizedMessage}\n`
        : `${iso}  [${service.padEnd(5)}] [${level}] ${normalizedMessage}\n`;

    this.combinedWriter?.writeLine(record);

    if (service === 'eva') {
      this.evaWriter?.writeLine(record);
      return;
    }

    this.getOrCreateSubprocessWriter(service).writeLine(record);
  }

  public logSubprocessLine(service: Exclude<ServiceName, 'eva'>, stream: LogStream, line: string): void {
    if (!this.enabled) {
      return;
    }

    const iso = formatIsoTimestamp(Date.now());
    const normalizedLine = normalizeRecordText(line);
    const record = `${iso}  [${service.padEnd(5)}] [${stream}] ${normalizedLine}\n`;

    this.getOrCreateSubprocessWriter(service).writeLine(record);
    this.combinedWriter?.writeLine(record);
  }

  public async close(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const writers: RotatingFileWriter[] = [];

    if (this.evaWriter) {
      writers.push(this.evaWriter);
      this.evaWriter = null;
    }

    if (this.combinedWriter) {
      writers.push(this.combinedWriter);
      this.combinedWriter = null;
    }

    for (const service of Object.keys(this.subprocessWriters) as SubprocessService[]) {
      const writer = this.subprocessWriters[service];
      if (writer) {
        writers.push(writer);
      }
      delete this.subprocessWriters[service];
    }

    await Promise.all(writers.map((writer) => writer.close()));
  }

  private pruneOldRuns(runsDir: string): void {
    let runNames: string[];

    try {
      runNames = fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      console.warn(
        `[eva][logging] failed to read run directories in ${runsDir}: ${getErrorMessage(error)} (continuing)`,
      );
      return;
    }

    const deleteCount = runNames.length - this.retention.maxRuns;
    if (deleteCount <= 0) {
      return;
    }

    const toDelete = runNames.slice(0, deleteCount);
    for (const runName of toDelete) {
      const runPath = path.join(runsDir, runName);
      try {
        fs.rmSync(runPath, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[eva][logging] failed to prune run directory ${runPath}: ${getErrorMessage(error)} (continuing)`,
        );
      }
    }
  }

  private createWriter(fileName: string): RotatingFileWriter {
    return new RotatingFileWriter({
      filePath: path.join(this.runDir, fileName),
      maxBytes: this.rotation.maxBytes,
      maxFiles: this.rotation.maxFiles,
    });
  }

  private getOrCreateSubprocessWriter(service: SubprocessService): RotatingFileWriter {
    const existing = this.subprocessWriters[service];
    if (existing) {
      return existing;
    }

    const writer = this.createWriter(`${service}.log`);
    this.subprocessWriters[service] = writer;
    return writer;
  }
}
