/**
 * Request cancellation helpers.
 *
 * Interactive handlers (completion, hover, definition, signature help, code actions)
 * receive the request's CancellationToken and thread it into every await. Instead
 * of sprinkling `if (token.isCancellationRequested) return …` after each await, the
 * awaited operations throw `RequestCancelled` — the handler's top level catches it
 * (`orCancelled`) and returns its empty value. `raceCancel` also stops waiting on a
 * slow host round-trip the moment the client cancels, so the response goes out
 * immediately and no further host requests are sent for that request.
 */
import type { CancellationToken } from 'vscode-languageserver/node';

export class RequestCancelled extends Error {
    constructor() {
        super('request cancelled');
    }
}

export function isCancelled(e: unknown): e is RequestCancelled {
    return e instanceof RequestCancelled;
}

/** Throw if the token is cancelled. */
export function throwIfCancelled(token?: CancellationToken): void {
    if (token?.isCancellationRequested) throw new RequestCancelled();
}

/**
 * Await `p`, but reject with RequestCancelled as soon as `token` is cancelled (and
 * also if it already was). The underlying promise keeps running — shared in-flight
 * work (e.g. a deduped describe) still completes and populates caches.
 */
export function raceCancel<T>(p: Promise<T>, token?: CancellationToken): Promise<T> {
    if (!token) return p;
    if (token.isCancellationRequested) return Promise.reject(new RequestCancelled());
    return new Promise<T>((resolve, reject) => {
        const sub = token.onCancellationRequested(() => {
            sub.dispose();
            reject(new RequestCancelled());
        });
        p.then(
            (v) => {
                sub.dispose();
                resolve(v);
            },
            (e) => {
                sub.dispose();
                reject(e);
            },
        );
    });
}

/** Run a handler body, mapping a cancellation to `empty`. */
export async function orCancelled<T>(empty: T, body: () => Promise<T> | T): Promise<T> {
    try {
        return await body();
    } catch (e) {
        if (isCancelled(e)) return empty;
        throw e;
    }
}
