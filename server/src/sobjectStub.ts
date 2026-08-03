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
const cache = new Map<string, StubInfo>();
let stubbedNames: Set<string> | null = null;

/**
 * Lower-cased names of every SObject we've generated a stub for (from the stub
 * directory's filenames). A reliable, cache-only signal of "this name is a real org
 * SObject" for schema validation — no describe/API call. Cached; call
 * invalidateStubbedNames() after a sync. Empty when stub generation is disabled.
 */
export function stubbedObjectNames(): Set<string> {
    if (stubbedNames) return stubbedNames;
    const set = new Set<string>();
    const base = path.join(rootDir ?? os.tmpdir(), '.sfdx', 'tools', 'sobjects');
    for (const sub of ['standardObjects', 'customObjects']) {
        try {
            for (const f of fs.readdirSync(path.join(base, sub))) {
                if (f.endsWith('.cls')) set.add(f.slice(0, -4).toLowerCase());
            }
        } catch {
            /* directory may not exist yet */
        }
    }
    stubbedNames = set;
    return set;
}

export function invalidateStubbedNames(): void {
    stubbedNames = null;
}

export function setStubRoot(dir: string | null): void {
    rootDir = dir;
    stubbedNames = null;
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
export function clearStubs(): void {
    cache.clear();
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

function stubFilePath(sobject: string): string {
    const base = path.join(rootDir ?? os.tmpdir(), '.sfdx', 'tools', 'sobjects');
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

export function getStub(sobject: string, d: StubDescribe): StubInfo | null {
    const cached = cache.get(sobject);
    if (cached) return cached;

    const file = stubFilePath(sobject);

    // Prefer the existing file (background sync / Salesforce) so navigation matches
    // what's on disk; read its line numbers directly.
    try {
        const existing = fs.readFileSync(file, 'utf8');
        const parsed = parseStub(existing);
        const info: StubInfo = { uri: pathToFileURL(file).href, classLine: parsed.classLine, fieldLines: parsed.fieldLines };
        cache.set(sobject, info);
        return info;
    } catch {
        /* not generated yet — create it below */
    }

    const gen = generate(sobject, d);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, gen.content, 'utf8');
    } catch {
        return null;
    }
    const info: StubInfo = { uri: pathToFileURL(file).href, classLine: gen.classLine, fieldLines: gen.fieldLines };
    cache.set(sobject, info);
    return info;
}
