/**
 * History of the commands that shell out to `sf` themselves (push, pull, validate Apex): turning their paths,
 * file lists and CLI output into the History entry's components and errors. Pure (no `vscode`, no I/O).
 */
import * as path from "path";
import type { HistoryError } from "./historyPure";
import { MAX_ERRORS } from "./historyPure";
import { TypeTable, mapSourceFile } from "./orgBrowser/localIndex";

/** `Type:fullName` keys of a component list (`type` or `componentType` + `fullName`), without duplicates. */
export function componentKeysFromList(list: readonly { type?: string; componentType?: string; fullName?: string }[] | undefined): string[] {
	const keys = new Set<string>();
	for (const c of list ?? []) {
		const type = c?.type || c?.componentType;
		if (type && c.fullName) keys.add(`${type}:${c.fullName}`);
	}
	return [...keys];
}

/** `Type:fullName` keys of source files (absolute or project-relative), mapped through the type table; unmapped files are skipped. */
export function componentKeysFromPaths(projectDir: string, files: readonly string[], table: TypeTable): string[] {
	const keys = new Set<string>();
	for (const f of files) {
		const rel = (path.isAbsolute(f) ? path.relative(projectDir, f) : f).split(path.sep).join("/").replace(/\\/g, "/");
		if (!rel || rel.startsWith("..")) continue;
		const m = mapSourceFile(rel, table);
		if (m) keys.add(`${m.type}:${m.name}`);
	}
	return [...keys];
}

/** The text of a CLI failure as the entry's error list: the JSON `message` when the text carries one, else the cleaned text. */
export function historyErrorsFromCliText(text: string | undefined): HistoryError[] {
	const raw = (text ?? "").replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
	if (!raw.trim()) return [];
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const j = JSON.parse(raw.slice(start, end + 1)) as { message?: unknown };
			if (typeof j?.message === "string" && j.message.trim()) return [{ message: j.message.replace(/\s+/g, " ").trim() }];
		} catch {
			/* not JSON: use the text */
		}
	}
	return [{ message: raw.replace(/\s+/g, " ").trim() }];
}

export interface RetrieveHistoryInfo {
	components: string[];
	errors: HistoryError[];
}

/**
 * Components and per-file errors of `sf project retrieve start --json` output (success, or the failure JSON that
 * still carries `result.files`). null when the text has no readable result.
 */
export function parseRetrieveHistory(stdout: string): RetrieveHistoryInfo | null {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(stdout.slice(start, end + 1));
		const files = parsed?.result?.files ?? parsed?.result?.inboundFiles;
		if (!Array.isArray(files)) return null;
		const errors: HistoryError[] = [];
		for (const f of files as { type?: string; fullName?: string; state?: string; error?: string; problem?: string }[]) {
			if (f?.state === "Failed" || f?.error || f?.problem) {
				errors.push({ component: f.type && f.fullName ? `${f.type}:${f.fullName}` : f.fullName, message: String(f.error ?? f.problem ?? "Failed") });
			}
		}
		return { components: componentKeysFromList(files), errors: errors.slice(0, MAX_ERRORS) };
	} catch {
		return null;
	}
}
