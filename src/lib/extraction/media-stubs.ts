import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export type MediaStatus = 'awaiting' | 'success' | 'error' | 'ignored';

export interface MediaStub {
  status: MediaStatus;
  attempts: number;
  localPath?: string;
  error?: string;
  updatedAt: string;
}

interface StoreData {
  version: 1;
  stubs: Record<string, MediaStub>;
}

/**
 * Per-asset media status store. Sits alongside ExtractionLog and prevents
 * endless retry of permanently broken URLs on resume. A user (or a future
 * CLI command) can also mark an asset `ignored` to skip it forever.
 *
 * Persisted atomically to `<outputDir>/media-stubs.json`.
 */
export class MediaStubStore {
  readonly storePath: string;
  private data: StoreData;
  /** Default attempt cap — after this many failures, treat as permanent */
  readonly maxAttempts: number;

  private constructor(storePath: string, data: StoreData, maxAttempts: number) {
    this.storePath = storePath;
    this.data = data;
    this.maxAttempts = maxAttempts;
  }

  static load(outputDir: string, { maxAttempts = 3 }: { maxAttempts?: number } = {}): MediaStubStore {
    const storePath = join(outputDir, 'media-stubs.json');
    if (existsSync(storePath)) {
      try {
        const loaded = JSON.parse(readFileSync(storePath, 'utf8')) as StoreData;
        if (loaded.version === 1 && loaded.stubs) {
          return new MediaStubStore(storePath, loaded, maxAttempts);
        }
      } catch {
        // corrupt — fall through to fresh
      }
    }
    return new MediaStubStore(storePath, { version: 1, stubs: {} }, maxAttempts);
  }

  get(url: string): MediaStub | undefined { return this.data.stubs[url]; }

  /**
   * True when the URL has not been permanently resolved (success/ignored) and
   * hasn't exceeded the retry cap.
   */
  shouldAttempt(url: string): boolean {
    const stub = this.data.stubs[url];
    if (!stub) return true;
    if (stub.status === 'success' || stub.status === 'ignored') return false;
    if (stub.status === 'error' && stub.attempts >= this.maxAttempts) return false;
    return true;
  }

  /**
   * Mutations buffer into memory; call `flush()` to persist. `save()`
   * (now equivalent to flush) remains available for one-shot writes but
   * hot paths should prefer `flush()` at checkpoint boundaries.
   */
  private dirty = false;

  markSuccess(url: string, localPath: string): void {
    const prev = this.data.stubs[url];
    this.data.stubs[url] = {
      status: 'success',
      attempts: (prev?.attempts || 0) + 1,
      localPath,
      updatedAt: new Date().toISOString(),
    };
    this.dirty = true;
  }

  markFailure(url: string, error: string): void {
    const prev = this.data.stubs[url];
    this.data.stubs[url] = {
      status: 'error',
      attempts: (prev?.attempts || 0) + 1,
      error,
      updatedAt: new Date().toISOString(),
    };
    // Failures are rare and valuable — persist immediately so a subsequent
    // crash can't leak the attempt count and let us retry beyond the cap.
    this.save();
  }

  markIgnored(url: string, reason?: string): void {
    const prev = this.data.stubs[url];
    this.data.stubs[url] = {
      status: 'ignored',
      attempts: prev?.attempts || 0,
      error: reason,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  /** Flush any pending mutations to disk. Call at checkpoint boundaries. */
  flush(): void {
    if (this.dirty) this.save();
  }

  /** Snapshot of counts by status — for progress reporting. */
  counts(): Record<MediaStatus, number> {
    const out: Record<MediaStatus, number> = { awaiting: 0, success: 0, error: 0, ignored: 0 };
    for (const stub of Object.values(this.data.stubs)) {
      out[stub.status]++;
    }
    return out;
  }

  save(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.storePath);
    this.dirty = false;
  }
}
