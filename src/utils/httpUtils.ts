import * as https from 'https';
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
    timeout: number;
    /** Max characters of the error body included in rejection messages. */
    errorSnippet: number;
    /** Follow 3xx redirects (only for bodiless requests). */
    followRedirects: boolean;
}

/**
 * Single request core: enforces a timeout, destroys the socket/response on timeout
 * or error (no leaked sockets), drains redirect bodies, resolves relative Location
 * headers and strips Authorization when redirected to an untrusted host.
 */
function rawRequest(opts: RawRequest, hops = 0): Promise<string> {
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
        const fail = (e: Error) => {
            if (settled) return;
            settled = true;
            reject(e);
        };
        const ok = (v: string) => {
            if (settled) return;
            settled = true;
            resolve(v);
        };

        const headers: Record<string, string | number> = { ...opts.headers };
        if (opts.body) headers['Content-Length'] = opts.body.length;

        const req = https.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || undefined,
                path: parsed.pathname + parsed.search,
                method: opts.method,
                headers,
                timeout: opts.timeout,
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (opts.followRedirects && status >= 300 && status < 400 && res.headers.location) {
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
                    rawRequest({ ...opts, url: next.toString(), headers: nextHeaders }, hops + 1).then(resolve, reject);
                    return;
                }

                const chunks: any[] = [];
                res.on('data', (d) => chunks.push(d));
                res.on('error', (e) => {
                    res.destroy();
                    fail(e);
                });
                res.on('aborted', () => fail(new Error(`Response aborted: ${opts.method} ${parsed.origin}${parsed.pathname}`)));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString();
                    if (status >= 200 && status < 300) {
                        ok(text);
                    } else {
                        fail(new Error(`HTTP ${status}: ${text.slice(0, opts.errorSnippet)}`));
                    }
                });
            }
        );

        req.on('timeout', () => {
            req.destroy();
            fail(new Error(`Request timed out after ${opts.timeout}ms: ${opts.method} ${opts.url}`));
        });
        req.on('error', (e) => {
            req.destroy();
            fail(e);
        });
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
    });
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
            const status = e.message?.match(/HTTP (\d+)/)?.[1];
            const code = status ? parseInt(status, 10) : 0;
            // 4xx client errors (malformed query, bad field, auth, not found) will never
            // succeed on retry — fail fast instead of burning ~3s of backoff. Only 429
            // (rate limit) is worth retrying among 4xx; 5xx and network errors still retry.
            if (code >= 400 && code < 500 && code !== 429) {
                throw e;
            }
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
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
 */
export function httpsGetRange(url: string, token: string, maxBytes: number): Promise<string> {
    return rawRequest({
        method: 'GET',
        url,
        headers: { Authorization: `Bearer ${token}`, Range: `bytes=0-${maxBytes}` },
        timeout: getHttpTimeout(),
        errorSnippet: 300,
        followRedirects: true,
    });
}
