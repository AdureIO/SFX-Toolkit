/**
 * Worker-thread entry (bundled to out/serverParseWorker.js): runs the ANTLR Apex parse
 * off the server's event loop. A 3,000-line class takes ~100 ms to parse; on the main
 * thread that delays every request (completion, hover…) queued behind it.
 *
 * Protocol (see parseWorkerClient.ts): `{ id, text }` parses a buffer, `{ id, file }`
 * reads + parses a file from disk (`mtime` echoed back). `lite: true` returns only
 * the type index (members + type declarations) — what cross-file lookups need.
 * Results are plain structured-clone data (objects, arrays, Maps, strings).
 */
import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import { parseApex, ApexParseResult } from './apexSymbols';

interface Req {
    id: number;
    text?: string;
    file?: string;
    lite?: boolean;
}

function lite(r: ApexParseResult): unknown {
    return { index: { types: r.index.types, typeDecls: r.index.typeDecls ?? [] }, errors: r.diagnostics.length };
}

if (parentPort) {
    const port = parentPort;
    port.on('message', (msg: Req) => {
        try {
            let text = msg.text;
            let mtime: number | undefined;
            if (msg.file !== undefined) {
                mtime = fs.statSync(msg.file).mtimeMs;
                text = fs.readFileSync(msg.file, 'utf8');
            }
            const r = parseApex(text ?? '');
            port.postMessage({ id: msg.id, ok: true, result: msg.lite ? lite(r) : r, mtime });
        } catch (e) {
            port.postMessage({ id: msg.id, ok: false, error: String((e as Error)?.message ?? e) });
        }
    });
    // Warm the parser's JIT (first parse of anything is several times slower).
    try {
        parseApex('public class Warm { Integer f; void m(List<Account> a) { for (Account x : a) { if (x != null) { f = 1; } } } }');
    } catch {
        /* ignore */
    }
}
