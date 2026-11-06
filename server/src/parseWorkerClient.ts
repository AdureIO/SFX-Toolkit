/**
 * Client for the Apex parse worker (parseWorker.ts → out/serverParseWorker.js).
 *
 * One lazily-started worker thread shared by the parse cache (background parses of
 * open documents) and the workspace index (cross-file member lookups). The worker is
 * `unref()`ed so it never keeps the process alive, and `terminate()` (called on
 * release/shutdown) stops it. When the worker file is missing or the worker keeps
 * crashing, parses fall back to the main thread (deferred with setImmediate so callers
 * still get a promise and the current request finishes first).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parseApex, ApexParseResult, ApexIndex } from './apexSymbols';

export const WORKER_FILE = 'serverParseWorker.js';
const MAX_CRASHES = 3;

/** The slice of a parse that cross-file lookups need. */
export interface LiteParse {
    index: Pick<ApexIndex, 'types' | 'typeDecls'>;
    errors: number;
}

interface Pending {
    resolve: (v: { result: any; mtime?: number }) => void;
    reject: (e: Error) => void;
}

class ParseWorkerClient {
    private worker: Worker | undefined;
    private disabled = false;
    private crashes = 0;
    private seq = 0;
    private pending = new Map<number, Pending>();
    /** Overridable for tests / alternative layouts. */
    workerPath = path.join(__dirname, WORKER_FILE);

    /** Start the worker now (it warms its parser JIT on start). No-op when unavailable. */
    warm(): void {
        this.ensure();
    }

    /** Whether background parses actually run off-thread. */
    get offThread(): boolean {
        return !!this.ensure();
    }

    parseText(text: string): Promise<ApexParseResult> {
        return this.send({ text }).then(
            (r) => r.result as ApexParseResult,
            (e) => (isTerminated(e) ? Promise.reject(e) : inThread(() => parseApex(text))),
        );
    }

    /** Read + parse a file, returning just its type index (and the file mtime it saw). */
    parseFileLite(file: string): Promise<{ result: LiteParse; mtime: number } | undefined> {
        return this.send({ file, lite: true }).then(
            (r) => ({ result: r.result as LiteParse, mtime: r.mtime ?? 0 }),
            (e) =>
                isTerminated(e) ? undefined : inThread(() => {
                    try {
                        const mtime = fs.statSync(file).mtimeMs;
                        const r = parseApex(fs.readFileSync(file, 'utf8'));
                        return { result: { index: { types: r.index.types, typeDecls: r.index.typeDecls ?? [] }, errors: r.diagnostics.length }, mtime };
                    } catch {
                        return undefined;
                    }
                }),
        );
    }

    terminate(): void {
        const w = this.worker;
        this.worker = undefined;
        this.failAll(Object.assign(new Error('parse worker terminated'), { terminated: true }));
        if (w) void w.terminate().catch(() => undefined);
    }

    private send(msg: { text?: string; file?: string; lite?: boolean }): Promise<{ result: any; mtime?: number }> {
        const w = this.ensure();
        if (!w) return Promise.reject(new Error('no worker'));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                w.postMessage({ id, ...msg });
            } catch (e) {
                this.pending.delete(id);
                reject(e as Error);
            }
        });
    }

    private ensure(): Worker | undefined {
        if (this.worker) return this.worker;
        if (this.disabled) return undefined;
        if (!fs.existsSync(this.workerPath)) {
            this.disabled = true;
            return undefined;
        }
        let w: Worker;
        try {
            w = new Worker(this.workerPath);
        } catch {
            this.disabled = true;
            return undefined;
        }
        w.unref(); // never keep the server process alive
        w.on('message', (m: { id: number; ok: boolean; result?: any; mtime?: number; error?: string }) => {
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            if (m.ok) p.resolve({ result: m.result, mtime: m.mtime });
            else p.reject(new Error(m.error ?? 'parse failed'));
        });
        const onDeath = () => {
            if (this.worker !== w) return;
            this.worker = undefined;
            this.failAll(new Error('parse worker exited'));
            if (++this.crashes >= MAX_CRASHES) this.disabled = true;
        };
        w.on('error', onDeath);
        w.on('exit', onDeath);
        this.worker = w;
        return w;
    }

    private failAll(e: Error): void {
        const all = [...this.pending.values()];
        this.pending.clear();
        for (const p of all) p.reject(e);
    }
}

function isTerminated(e: unknown): boolean {
    return !!(e as { terminated?: boolean } | undefined)?.terminated;
}

function inThread<T>(fn: () => T): Promise<T> {
    return new Promise((resolve) => setImmediate(() => resolve(fn())));
}

export const ParseWorker = new ParseWorkerClient();
