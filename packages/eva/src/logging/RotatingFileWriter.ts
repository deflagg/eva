import fs from 'node:fs';
import path from 'node:path';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class RotatingFileWriter {
  private stream: fs.WriteStream;
  private currentSizeBytes: number;
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private droppedWrites = 0;

  public constructor(
    private readonly opts: {
      filePath: string;
      maxBytes: number;
      maxFiles: number;
    },
  ) {
    fs.mkdirSync(path.dirname(this.opts.filePath), { recursive: true });
    this.currentSizeBytes = this.getInitialSize();
    this.stream = fs.createWriteStream(this.opts.filePath, { flags: 'a' });
  }

  public writeLine(line: string): void {
    if (this.closed || this.closing) {
      return;
    }

    this.writeChain = this.writeChain
      .catch(() => {
        // Keep the chain alive.
      })
      .then(async () => {
        if (this.closed) {
          return;
        }

        const recordBytes = Buffer.byteLength(line, 'utf8');
        if (this.currentSizeBytes + recordBytes > this.opts.maxBytes) {
          await this.rotate();
        }

        try {
          this.stream.write(line);
          this.currentSizeBytes += recordBytes;
        } catch (error) {
          this.droppedWrites += 1;
          console.warn(
            `[eva][logging] failed to write ${this.opts.filePath}: ${getErrorMessage(error)} (dropped=${this.droppedWrites})`,
          );
        }
      });
  }

  public async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    if (this.closed) {
      return;
    }

    this.closing = true;

    this.closePromise = (async () => {
      await this.writeChain.catch(() => {
        // Best effort.
      });

      await this.closeStream(this.stream);
      this.closed = true;
      this.closing = false;
    })();

    return this.closePromise;
  }

  private async rotate(): Promise<void> {
    await this.closeStream(this.stream);

    const oldestBackupPath = `${this.opts.filePath}.${this.opts.maxFiles}`;
    if (fileExists(oldestBackupPath)) {
      try {
        fs.rmSync(oldestBackupPath, { force: true });
      } catch (error) {
        console.warn(
          `[eva][logging] failed deleting ${oldestBackupPath}: ${getErrorMessage(error)} (continuing)`,
        );
      }
    }

    for (let i = this.opts.maxFiles - 1; i >= 1; i -= 1) {
      const source = `${this.opts.filePath}.${i}`;
      const target = `${this.opts.filePath}.${i + 1}`;

      if (!fileExists(source)) {
        continue;
      }

      try {
        fs.renameSync(source, target);
      } catch (error) {
        console.warn(
          `[eva][logging] failed rotating ${source} -> ${target}: ${getErrorMessage(error)} (continuing)`,
        );
      }
    }

    if (fileExists(this.opts.filePath)) {
      try {
        fs.renameSync(this.opts.filePath, `${this.opts.filePath}.1`);
      } catch (error) {
        console.warn(
          `[eva][logging] failed rotating ${this.opts.filePath} -> ${this.opts.filePath}.1: ${getErrorMessage(error)} (continuing)`,
        );
      }
    }

    this.stream = fs.createWriteStream(this.opts.filePath, { flags: 'a' });
    this.currentSizeBytes = 0;
  }

  private getInitialSize(): number {
    try {
      return fs.statSync(this.opts.filePath).size;
    } catch {
      return 0;
    }
  }

  private async closeStream(stream: fs.WriteStream): Promise<void> {
    if (stream.closed || stream.destroyed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      stream.once('close', finish);
      stream.once('error', finish);

      try {
        stream.end();
      } catch {
        finish();
      }
    });
  }
}
