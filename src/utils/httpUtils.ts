import * as https from 'https';
import { URL } from 'url';

export function httpsRequest(method: string, url: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: method,
            headers: {
                'Authorization': `Bearer ${token}`
            }
        };

        const req = https.request(options, (res) => {
            // Follow Redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpsRequest(method, res.headers.location, token).then(resolve).catch(reject);
                return;
            }
            
            const chunks: any[] = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(body);
                } else {
                    reject(new Error(`Status: ${res.statusCode}, Body: ${body}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.end();
    });
}

export function httpsGet(url: string, token: string): Promise<string> {
    return httpsRequest('GET', url, token);
}

export function httpsDelete(url: string, token: string): Promise<string> {
    return httpsRequest('DELETE', url, token);
}
