/**
 * "Create field stub" planning: where a new `<Field>.field-meta.xml` belongs in the
 * SFDX project (the existing `objects/<Object>` folder if the object is in source,
 * else the default package directory's `main/default/objects`), plus its default
 * metadata (Text(255), label derived from the API name). Pure fs reads, no writes —
 * the file is created by the client (WorkspaceEdit) or the host command.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface FieldStubPlan {
    /** Absolute path of the new field-meta.xml. */
    filePath: string;
    content: string;
    /** Object / field API names as written into the source tree (own namespace stripped). */
    object: string;
    field: string;
}

const SKIP_DIRS = new Set(['node_modules', '.sfdx', '.sf', '.git', '.vscode', '.husky', 'out', 'dist']);
const MAX_VISITED_DIRS = 5000;

/** Nearest ancestor directory of `fromDir` containing sfdx-project.json. */
export function findProjectDir(fromDir: string): string | undefined {
    let d = fromDir;
    for (let i = 0; i < 100; i++) {
        if (fs.existsSync(path.join(d, 'sfdx-project.json'))) return d;
        const parent = path.dirname(d);
        if (parent === d) return undefined;
        d = parent;
    }
    return undefined;
}

/** Package directories (absolute), default first. */
export function packageDirs(projectDir: string): string[] {
    try {
        const json = JSON.parse(fs.readFileSync(path.join(projectDir, 'sfdx-project.json'), 'utf8'));
        const dirs: { path?: string; default?: boolean }[] = Array.isArray(json?.packageDirectories) ? json.packageDirectories : [];
        const sorted = [...dirs.filter((d) => d?.default), ...dirs.filter((d) => !d?.default)];
        return sorted.filter((d) => typeof d?.path === 'string').map((d) => path.resolve(projectDir, d.path as string));
    } catch {
        return [];
    }
}

/** Breadth-first search under `root` for a directory matching `pred` (bounded, skips generated dirs). */
function findDir(root: string, pred: (dir: string, name: string) => boolean): string | undefined {
    const queue = [root];
    let visited = 0;
    while (queue.length && visited++ < MAX_VISITED_DIRS) {
        const dir = queue.shift()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (pred(full, e.name)) return full;
            queue.push(full);
        }
    }
    return undefined;
}

/** `Total_Amount__c` → `Total Amount`; `NetPrice__c` → `Net Price`. */
export function labelFromApiName(api: string): string {
    const core = api.replace(/__c$/i, '');
    return core
        .replace(/_+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
}

function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fieldMetaXml(field: string, label: string): string {
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        `    <fullName>${xmlEscape(field)}</fullName>\n` +
        '    <externalId>false</externalId>\n' +
        `    <label>${xmlEscape(label)}</label>\n` +
        '    <length>255</length>\n' +
        '    <required>false</required>\n' +
        '    <trackTrending>false</trackTrending>\n' +
        '    <type>Text</type>\n' +
        '    <unique>false</unique>\n' +
        '</CustomField>\n'
    );
}

/** Strip the project's own namespace (`acme__X__c` → `X__c`); undefined for a foreign namespace. */
function ownName(api: string, ns: string | null): string | undefined {
    const parts = api.split('__');
    if (parts.length < 3) return api;
    if (ns && parts[0].toLowerCase() === ns.toLowerCase()) return parts.slice(1).join('__');
    return undefined;
}

/**
 * Plan the field stub for `object.field`, given the document's file path. Undefined
 * when not applicable: not a custom field (`__c`), a foreign-namespace field, no SFDX
 * project / package directory, or the field file already exists.
 */
export function planFieldStub(docPath: string, object: string, field: string, namespace: string | null): FieldStubPlan | undefined {
    if (!/^[A-Za-z]\w*__c$/i.test(field)) return undefined;
    const f = ownName(field, namespace);
    if (!f) return undefined;
    // An object from another package keeps its namespace in the folder name.
    const o = ownName(object, namespace) ?? object;
    const projectDir = findProjectDir(path.dirname(docPath));
    if (!projectDir) return undefined;
    const pkgs = packageDirs(projectDir).filter((p) => fs.existsSync(p));
    if (!pkgs.length) return undefined;

    let objectDir: string | undefined;
    for (const pkg of pkgs) {
        objectDir = findDir(pkg, (dir, name) => name.toLowerCase() === o.toLowerCase() && path.basename(path.dirname(dir)) === 'objects');
        if (objectDir) break;
    }
    if (!objectDir) {
        const pkg = pkgs[0];
        const mainDefault = path.join(pkg, 'main', 'default');
        const objectsDir = fs.existsSync(mainDefault)
            ? path.join(mainDefault, 'objects')
            : findDir(pkg, (_dir, name) => name === 'objects') ?? path.join(mainDefault, 'objects');
        objectDir = path.join(objectsDir, o);
    }
    const filePath = path.join(objectDir, 'fields', `${f}.field-meta.xml`);
    if (fs.existsSync(filePath)) return undefined;
    return { filePath, content: fieldMetaXml(f, labelFromApiName(f)), object: path.basename(objectDir), field: f };
}
