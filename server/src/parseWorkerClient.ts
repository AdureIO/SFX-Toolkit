/**
 * Client for the Apex parse workers (parseWorker.ts → out/serverParseWorker.js).
 *
 * A small lazily-grown pool of worker threads shared by the parse cache (background
 * parses of open documents) and the workspace index / symbol search (cross-file
 * lookups). Pool size is 1 by default; the setting `apex.languageServerParseWorkers`
 * (initializationOptions `parseWorkers`, 1..4) raises it, and env `ASFX_PARSE_WORKERS`
 * (capped at 16) wins over both. The first worker starts on the first parse; another is started only
 * when a job has to wait behind busy workers (outstanding work > 1), and extra workers are
 * terminated after IDLE_MS without work. Every worker is `unref()`ed so none keeps the
 * process alive, and `terminate()` (release/shutdown) stops them all.
 *
 * Scheduling: one central queue, each worker has at most one job in flight (so work is
 * always handed to whichever worker frees up first = least loaded, and a priority
 * request never waits behind a backlog already sent to a particular worker).
 * `interactive` jobs are taken before every `background` job; FIFO within a class.
 * Results are matched by job id, so same-document ordering is the caller's concern:
 * ParseCache keeps one parse in flight per document and adopts a result only if its
 * version is newer than the cached one, which is independent of completion order.
 *
 * When the worker file is missing or workers keep crashing (MAX_CRASHES in total),
 * parses fall back to the main thread (deferred with setImmediate so callers still
 * get a promise and the current request finishes first). A job that was in flight on
 * a crashed worker is rejected (callers then parse in-thread); queued jobs simply move
 * to the remaining / a fresh worker.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parseApex, ApexParseResult, ApexIndex } from './apexSymbols';

export const WORKER_FILE = 'serverParseWorker.js';
const MAX_CRASHES = 3;
const MAX_POOL = 4;
const DEFAULT_POOL = 1;
const IDLE_MS = 30_000;

/** `interactive`: the user is waiting (open document); `background`: bulk / speculative parses. */
export type ParsePriority = 'interactive' | 'background';

/**
 * Number of workers the pool may grow to: env `ASFX_PARSE_WORKERS` (1..16) wins, then the
 * configured option (clamped to 1..4), then 1.
 */
export function poolSize(option?: number): number {
    const env = Number(process.env.ASFX_PARSE_WORKERS);
    if (process.env.ASFX_PARSE_WORKERS && Number.isFinite(env) && env >= 1) return Math.min(16, Math.floor(env));
    if (typeof option === 'number' && Number.isFinite(option)) return Math.max(1, Math.min(MAX_POOL, Math.floor(option)));
    return DEFAULT_POOL;
}

/** The slice of a parse that cross-file lookups need. */
export interface LiteParse {
    index: Pick<ApexIndex, 'types' | 'typeDecls'>;
    errors: number;
}

interface Job {
    id: number;
    msg: { text?: string; file?: string; lite?: boolean };
    resolve: (v: { result: any; mtime?: number }) => void;
    reject: (e: Error) => void;
}

interface Slot {
    worker: Worker;
    job: Job | undefined;
    idleTimer: NodeJS.Timeout | undefined;
    dead: boolean;
}

type WorkerReply = { id: number; ok: boolean; result?: any; mtime?: number; error?: string };

class ParseWorkerClient {
    private slots: Slot[] = [];
    private disabled = false;
    private crashes = 0;
    private seq = 0;
    private interactiveQ: Job[] = [];
    private backgroundQ: Job[] = [];
    /** Overridable for tests / alternative layouts. */
    workerPath = path.join(__dirname, WORKER_FILE);
    /** Idle time after which workers beyond the first are terminated (tests shorten it). */
    idleMs = IDLE_MS;
    /** Pool size cap; undefined = poolSize(configured) (env / option / default). */
    maxWorkers: number | undefined;
    /** Size from the client setting (initializationOptions.parseWorkers). */
    configured: number | undefined;

    /** Apply the client setting (the env var still wins). */
    configure(workers: unknown): void {
        this.configured = typeof workers === 'number' ? workers : undefined;
    }

    /** Start the first worker now (it warms its parser JIT on start). No-op when unavailable. */
    warm(): void {
        this.ensureOne();
    }

    /** Whether background parses actually run off-thread. */
    get offThread(): boolean {
        return this.ensureOne();
    }

    /** Pool state, for tests and diagnostics. */
    get stats(): { workers: number; busy: number; queued: number; crashes: number; disabled: boolean } {
        return {
            workers: this.slots.length,
            busy: this.slots.filter((s) => s.job).length,
            queued: this.interactiveQ.length + this.backgroundQ.length,
            crashes: this.crashes,
            disabled: this.disabled,
        };
    }

    parseText(text: string, priority: ParsePriority = 'interactive'): Promise<ApexParseResult> {
        return this.send({ text }, priority).then(
            (r) => r.result as ApexParseResult,
            (e) => (isTerminated(e) ? Promise.reject(e) : inThread(() => parseApex(text))),
        );
    }

    /** Read + parse a file, returning just its type index (and the file mtime it saw). */
    parseFileLite(file: string, priority: ParsePriority = 'background'): Promise<{ result: LiteParse; mtime: number } | undefined> {
        return this.send({ file, lite: true }, priority).then(
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

    /** Stop every worker and reject every queued / in-flight job (with a `terminated` error). */
    terminate(): void {
        const slots = this.slots;
        this.slots = [];
        const err = Object.assign(new Error('parse worker terminated'), { terminated: true });
        const jobs = [...this.interactiveQ, ...this.backgroundQ];
        this.interactiveQ = [];
        this.backgroundQ = [];
        for (const s of slots) {
            s.dead = true;
            if (s.idleTimer) clearTimeout(s.idleTimer);
            if (s.job) jobs.push(s.job);
            s.job = undefined;
            void s.worker.terminate().catch(() => undefined);
        }
        for (const j of jobs) j.reject(err);
    }

    private send(msg: Job['msg'], priority: ParsePriority): Promise<{ result: any; mtime?: number }> {
        if (this.disabled || (!this.slots.length && !this.workerAvailable())) return Promise.reject(new Error('no worker'));
        return new Promise((resolve, reject) => {
            const job: Job = { id: ++this.seq, msg, resolve, reject };
            (priority === 'interactive' ? this.interactiveQ : this.backgroundQ).push(job);
            this.pump();
        });
    }

    /** Hand queued jobs to idle workers; grow the pool when work is waiting behind busy ones. */
    private pump(): void {
        for (;;) {
            const queued = this.interactiveQ.length + this.backgroundQ.length;
            if (!queued) return;
            let slot = this.slots.find((s) => !s.job);
            if (!slot) {
                const cap = this.maxWorkers ?? poolSize(this.configured);
                if (this.slots.length < cap) slot = this.spawn(); // every worker busy and a job waiting: outstanding work > 1
                if (!slot) {
                    if (this.slots.length === 0) this.failQueued(new Error('no worker'));
                    return;
                }
            }
            const job = (this.interactiveQ.length ? this.interactiveQ : this.backgroundQ).shift()!;
            this.dispatch(slot, job);
        }
    }

    private dispatch(slot: Slot, job: Job): void {
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        slot.idleTimer = undefined;
        slot.job = job;
        try {
            slot.worker.postMessage({ id: job.id, ...job.msg });
        } catch (e) {
            slot.job = undefined;
            job.reject(e as Error);
            this.markIdle(slot);
        }
    }

    private markIdle(slot: Slot): void {
        if (slot.dead || slot.job) return;
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        slot.idleTimer = setTimeout(() => {
            slot.idleTimer = undefined;
            // Keep one worker for the next burst; reap the rest.
            if (slot.dead || slot.job || this.slots.length <= 1) return;
            this.retire(slot);
        }, this.idleMs);
        slot.idleTimer.unref();
    }

    private retire(slot: Slot): void {
        slot.dead = true;
        this.slots = this.slots.filter((s) => s !== slot);
        void slot.worker.terminate().catch(() => undefined);
    }

    private workerAvailable(): boolean {
        if (this.disabled) return false;
        if (!fs.existsSync(this.workerPath)) {
            this.disabled = true;
            return false;
        }
        return true;
    }

    private ensureOne(): boolean {
        if (this.slots.length) return true;
        return !!this.spawn();
    }

    private spawn(): Slot | undefined {
        if (!this.workerAvailable()) return undefined;
        let w: Worker;
        try {
            w = new Worker(this.workerPath);
        } catch {
            this.disabled = true;
            return undefined;
        }
        w.unref(); // never keep the server process alive
        const slot: Slot = { worker: w, job: undefined, idleTimer: undefined, dead: false };
        w.on('message', (m: WorkerReply) => {
            const job = slot.job;
            if (slot.dead || !job || job.id !== m.id) return;
            slot.job = undefined;
            if (m.ok) job.resolve({ result: m.result, mtime: m.mtime });
            else job.reject(new Error(m.error ?? 'parse failed'));
            this.pump();
            this.markIdle(slot);
        });
        const onDeath = () => {
            if (slot.dead) return;
            slot.dead = true;
            if (slot.idleTimer) clearTimeout(slot.idleTimer);
            this.slots = this.slots.filter((s) => s !== slot);
            if (++this.crashes >= MAX_CRASHES) this.disabled = true;
            const job = slot.job;
            slot.job = undefined;
            // The in-flight job fails (callers parse in-thread); queued ones go to another worker.
            job?.reject(new Error('parse worker exited'));
            if (this.disabled) this.failQueued(new Error('parse worker exited'));
            else this.pump();
        };
        w.on('error', onDeath);
        w.on('exit', onDeath);
        this.slots.push(slot);
        this.markIdle(slot);
        return slot;
    }

    private failQueued(e: Error): void {
        const jobs = [...this.interactiveQ, ...this.backgroundQ];
        this.interactiveQ = [];
        this.backgroundQ = [];
        for (const j of jobs) j.reject(e);
    }
}

function isTerminated(e: unknown): boolean {
    return !!(e as { terminated?: boolean } | undefined)?.terminated;
}

function inThread<T>(fn: () => T): Promise<T> {
    return new Promise((resolve) => setImmediate(() => resolve(fn())));
}

export const ParseWorker = new ParseWorkerClient();
