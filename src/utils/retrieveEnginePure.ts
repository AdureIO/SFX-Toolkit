/**
 * Pure parts of the retrieve engine (no `vscode`): command-line chunking and parsing of
 * `sf project retrieve start --json` output.
 */

export interface ComponentRef {
	type: string;
	fullName: string;
}

export interface RetrievedComponent extends ComponentRef {
	filePath: string;
}

export interface FailedComponent extends ComponentRef {
	error: string;
}

export interface RetrieveOutcome {
	retrieved: RetrievedComponent[];
	failed: FailedComponent[];
}

/** Default budget for the variable part of one `sf` command line. */
export const MAX_COMMAND_CHARS = process.platform === "win32" ? 7000 : 30000;

/** Split `components` so each chunk's `-m "Type:Name"` arguments stay below `maxChars`. */
export function chunkComponents(components: ComponentRef[], maxChars: number = MAX_COMMAND_CHARS): ComponentRef[][] {
	const chunks: ComponentRef[][] = [];
	let cur: ComponentRef[] = [];
	let len = 0;
	for (const c of components) {
		// "-m" + space + quotes + "Type:Name" + space
		const cost = c.type.length + c.fullName.length + 8;
		if (cur.length > 0 && len + cost > maxChars) {
			chunks.push(cur);
			cur = [];
			len = 0;
		}
		cur.push(c);
		len += cost;
	}
	if (cur.length > 0) chunks.push(cur);
	return chunks;
}

/** Same budgeting for `-d <path>` arguments. */
export function chunkPaths(paths: string[], maxChars: number = MAX_COMMAND_CHARS): string[][] {
	const chunks: string[][] = [];
	let cur: string[] = [];
	let len = 0;
	for (const p of paths) {
		const cost = p.length + 6;
		if (cur.length > 0 && len + cost > maxChars) {
			chunks.push(cur);
			cur = [];
			len = 0;
		}
		cur.push(p);
		len += cost;
	}
	if (cur.length > 0) chunks.push(cur);
	return chunks;
}

export interface CliFile {
	fullName?: string;
	type?: string;
	state?: string;
	filePath?: string;
	error?: string;
	problemType?: string;
}

/** Parse the JSON object out of CLI stdout (a login shell may print noise before/after it). */
export function parseCliJson(stdout: string): any | null {
	if (!stdout) return null;
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** A human message for a failed CLI run (JSON `message`, else the raw text). */
export function cliErrorMessage(parsed: any | null, fallback: string): string {
	const msg = parsed?.message ?? parsed?.result?.message ?? parsed?.data?.message;
	return typeof msg === "string" && msg.trim() ? msg.trim() : fallback.trim() || "Retrieve failed";
}

const isMetaXml = (p: string) => /-meta\.xml$/i.test(p);

/**
 * Turn the `files` of one retrieve result into retrieved/failed components.
 * `requested` (when given) are components the run was asked for: ones the org did not return at all
 * are reported as failed ("not returned by the org") so no row is left without an outcome.
 */
export function outcomeFromFiles(files: CliFile[], requested?: ComponentRef[]): RetrieveOutcome {
	const ok = new Map<string, RetrievedComponent>();
	const bad = new Map<string, FailedComponent>();
	for (const f of files) {
		if (!f || !f.type || !f.fullName) continue;
		const key = `${f.type}:${f.fullName}`;
		const failedState = f.state === "Failed" || f.state === "Conflict" || (!!f.error && f.state !== "Changed" && f.state !== "Created");
		if (failedState) {
			if (!bad.has(key)) {
				bad.set(key, { type: f.type, fullName: f.fullName, error: (f.error || f.problemType || f.state || "Failed").toString().trim() });
			}
			continue;
		}
		const prev = ok.get(key);
		const fp = f.filePath ?? "";
		// Prefer the content file over its -meta.xml companion as the representative path.
		if (!prev || (isMetaXml(prev.filePath) && fp && !isMetaXml(fp))) {
			ok.set(key, { type: f.type, fullName: f.fullName, filePath: fp });
		}
	}
	// A component with one failed file is failed overall.
	for (const k of bad.keys()) ok.delete(k);
	if (requested) {
		for (const r of requested) {
			const key = `${r.type}:${r.fullName}`;
			if (ok.has(key) || bad.has(key)) continue;
			// Wildcard requests (Type:*) legitimately return many components.
			if (r.fullName.includes("*")) continue;
			bad.set(key, { type: r.type, fullName: r.fullName, error: "Not returned by the org (it may not exist, or it is not retrievable)." });
		}
	}
	return { retrieved: [...ok.values()], failed: [...bad.values()] };
}

/** Parse a whole `sf project retrieve start --json` stdout; null when it carries no result. */
export function parseRetrieveJson(stdout: string, requested?: ComponentRef[]): RetrieveOutcome | null {
	const parsed = parseCliJson(stdout);
	if (!parsed) return null;
	const files = parsed?.result?.files ?? parsed?.result?.inboundFiles ?? parsed?.data?.files;
	if (!Array.isArray(files)) return null;
	return outcomeFromFiles(files as CliFile[], requested);
}
