/**
 * Unsaved text of open LWC / Aura / Visualforce / Flow files, pushed by the host with the
 * custom `sfx/metadataBuffer` notification (these languages are deliberately NOT in the
 * client's documentSelector, which would trigger every server feature on them).
 *
 * The metadata reference scanners and the token index prefer this overlay over disk.
 * Bounded: at most MAX_OVERLAY_ENTRIES files (oldest evicted) of at most MAX_OVERLAY_BYTES
 * each (a bigger buffer is not kept — disk is used). `text: null` drops the entry
 * ("use disk again").
 */
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { metadataKindOf } from '../../src/utils/sfMetadataRefs';
import { WorkspaceIndex, isIgnoredPath } from './workspaceIndex';

export const MAX_OVERLAY_ENTRIES = 200;
export const MAX_OVERLAY_BYTES = 2 * 1024 * 1024;

class MetadataOverlayImpl {
    private map = new Map<string, string>();

    /** Overlay text for an fs path, if any. */
    get(file: string): string | undefined {
        return this.map.get(file);
    }

    get size(): number {
        return this.map.size;
    }

    /** Read a metadata file: the unsaved buffer when present, else disk (undefined = unreadable). */
    async read(file: string): Promise<string | undefined> {
        const o = this.map.get(file);
        if (o !== undefined) return o;
        try {
            return await fs.promises.readFile(file, 'utf8');
        } catch {
            return undefined;
        }
    }

    /** Apply a host notification. Ignores non-file / non-metadata / generated paths. */
    set(uri: string, text: string | null | undefined): void {
        if (!uri.startsWith('file:')) return;
        let file: string;
        try {
            file = fileURLToPath(uri);
        } catch {
            return;
        }
        if (!metadataKindOf(file) || isIgnoredPath(file)) return;
        const evicted: string[] = [];
        if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_OVERLAY_BYTES) {
            if (!this.map.delete(file)) return;
        } else {
            if (this.map.get(file) === text) return;
            this.map.delete(file); // re-insert: iteration order = recency
            this.map.set(file, text);
            while (this.map.size > MAX_OVERLAY_ENTRIES) {
                const oldest = this.map.keys().next().value as string;
                this.map.delete(oldest);
                evicted.push(oldest);
            }
        }
        this.changed(file);
        for (const f of evicted) this.changed(f);
    }

    /** Drop everything without notifying (server release). */
    clear(): void {
        this.map.clear();
    }

    /** Make the token index re-read the file (overlay or disk, whichever applies now). */
    private changed(file: string): void {
        const exists = this.map.has(file) || fs.existsSync(file);
        WorkspaceIndex.applyFileChange(pathToFileURL(file).href, exists ? 'changed' : 'deleted');
    }
}

export const MetadataOverlay = new MetadataOverlayImpl();
