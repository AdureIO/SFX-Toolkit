import * as https from 'https';
import { URL } from 'url';
import { getHttpTimeout } from './constants';
import { Logger } from './outputChannel';

export function httpsRequest(method: string, url: string, token: string, timeoutMs?: number): Promise<string> {
    const timeout = timeoutMs ?? getHttpTimeout();
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: method,
            headers: {
                Authorization: `Bearer ${token}`
            },
            timeout: timeout
        };

        const req = https.request(options, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpsRequest(method, res.headers.location, token, timeout).then(resolve).catch(reject);
                return;
            }

            const chunks: any[] = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(body);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timed out after ${timeout}ms: ${method} ${url}`));
        });

        req.on('error', (e) => reject(e));
        req.end();
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
 * caller supplies any auth header it needs.
 */
export function httpsPost(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs?: number
): Promise<string> {
    const timeout = timeoutMs ?? getHttpTimeout();
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const data = Buffer.from(body, 'utf8');
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: { ...headers, 'Content-Length': data.length },
            timeout,
        };
        const req = https.request(options, (res) => {
            const chunks: any[] = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(text);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 1000)}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timed out after ${timeout}ms: POST ${url}`));
        });
        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

export function httpsDelete(url: string, token: string): Promise<string> {
    return httpsRequest('DELETE', url, token);
}

/**
 * PATCH with a request body and custom headers. Resolves with response text on
 * 2xx; rejects with `HTTP <status>: <body>` otherwise. Used for the Metadata REST
 * deploy-cancel call.
 */
export function httpsPatch(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs?: number
): Promise<string> {
    const timeout = timeoutMs ?? getHttpTimeout();
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const data = Buffer.from(body, 'utf8');
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'PATCH',
            headers: { ...headers, 'Content-Length': data.length },
            timeout,
        };
        const req = https.request(options, (res) => {
            const chunks: any[] = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(text);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 1000)}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timed out after ${timeout}ms: PATCH ${url}`));
        });
        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

/**
 * GET only the first `maxBytes` of a resource via a Range request. Salesforce may
 * honor it (206 partial) or ignore it (200 full) — either is returned as-is.
 */
export function httpsGetRange(url: string, token: string, maxBytes: number): Promise<string> {
    const timeout = getHttpTimeout();
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request(
            {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: { Authorization: `Bearer ${token}`, Range: `bytes=0-${maxBytes}` },
                timeout,
            },
            (res) => {
                const chunks: any[] = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString();
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(body);
                    else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
                });
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out: GET ${url}`)); });
        req.on('error', (e) => reject(e));
        req.end();
    });
}
