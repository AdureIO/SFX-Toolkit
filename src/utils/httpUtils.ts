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
            if (status === '401' || status === '403' || status === '404') {
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
