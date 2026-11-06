import * as https from 'https';
import type { IncomingHttpHeaders } from 'http';
import * as zlib from 'zlib';
import { URL } from 'url';
import { getHttpTimeout } from './constants';
import { Logger } from './outputChannel';

/** Maximum number of redirects followed for a single request. */
const MAX_REDIRECTS = 5;

/** Hosts (suffix match) to which we are willing to forward a Salesforce bearer token on redirect. */
const TRUSTED_SF_HOST_SUFFIXES = [
    '.salesforce.com',
    '.force.com',
    '.salesforce-setup.com',
    '.my.salesforce-sites.com',
];

function isTrustedSalesforceHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return TRUSTED_SF_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix) || h === suffix.slice(1));
}

/**
 * Only forward credentials on redirect to the same origin or to a known Salesforce host,
 * and never downgrade from https.
 */
function mayForwardAuth(from: URL, to: URL): boolean {
    if (to.protocol !== 'https:') return false;
    if (from.origin === to.origin) return true;
    return isTrustedSalesforceHost(to.hostname);
}

interface RawRequest {
    method: string;
    url: string;
    headers: Record<string, string | number>;
    body?: Buffer;
    /** Socket idle timeout (ms). */
    timeout: number;
    /** Max characters of the error body included in rejection messages. */
    errorSnippet: number;
    /** Follow 3xx redirects (only for bodiless requests). */
    followRedirects: boolean;
    /** Ask for a gzip/deflate response (`Accept-Encoding`) and decompress it. */
    gzip?: boolean;
    /** Hard cap on the whole request (connect + all data, across redirects), unlike the idle `timeout`. */
    totalTimeoutMs?: number;
    /** Extra non-2xx statuses that resolve instead of rejecting (e.g. 304). */
    acceptStatus?: number[];
    /**
     * Idempotent request: on a transient socket error (stalled/reset keep-alive socket) retry
     * once immediately on a fresh connection. Never set for POST/PATCH (not idempotent).
     */
    retryTransient?: boolean;
    /** Use a brand-new, non-pooled connection (`agent: false`) instead of a possibly stale keep-alive socket. */
    freshSocket?: boolean;
}

/** Full response of a request: status, headers and the (decompressed) body. */
export interface HttpResponse {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
}

/** Error thrown for a failed request; `status` / `timedOut` let callers classify it. */
export interface HttpError extends Error {
    status?: number;
    timedOut?: boolean;
    /** Node/OS socket error code (ETIMEDOUT, ECONNRESET, ...), preserved when the error is wrapped. */
    code?: string;
    /** True when this is a wrapped socket-level failure (no HTTP response was received). */
    networkError?: boolean;
}

/** Wording for failed POST/PATCH: they are never retried and the server may have processed them. */
const UNKNOWN_OUTCOME_HINT = 'the connection dropped before the response arrived. The request may still have completed on the server; check the result before re-running.';
const MAY_HAVE_COMPLETED = ' The request may still have completed on the server; check the result before re-running.';

/** GET/DELETE are safe to repeat; everything else (POST/PATCH) is not. */
function isIdempotentMethod(method: string): boolean {
    return method === 'GET' || method === 'DELETE' || method === 'HEAD';
}

/** Clamp a configured timeout: non-numbers fall back to `def`, numbers below `min` are raised to it. */
export function clampTimeoutMs(raw: unknown, def: number, min: number): number {
    return typeof raw === 'number' && isFinite(raw) ? Math.max(min, raw) : def;
}

/** Socket-level error codes that indicate a stale/stalled connection rather than a server answer. */
const TRANSIENT_SOCKET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

/** Whether `e` is a transient socket error (reset/stalled/broken pipe/DNS hiccup), wrapped or raw. */
export function isTransientSocketError(e: any): boolean {
    if (!e) return false;
    if (typeof e.code === 'string' && TRANSIENT_SOCKET_CODES.has(e.code)) return true;
    return /socket hang up|\b(ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN)\b/.test(String(e.message ?? ''));
}

/**
 * Wrap a raw socket error into a readable message naming the host, keeping the original
 * message in parentheses and `code` on the error so classification keeps working.
 */
export function wrapNetworkError(e: any, host: string, idempotent = true): HttpError {
    const raw = String(e?.message ?? e);
    const code: string | undefined = typeof e?.code === 'string' ? e.code : /\b(ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH)\b/.exec(raw)?.[1];
    let hint: string;
    if (code === 'ETIMEDOUT') hint = 'the connection stalled; the org may be busy. Try again.';
    else if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/.test(raw)) hint = 'the connection was reset. Try again.';
    else if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') hint = 'the host name could not be resolved. Check your network connection.';
    else if (code === 'ECONNREFUSED' || code === 'ENETUNREACH') hint = 'the host could not be reached. Check your network connection.';
    else hint = 'the request did not complete. Try again.';
    if (!idempotent) hint = UNKNOWN_OUTCOME_HINT;
    const w = httpError(`Network error talking to ${host} (${raw}) — ${hint}`) as HttpError;
    if (code) w.code = code;
    w.networkError = true;
    return w;
}

function httpError(message: string, status?: number, timedOut?: boolean): HttpError {
    const e = new Error(message) as HttpError;
    if (status !== undefined) e.status = status;
    if (timedOut) e.timedOut = true;
    return e;
}

/** Decompress a response body per its Content-Encoding (identity when absent). */
function decode(buf: Buffer, encoding: string | undefined, cb: (err: Error | null, out?: Buffer) => void): void {
    const enc = (encoding || '').toLowerCase().trim();
    if (!buf.length) cb(null, buf);
    else if (enc === 'gzip' || enc === 'x-gzip') zlib.gunzip(buf, cb);
    else if (enc === 'deflate') zlib.inflate(buf, (err, out) => (err ? zlib.inflateRaw(buf, cb) : cb(null, out)));
    else if (enc === 'br') zlib.brotliDecompress(buf, cb);
    else cb(null, buf);
}

function rawRequest(opts: RawRequest): Promise<string> {
    return rawRequestEx(opts).then((r) => r.body);
}

/**
 * Single request core: enforces an idle timeout (and optionally a total deadline),
 * destroys the socket/response on timeout or error (no leaked sockets), drains
 * redirect bodies, resolves relative Location headers, strips Authorization when
 * redirected to an untrusted host, and decompresses gzip/deflate bodies.
 */
function rawRequestEx(opts: RawRequest, hops = 0, startedAt = Date.now()): Promise<HttpResponse> {
    if (!opts.retryTransient) return rawRequestOnce(opts, hops, startedAt);
    return rawRequestOnce(opts, hops, startedAt).catch((e: any) => {
        const outOfTime = opts.totalTimeoutMs !== undefined && Date.now() - startedAt >= opts.totalTimeoutMs;
        if (!isTransientSocketError(e) || outOfTime) throw e;
        Logger.warn(`HTTP ${opts.method} hit a socket error, retrying once on a fresh connection: ${e.message}`);
        return rawRequestOnce({ ...opts, freshSocket: true }, 0, startedAt);
    });
}

function rawRequestOnce(opts: RawRequest, hops = 0, startedAt = Date.now()): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(opts.url);
        } catch (e) {
            reject(e);
            return;
        }
        if (parsed.protocol !== 'https:') {
            reject(new Error(`Refusing non-https request: ${opts.method} ${parsed.origin}`));
            return;
        }

        let settled = false;
        let totalTimer: NodeJS.Timeout | undefined;
        const fail = (e: Error) => {
            if (settled) return;
            settled = true;
            if (totalTimer) clearTimeout(totalTimer);
            reject(e);
        };
        const ok = (v: HttpResponse) => {
            if (settled) return;
            settled = true;
            if (totalTimer) clearTimeout(totalTimer);
            resolve(v);
        };

        const headers: Record<string, string | number> = { ...opts.headers };
        if (opts.body) headers['Content-Length'] = opts.body.length;
        if (opts.gzip && !Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) {
            headers['Accept-Encoding'] = 'gzip, deflate';
        }

        const req = https.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || undefined,
                path: parsed.pathname + parsed.search,
                method: opts.method,
                headers,
                timeout: opts.timeout,
                ...(opts.freshSocket ? { agent: false } : {}),
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (opts.followRedirects && status >= 300 && status < 400 && status !== 304 && res.headers.location) {
                    // Drain the redirect body so the socket can be released.
                    res.resume();
                    if (hops >= MAX_REDIRECTS) {
                        fail(new Error(`Too many redirects (>${MAX_REDIRECTS}): ${opts.method} ${parsed.origin}${parsed.pathname}`));
                        return;
                    }
                    let next: URL;
                    try {
                        next = new URL(res.headers.location, parsed);
                    } catch (e: any) {
                        fail(new Error(`Invalid redirect location: ${e?.message ?? e}`));
                        return;
                    }
                    const nextHeaders = { ...opts.headers };
                    if (!mayForwardAuth(parsed, next)) {
                        for (const k of Object.keys(nextHeaders)) {
                            if (k.toLowerCase() === 'authorization') delete nextHeaders[k];
                        }
                    }
                    settled = true;
                    if (totalTimer) clearTimeout(totalTimer);
                    rawRequestOnce({ ...opts, url: next.toString(), headers: nextHeaders }, hops + 1, startedAt).then(resolve, reject);
                    return;
                }

                const chunks: Buffer[] = [];
                res.on('data', (d) => chunks.push(d));
                res.on('error', (e) => {
                    res.destroy();
                    fail(wrapNetworkError(e, parsed.host, isIdempotentMethod(opts.method)));
                });
                res.on('aborted', () => {
                    const a = new Error(`Response aborted: ${opts.method} ${parsed.origin}${parsed.pathname}`) as HttpError;
                    a.code = 'ECONNRESET';
                    fail(a);
                });
                res.on('end', () => {
                    decode(Buffer.concat(chunks), res.headers['content-encoding'] as string | undefined, (err, buf) => {
                        if (err || !buf) {
                            fail(new Error(`Could not decode response (${res.headers['content-encoding']}): ${err?.message ?? 'empty'}`));
                            return;
                        }
                        const text = buf.toString();
                        if ((status >= 200 && status < 300) || opts.acceptStatus?.includes(status)) {
                            ok({ status, headers: res.headers, body: text });
                        } else {
                            fail(httpError(`HTTP ${status}: ${text.slice(0, opts.errorSnippet)}`, status));
                        }
                    });
                });
            }
        );

        req.on('timeout', () => {
            req.destroy();
            fail(httpError(`Request timed out after ${opts.timeout}ms: ${opts.method} ${opts.url}${isIdempotentMethod(opts.method) ? '' : MAY_HAVE_COMPLETED}`, undefined, true));
        });
        req.on('error', (e) => {
            req.destroy();
            fail(wrapNetworkError(e, parsed.host, isIdempotentMethod(opts.method)));
        });
        if (opts.totalTimeoutMs !== undefined) {
            const remaining = Math.max(1, opts.totalTimeoutMs - (Date.now() - startedAt));
            totalTimer = setTimeout(() => {
                req.destroy();
                fail(httpError(`Request exceeded ${opts.totalTimeoutMs}ms: ${opts.method} ${parsed.origin}${parsed.pathname}${isIdempotentMethod(opts.method) ? '' : MAY_HAVE_COMPLETED}`, undefined, true));
            }, remaining);
            totalTimer.unref?.();
        }
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

export function httpsRequest(method: string, url: string, token: string, timeoutMs?: number): Promise<string> {
    return rawRequest({
        method,
        url,
        headers: { Authorization: `Bearer ${token}` },
        timeout: timeoutMs ?? getHttpTimeout(),
        errorSnippet: 500,
        followRedirects: true,
        gzip: method === 'GET',
        retryTransient: method === 'GET' || method === 'DELETE',
    });
}

/** Retry delay before attempt `attempt + 1` (exponential, capped at 5 s). */
export function retryDelayMs(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt), 5000);
}

/**
 * Whether a failed request is worth retrying: network errors, timeouts, 5xx and 429.
 * Other 4xx (malformed query, bad field, auth, not found) never succeed on retry.
 */
export function isRetryableHttpError(e: any): boolean {
    const fromMsg = String(e?.message ?? '').match(/HTTP (\d+)/)?.[1];
    const status: number | undefined = typeof e?.status === 'number' ? e.status : fromMsg ? parseInt(fromMsg, 10) : undefined;
    if (status === undefined) return true;
    return status >= 500 || status === 429;
}

export async function httpsRequestWithRetry(
    method: string,
    url: string,
    token: string,
    maxRetries: number = 2,
    timeoutMs?: number
): Promise<string> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await httpsRequest(method, url, token, timeoutMs);
        } catch (e: any) {
            lastError = e;
            if (!isRetryableHttpError(e)) {
                throw e;
            }
            if (attempt < maxRetries) {
                const delay = retryDelayMs(attempt);
                Logger.warn(`HTTP ${method} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${e.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}

export function httpsGet(url: string, token: string): Promise<string> {
    return httpsRequestWithRetry('GET', url, token);
}

/** Options for {@link httpsGetEx}. */
export interface GetOptions {
    /** Extra request headers (e.g. If-Modified-Since). */
    headers?: Record<string, string>;
    /** Hard cap on the whole call including retries and backoff (default: none). */
    totalTimeoutMs?: number;
    /** Retries for network errors / timeouts / 5xx / 429 (default 2). */
    maxRetries?: number;
}

/**
 * Authenticated gzip GET returning status + headers. A 304 resolves (for
 * If-Modified-Since revalidation). Transient failures are retried, but never
 * past `totalTimeoutMs`, so a describe can't hang for a minute and a half.
 */
export async function httpsGetEx(url: string, token: string, opts: GetOptions = {}): Promise<HttpResponse> {
    const maxRetries = opts.maxRetries ?? 2;
    const deadline = opts.totalTimeoutMs !== undefined ? Date.now() + opts.totalTimeoutMs : undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const remaining = deadline !== undefined ? deadline - Date.now() : undefined;
        if (remaining !== undefined && remaining <= 0) break;
        try {
            return await rawRequestEx({
                method: 'GET',
                url,
                headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
                timeout: remaining !== undefined ? Math.min(getHttpTimeout(), remaining) : getHttpTimeout(),
                totalTimeoutMs: remaining,
                errorSnippet: 500,
                followRedirects: true,
                gzip: true,
                acceptStatus: [304],
                retryTransient: true,
            });
        } catch (e: any) {
            lastError = e;
            if (!isRetryableHttpError(e) || attempt >= maxRetries) throw e;
            const delay = retryDelayMs(attempt);
            if (deadline !== undefined && Date.now() + delay >= deadline) throw e;
            Logger.warn(`HTTP GET failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${e.message}`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastError ?? httpError(`Request exceeded ${opts.totalTimeoutMs}ms: GET ${url}`, undefined, true);
}

/**
 * POST with a request body and custom headers (e.g. SOAP). Resolves with the
 * response text on 2xx; rejects with `HTTP <status>: <body>` otherwise. The
 * caller supplies any auth header it needs. Redirects are not followed.
 */
export function httpsPost(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs?: number
): Promise<string> {
    return rawRequest({
        method: 'POST',
        url,
        headers,
        body: Buffer.from(body, 'utf8'),
        timeout: timeoutMs ?? getHttpTimeout(),
        errorSnippet: 1000,
        followRedirects: false,
    });
}

/**
 * POST returning status + headers, with a gzip response and an overall deadline.
 * Used for REST composite/batch describes, whose responses are large. Not retried.
 */
export function httpsPostEx(
    url: string,
    body: string,
    headers: Record<string, string>,
    opts: { totalTimeoutMs?: number } = {}
): Promise<HttpResponse> {
    return rawRequestEx({
        method: 'POST',
        url,
        headers,
        body: Buffer.from(body, 'utf8'),
        timeout: opts.totalTimeoutMs !== undefined ? Math.min(getHttpTimeout(), opts.totalTimeoutMs) : getHttpTimeout(),
        totalTimeoutMs: opts.totalTimeoutMs,
        errorSnippet: 1000,
        followRedirects: false,
        gzip: true,
    });
}

export function httpsDelete(url: string, token: string): Promise<string> {
    return httpsRequest('DELETE', url, token);
}

/**
 * PATCH with a request body and custom headers. Resolves with response text on
 * 2xx; rejects with `HTTP <status>: <body>` otherwise. Used for the Metadata REST
 * deploy-cancel call. Redirects are not followed.
 */
export function httpsPatch(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs?: number
): Promise<string> {
    return rawRequest({
        method: 'PATCH',
        url,
        headers,
        body: Buffer.from(body, 'utf8'),
        timeout: timeoutMs ?? getHttpTimeout(),
        errorSnippet: 1000,
        followRedirects: false,
    });
}

/**
 * GET only the first `maxBytes` of a resource via a Range request. Salesforce may
 * honor it (206 partial) or ignore it (200 full) — either is returned as-is.
 * (No gzip: byte ranges of a compressed stream are meaningless to the caller.)
 */
export function httpsGetRange(url: string, token: string, maxBytes: number): Promise<string> {
    return rawRequest({
        method: 'GET',
        url,
        headers: { Authorization: `Bearer ${token}`, Range: `bytes=0-${maxBytes}` },
        timeout: getHttpTimeout(),
        errorSnippet: 300,
        followRedirects: true,
        retryTransient: true,
    });
}
