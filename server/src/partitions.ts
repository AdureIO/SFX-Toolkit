/**
 * Project partitions of the symbol index. One server serves every project in the window;
 * its type / token / metadata index is partitioned by the project's DEFAULT ORG:
 *
 *  - projects with the same default org share one partition (`org:<username>`),
 *  - a project without a resolvable default org is its own partition (`dir:<projectDir>`),
 *  - files outside any project are partition `none`.
 *
 * The host sends the project map (`asfx/projects`, see protocol.ts). A file's partition is
 * the one of the DEEPEST project containing it: walking up from its directory, the first
 * directory that is a mapped project wins; a directory that is an SFDX / MDAPI project root
 * on disk but unknown to the map is its own `dir:` partition. Results are cached per
 * directory (LRU) and dropped whenever the map changes.
 *
 * Every index query takes the requesting document's partition; `undefined` means "no
 * filtering" (used only where there is no requesting document).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { lruGet, lruSet } from './caches';
import type { ProjectEntry, ProjectMapParams } from './protocol';

export const NO_PARTITION = 'none';
const MAX_DIR_CACHE = 2000;

interface Resolved {
    /** The project root the file belongs to (undefined = outside any project). */
    dir?: string;
    partition: string;
}

const norm = (p: string): string => {
    const r = path.resolve(p);
    return r.length > 1 && r.endsWith(path.sep) ? r.slice(0, -1) : r;
};

class PartitionsImpl {
    private byDir = new Map<string, ProjectEntry>();
    private buffers = new Map<string, string>();
    private active: string | undefined;
    private dirCache = new Map<string, Resolved>();
    private listeners: (() => void)[] = [];
    private signature = '';

    /** Be told when the map changed (partitions of cached files may differ now). */
    onChange(fn: () => void): void {
        this.listeners.push(fn);
    }

    /** Apply the host's project map. Returns true when anything changed. */
    set(params: ProjectMapParams | undefined): boolean {
        const projects = (params?.projects ?? []).filter((p) => p && typeof p.dir === 'string' && typeof p.partition === 'string');
        const buffers = params?.buffers ?? {};
        const active = typeof params?.activeDir === 'string' && params.activeDir ? norm(params.activeDir) : undefined;
        const signature = JSON.stringify([projects.map((p) => [norm(p.dir), p.partition, p.namespace ?? null, p.name ?? null]), buffers, active ?? null]);
        if (signature === this.signature) return false;
        this.signature = signature;
        this.byDir = new Map(projects.map((p) => [norm(p.dir), { ...p, dir: norm(p.dir) }]));
        this.buffers = new Map(Object.entries(buffers));
        this.active = active;
        this.dirCache.clear();
        for (const fn of this.listeners) {
            try {
                fn();
            } catch {
                /* a listener failure must not break the update */
            }
        }
        return true;
    }

    /** Drop everything (shutdown / tests). */
    clear(): void {
        this.byDir.clear();
        this.buffers.clear();
        this.dirCache.clear();
        this.active = undefined;
        this.signature = '';
    }

    private resolveDir(dir: string): Resolved {
        const raw = lruGet(this.dirCache, dir);
        if (raw) return raw;
        const start = norm(dir);
        const hit = lruGet(this.dirCache, start);
        if (hit) return hit;
        let res: Resolved = { partition: NO_PARTITION };
        let d = start;
        for (let i = 0; i < 100; i++) {
            const entry = this.byDir.get(d);
            if (entry) {
                res = { dir: d, partition: entry.partition };
                break;
            }
            let marker = false;
            try {
                marker = fs.existsSync(path.join(d, 'sfdx-project.json')) || fs.existsSync(path.join(d, 'src', 'package.xml'));
            } catch {
                /* unreadable → not a project root */
            }
            if (marker) {
                res = { dir: d, partition: `dir:${d}` };
                break;
            }
            const parent = path.dirname(d);
            if (parent === d) break;
            d = parent;
        }
        lruSet(this.dirCache, start, res, MAX_DIR_CACHE);
        if (dir !== start) lruSet(this.dirCache, dir, res, MAX_DIR_CACHE);
        return res;
    }

    private resolvePath(file: string): Resolved {
        return this.resolveDir(path.dirname(file));
    }

    /** Partition of a file-system path. */
    partitionOfPath(file: string): string {
        return this.resolvePath(file).partition;
    }

    /** Partition of a document URI (host-pinned buffers first, then the path it names). */
    partitionOfUri(uri: string): string {
        const pinned = this.buffers.get(uri);
        if (pinned) return pinned;
        const file = fsPathOfUri(uri);
        return file ? this.partitionOfPath(file) : NO_PARTITION;
    }

    /** The project root a path belongs to, from the map or the nearest project marker on disk. */
    projectDirOf(file: string): string | undefined {
        return this.resolvePath(file).dir;
    }

    /** The mapped project entry (name, namespace) a path belongs to, if the host sent one. */
    projectOfPath(file: string): ProjectEntry | undefined {
        const dir = this.resolvePath(file).dir;
        return dir ? this.byDir.get(dir) : undefined;
    }

    /** Project root of a document URI (see `projectDirOf`); a pinned buffer has none. */
    projectDirOfUri(uri: string): string | undefined {
        if (this.buffers.has(uri)) return this.active && this.byDir.has(this.active) ? this.active : undefined;
        const file = fsPathOfUri(uri);
        return file ? this.projectDirOf(file) : undefined;
    }

    /**
     * Namespace of the project a document belongs to when the host's map says so;
     * `undefined` when the map has no answer (the caller then asks the host).
     */
    namespaceOfUri(uri: string): string | null | undefined {
        if (this.buffers.has(uri)) return undefined;
        const file = fsPathOfUri(uri);
        const e = file ? this.projectOfPath(file) : undefined;
        return e && e.namespace !== undefined ? e.namespace : undefined;
    }

    /** Partition of the active project (workspace symbols have no requesting document). */
    activePartition(): string | undefined {
        if (!this.active) return undefined;
        const e = this.byDir.get(this.active);
        return e ? e.partition : this.resolveDir(this.active).partition;
    }

    /** Number of distinct partitions among the mapped projects. */
    get partitionCount(): number {
        return new Set([...this.byDir.values()].map((p) => p.partition)).size;
    }

    /** Display name of the project a file belongs to (workspace-symbol container). */
    projectNameOf(file: string): string | undefined {
        const e = this.projectOfPath(file);
        return e?.name ?? (e ? path.basename(e.dir) : undefined);
    }
}

/** fs path of a document URI of any scheme (virtual `asfx-buffer:` docs keep the buffer's path). */
export function fsPathOfUri(uri: string): string | undefined {
    try {
        if (uri.startsWith('file:')) return fileURLToPath(uri);
        const m = /^[a-z][\w+.-]*:\/\/[^/]*(\/[^?#]*)/i.exec(uri) ?? /^[a-z][\w+.-]*:(\/[^?#]*)/i.exec(uri);
        return m ? decodeURIComponent(m[1]) : undefined;
    } catch {
        return undefined;
    }
}

export const Partitions = new PartitionsImpl();
export type { ProjectEntry, ProjectMapParams };
