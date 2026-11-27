/**
 * The one on-disk cache format of the toolkit's caches under `globalStorage/org-browser`: gzip-compressed JSON,
 * written through a temp file + rename (a reader never sees a half-written file). Used by the org listing cache
 * (`metadataLister`), the local project scan cache (`projectScanCache`) and the content compare index.
 * Pure Node (no `vscode`).
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/** Write `data` as gzip JSON to `file` (parent directory created, atomic replace). */
export async function writeGzipJson(file: string, data: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	const gz = await new Promise<Buffer>((resolve, reject) => zlib.gzip(Buffer.from(JSON.stringify(data), "utf8"), (e, b) => (e ? reject(e) : resolve(b))));
	await fs.promises.writeFile(tmp, gz);
	await fs.promises.rename(tmp, file);
}

/** Read a file written by `writeGzipJson`; undefined when missing, unreadable or not gzip JSON. */
export async function readGzipJson<T = unknown>(file: string): Promise<T | undefined> {
	try {
		const gz = await fs.promises.readFile(file);
		const json = await new Promise<Buffer>((resolve, reject) => zlib.gunzip(gz, (e, b) => (e ? reject(e) : resolve(b))));
		return JSON.parse(json.toString("utf8")) as T;
	} catch {
		return undefined;
	}
}

/** `<name>` made safe as one file name stem (no separators or characters Windows rejects). */
export function safeFileStem(name: string): string {
	return name.replace(/[^A-Za-z0-9._@-]/g, "_");
}
