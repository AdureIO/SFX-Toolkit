/**
 * Locates the SObject "schema stub" .cls file for go-to-definition. Stubs live in
 * the Salesforce Apex LS folder (.sfdx/tools/sobjects/{standardObjects,customObjects})
 * — the same files the background sync generates and the Salesforce LS reads — so
 * navigation lands in a single, shared location (no separate custom dir).
 *
 * If a file already exists (written by the sync or by Salesforce) we read its line
 * numbers from disk so navigation matches what the user sees; otherwise we
 * generate a stub on demand into that same location.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface StubField {
    name: string;
    type: string;
    label?: string;
    helpText?: string;
    relationshipName?: string;
    referenceTo?: string[];
}
export interface StubDescribe {
    name?: string;
    label?: string;
    fields: StubField[];
    childRelationships: { name: string; childSObject: string }[];
}

export interface StubInfo {
    uri: string;
    classLine: number;
    /** lower-cased field/relationship name → 0-based line in the stub. */
    fieldLines: Map<string, number>;
}

let rootDir: string | null = null;
// Stub line maps for go-to-definition, LRU-capped (an org has thousands of objects;
// only the recently navigated ones are worth keeping).
const cache = new Map<string, StubInfo>();
const MAX_STUB_CACHE = 200;
// Concurrent lookups of the same object share one read/write. Cleared on settle.
const inFlight = new Map<string, Promise<StubInfo | null>>();
// Bumped by clearStubs/setStubRoot so an in-flight load can't resurrect a cleared entry.
let cacheGeneration = 0;

const KEY_SEP = '\u0000';
/** Cache key: stubs are per project root, so the same object in two projects is two entries. */
const cacheKey = (root: string, sobject: string): string => `${root}${KEY_SEP}${sobject}`;

function remember(key: string, info: StubInfo): void {
    cache.delete(key);
    cache.set(key, info);
    while (cache.size > MAX_STUB_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}
/** Stub-name sets per stub root (one per project). */
const stubbedNamesByRoot = new Map<string, Set<string>>();

/**
 * Lower-cased names of every SObject we've generated a stub for (from the stub
 * directory's filenames). A reliable, cache-only signal of "this name is a real org
 * SObject" for schema validation — no describe/API call. Cached; call
 * invalidateStubbedNames() after a sync. Empty when stub generation is disabled.
 */
export function stubbedObjectNames(docUri?: string): Set<string> {
    const root = stubRootFor(docUri);
    const cached = stubbedNamesByRoot.get(root);
    if (cached) return cached;
    const set = new Set<string>();
    const base = path.join(root, '.sfdx', 'tools', 'sobjects');
    for (const sub of ['standardObjects', 'customObjects']) {
        try {
            for (const f of fs.readdirSync(path.join(base, sub))) {
                if (f.endsWith('.cls')) set.add(f.slice(0, -4).toLowerCase());
            }
        } catch {
            /* directory may not exist yet */
        }
    }
    stubbedNamesByRoot.set(root, set);
    return set;
}

export function invalidateStubbedNames(): void {
    stubbedNamesByRoot.clear();
}

/**
 * The project directory whose `.sfdx/tools/sobjects` serves a document: its project from
 * the host's map (else the nearest SFDX / MDAPI project root), falling back to the single
 * root set by `setStubRoot`, else the temp dir. Stubs are per project — the host writes
 * them per project dir.
 */
export function stubRootFor(docUri?: string): string {
    if (docUri && projectDirResolver) {
        const dir = projectDirResolver(docUri);
        if (dir) return dir;
    }
    return rootDir ?? os.tmpdir();
}

let projectDirResolver: ((docUri: string) => string | undefined) | undefined;
/** Wire the document → project directory lookup (the server passes its project map). */
export function setProjectDirResolver(fn: ((docUri: string) => string | undefined) | undefined): void {
    projectDirResolver = fn;
}

export function setStubRoot(dir: string | null): void {
    rootDir = dir;
    stubbedNamesByRoot.clear();
    cache.clear(); // locations belong to the previous root
    inFlight.clear();
    cacheGeneration++;
    // Remove the legacy custom stub dir from earlier versions (now unified into
    // .sfdx/tools/sobjects so the Salesforce LS and AI read the same files).
    if (dir) {
        try {
            fs.rmSync(path.join(dir, '.sfdx', 'tools', 'sfx-sobjects'), { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
}
/** Drop cached stub locations — all of them, or just the given objects (targeted push/pull). */
export function clearStubs(objects?: string[]): void {
    // Any clear invalidates in-flight loads (they could carry pre-clear content).
    cacheGeneration++;
    if (!objects) { cache.clear(); inFlight.clear(); return; }
    const lower = new Set(objects.map((o) => o.toLowerCase()));
    const objectOf = (k: string) => k.slice(k.indexOf(KEY_SEP) + 1).toLowerCase();
    for (const k of [...cache.keys()]) if (lower.has(objectOf(k))) cache.delete(k);
    for (const k of [...inFlight.keys()]) if (lower.has(objectOf(k))) inFlight.delete(k);
}

function isCustomObject(name: string): boolean {
    return /__(c|mdt|e|b|x|share|history|feed|changeevent|tag)$/i.test(name) || name.includes('__');
}

function apexType(t: string, f: StubField): string {
    switch (t) {
        case 'id':
        case 'reference':
            return 'Id';
        case 'boolean':
            return 'Boolean';
        case 'int':
            return 'Integer';
        case 'double':
        case 'currency':
        case 'percent':
            return 'Decimal';
        case 'date':
            return 'Date';
        case 'datetime':
            return 'Datetime';
        case 'time':
            return 'Time';
        case 'base64':
            return 'Blob';
        case 'address':
            return 'Address';
        case 'location':
            return 'Location';
        default:
            return 'String';
    }
}

function stubFilePath(sobject: string, root: string): string {
    const base = path.join(root, '.sfdx', 'tools', 'sobjects');
    const sub = isCustomObject(sobject) ? 'customObjects' : 'standardObjects';
    return path.join(base, sub, `${sobject}.cls`);
}

// Parse line numbers from an existing stub (sync- or Salesforce-generated).
function parseStub(content: string): { classLine: number; fieldLines: Map<string, number> } {
    const lines = content.split('\n');
    const fieldLines = new Map<string, number>();
    let classLine = 0;
    for (let i = 0; i < lines.length; i++) {
        if (classLine === 0 && /\bclass\s+\w+/i.test(lines[i])) classLine = i;
        const m = /\bglobal\s+[\w.<>]+\s+(\w+)\s*;/.exec(lines[i]);
        if (m) fieldLines.set(m[1].toLowerCase(), i);
    }
    return { classLine, fieldLines };
}

function generate(sobject: string, d: StubDescribe): { content: string; classLine: number; fieldLines: Map<string, number> } {
    const lines: string[] = [];
    const fieldLines = new Map<string, number>();
    lines.push('// Auto-generated read-only schema stub (ASFX Toolkit).');
    lines.push(`// ${d.label ?? sobject}`);
    const classLine = lines.length;
    lines.push(`global class ${sobject} {`);
    for (const f of d.fields) {
        const labelComment = f.label && f.label !== f.name ? `  // ${f.label}` : '';
        fieldLines.set(f.name.toLowerCase(), lines.length);
        lines.push(`    global ${apexType(f.type, f)} ${f.name};${labelComment}`);
        if (f.relationshipName && f.referenceTo && f.referenceTo[0]) {
            fieldLines.set(f.relationshipName.toLowerCase(), lines.length);
            lines.push(`    global ${f.referenceTo[0]} ${f.relationshipName};`);
        }
    }
    if (d.childRelationships && d.childRelationships.length) {
        lines.push('');
        lines.push('    // Child relationships (subquery targets)');
        for (const cr of d.childRelationships) {
            fieldLines.set(cr.name.toLowerCase(), lines.length);
            lines.push(`    global List<${cr.childSObject}> ${cr.name};`);
        }
    }
    lines.push('}');
    return { content: lines.join('\n') + '\n', classLine, fieldLines };
}

/**
 * Resolve (reading or generating) the stub for `sobject`. Async so a missing stub is
 * never written on the server's main thread synchronously; concurrent lookups for the
 * same object share one in-flight promise (one read/write).
 */
export function getStub(sobject: string, d: StubDescribe, docUri?: string): Promise<StubInfo | null> {
    const root = stubRootFor(docUri);
    const key = cacheKey(root, sobject);
    const cached = cache.get(key);
    if (cached) {
        remember(key, cached); // refresh LRU position
        return Promise.resolve(cached);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const p = loadStub(sobject, d, root, key).finally(() => {
        if (inFlight.get(key) === p) inFlight.delete(key);
    });
    inFlight.set(key, p);
    return p;
}

async function loadStub(sobject: string, d: StubDescribe, root: string, key: string): Promise<StubInfo | null> {
    const gen0 = cacheGeneration;
    // A clearStubs()/setStubRoot() that lands while we await must not be undone by
    // re-adding this (possibly stale) entry to the cache.
    const store = (info: StubInfo): void => {
        if (gen0 === cacheGeneration) remember(key, info);
    };
    const file = stubFilePath(sobject, root);

    // Prefer the existing file (background sync / Salesforce) so navigation matches
    // what's on disk; read its line numbers directly.
    try {
        const existing = await fs.promises.readFile(file, 'utf8');
        const parsed = parseStub(existing);
        const info: StubInfo = { uri: pathToFileURL(file).href, classLine: parsed.classLine, fieldLines: parsed.fieldLines };
        store(info);
        return info;
    } catch {
        /* not generated yet — create it below */
    }

    const gen = generate(sobject, d);
    try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, gen.content, 'utf8');
    } catch {
        return null;
    }
    const info: StubInfo = { uri: pathToFileURL(file).href, classLine: gen.classLine, fieldLines: gen.fieldLines };
    store(info);
    return info;
}
