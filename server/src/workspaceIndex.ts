/**
 * Cross-file Apex type lookup for go-to-definition. Apex requires a top-level
 * class/interface/enum to live in a file named `<TypeName>.cls` (or `.trigger`),
 * so we resolve a type to its file **by filename** — a cheap directory walk that
 * records basename→path, with NO parsing. Only the single target file is parsed
 * (lazily, cached) to find the declaration's exact line. This avoids parsing the
 * whole workspace, which was the main memory/CPU cost.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { Location, Range, SymbolKind, DocumentSymbol } from 'vscode-languageserver/node';
import { parseApex, ApexMember } from './apexSymbols';

const IGNORE_DIRS = new Set(['node_modules', '.git', '.sfdx', '.vscode', 'out', 'dist']);
const MAX_FILES = 20000; // basename→path entries are tiny; cap only as a backstop

class WorkspaceIndexImpl {
    private roots: string[] = [];
    private files = new Map<string, string>(); // lower-cased type name → file path
    private names = new Map<string, string>(); // lower-cased → original-cased type name
    private memberCache = new Map<string, { mtime: number; members: ApexMember[] | undefined }>();
    private scanned = false;

    setRoots(roots: string[]): void {
        this.roots = roots;
        this.files.clear();
        this.names.clear();
        this.memberCache.clear();
        this.scanned = false;
    }

    /** Record an open document's type→path mapping (no parse). */
    updateFromDoc(uri: string, _text: string): void {
        try {
            const file = fileURLToPath(uri);
            const base = path.basename(file).replace(/\.(cls|trigger)$/i, '');
            this.files.set(base.toLowerCase(), file);
            this.names.set(base.toLowerCase(), base);
        } catch {
            /* ignore */
        }
    }

    /** All known top-level Apex type (class/trigger) names, original-cased. */
    /** Every indexed Apex file path — used for workspace-wide reference search. */
    allFiles(): string[] {
        if (!this.scanned) this.scan();
        return [...new Set(this.files.values())];
    }

    allTypeNames(): string[] {
        if (!this.scanned) this.scan();
        return [...this.names.values()];
    }

    /** Cheap check (filename scan only, no parse) whether a name is a workspace Apex type. */
    hasType(name: string): boolean {
        if (!this.scanned) this.scan();
        return this.files.has(name.toLowerCase());
    }

    /**
     * Members (methods/fields/properties) of a workspace type, for cross-file
     * member completion (`MyClass.` or `instanceOfMyClass.`). Parses only the one
     * file, cached by path+mtime so repeated completions don't re-parse.
     */
    findTypeMembers(name: string): ApexMember[] | undefined {
        if (!this.scanned) this.scan();
        const file = this.files.get(name.toLowerCase());
        if (!file) return undefined;
        try {
            const mtime = fs.statSync(file).mtimeMs;
            const cached = this.memberCache.get(file);
            if (cached && cached.mtime === mtime) return cached.members;
            const index = parseApex(fs.readFileSync(file, 'utf8')).index;
            // Match the top-level type by name (case-insensitive).
            let members: ApexMember[] | undefined;
            for (const [typeName, ms] of index.types) {
                if (typeName.toLowerCase() === name.toLowerCase()) {
                    members = ms;
                    break;
                }
            }
            this.memberCache.set(file, { mtime, members });
            return members;
        } catch {
            return undefined;
        }
    }

    findType(name: string): Location | undefined {
        if (!this.scanned) this.scan();
        const file = this.files.get(name.toLowerCase());
        if (!file) return undefined;

        // Parse only this one file (on demand, not cached) to land on the
        // declaration's name range — cheap and always reflects the current file.
        let range = Range.create(0, 0, 0, 0);
        try {
            const found = findTypeRange(parseApex(fs.readFileSync(file, 'utf8')).symbols, name);
            if (found) range = found;
        } catch {
            /* fall back to file start */
        }
        return { uri: pathToFileURL(file).href, range };
    }

    private scan(): void {
        this.scanned = true;
        let count = 0;
        const walk = (dir: string): void => {
            if (count >= MAX_FILES) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (count >= MAX_FILES) return;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (!IGNORE_DIRS.has(e.name)) walk(full);
                } else {
                    const m = /^(.*)\.(cls|trigger)$/i.exec(e.name);
                    if (m) {
                        this.files.set(m[1].toLowerCase(), full);
                        this.names.set(m[1].toLowerCase(), m[1]);
                        count++;
                    }
                }
            }
        };
        for (const root of this.roots) {
            try {
                walk(fileURLToPath(root.startsWith('file:') ? root : pathToFileURL(root).href));
            } catch {
                /* ignore bad root */
            }
        }
    }
}

function findTypeRange(syms: DocumentSymbol[], name: string): Range | undefined {
    for (const s of syms) {
        if (
            (s.kind === SymbolKind.Class || s.kind === SymbolKind.Interface || s.kind === SymbolKind.Enum) &&
            s.name.toLowerCase() === name.toLowerCase()
        ) {
            return s.selectionRange;
        }
        if (s.children) {
            const inner = findTypeRange(s.children, name);
            if (inner) return inner;
        }
    }
    return undefined;
}

export const WorkspaceIndex = new WorkspaceIndexImpl();
