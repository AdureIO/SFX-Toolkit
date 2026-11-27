/**
 * Delete from org: the destructive-changes package, the `sf` argument list and the parsing of its result.
 * Pure (no `vscode`, no I/O): the runner is `deleteFromOrg.ts`.
 */
import type { ApiDeployResult } from "./deployDiagnostics";
import {
	CoverageRow,
	DeployStats,
	RawDeployResult,
	coverageFromResult,
	parseCliDeployJson,
	statsFromResult,
	toApiDeployResult,
} from "./deployStatusMap";
import { testLevelArgs } from "./deployTestArgsPure";

export interface DestructiveComponent {
	type: string;
	fullName: string;
}

const NS = "http://soap.sforce.com/2006/04/metadata";

/** Escape text for an XML element body. */
export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** `v62.0` / `62` / `62.0` → `62.0`. */
export function normalizeApiVersion(v: string): string {
	const m = /^v?(\d+)(?:\.(\d+))?$/.exec(v.trim());
	if (!m) throw new Error(`Invalid API version: ${JSON.stringify(v)}`);
	return `${m[1]}.${m[2] ?? "0"}`;
}

/**
 * The two files of a destructive deploy: an empty `package.xml` (only the API version) and a
 * `destructiveChanges.xml` listing the components. Types and members are sorted, duplicates dropped, names XML-escaped.
 */
export function buildDestructivePackage(components: readonly DestructiveComponent[], apiVersion: string): { packageXml: string; destructiveXml: string } {
	const version = normalizeApiVersion(apiVersion);
	const byType = new Map<string, Set<string>>();
	for (const c of components) {
		if (!c.type || !c.fullName) continue;
		let set = byType.get(c.type);
		if (!set) byType.set(c.type, (set = new Set()));
		set.add(c.fullName);
	}
	const head = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="${NS}">\n`;
	const tail = `    <version>${version}</version>\n</Package>\n`;
	let types = "";
	for (const type of [...byType.keys()].sort()) {
		types += "    <types>\n";
		for (const m of [...byType.get(type)!].sort()) types += `        <members>${escapeXml(m)}</members>\n`;
		types += `        <name>${escapeXml(type)}</name>\n    </types>\n`;
	}
	return { packageXml: head + tail, destructiveXml: head + types + tail };
}

export interface DeleteArgsInput {
	/** Absolute path of the (empty) package.xml. */
	manifest: string;
	/** Absolute path of destructiveChanges.xml. */
	destructive: string;
	/** `--target-org` (alias or username). */
	org: string;
	testLevel: string;
	specifiedTests?: readonly string[];
}

/** `sf project deploy start --manifest … --post-destructive-changes … --target-org … --test-level … --json` as an argv. */
export function buildDeleteArgs(i: DeleteArgsInput): string[] {
	return [
		"project",
		"deploy",
		"start",
		"--manifest",
		i.manifest,
		"--post-destructive-changes",
		i.destructive,
		"--target-org",
		i.org,
		...testLevelArgs(i.testLevel, i.specifiedTests ?? []),
		"--json",
	];
}

/** The same outcome shape the Deploy panel works with (plus the deploy id for the history). */
export type DeleteOutcome =
	| { kind: "cancelled" }
	| { kind: "success"; stats: DeployStats; coverage: CoverageRow[]; apiResult?: ApiDeployResult; deployId?: string; completedAt?: number }
	| { kind: "failed"; stats: DeployStats; coverage: CoverageRow[]; apiResult?: ApiDeployResult; deployId?: string; errorText: string };

const NO_STATS: DeployStats = { components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0 };

/** A parsed `result` counts as a deploy result when it carries a status string (an error envelope has a numeric one). */
function asDeployResult(text: string): RawDeployResult | undefined {
	const dr = parseCliDeployJson(text);
	return dr && typeof dr.status === "string" ? dr : undefined;
}

/** The CLI's own message of an error envelope (`{ "status": 1, "message": … }`), or "". */
function envelopeMessage(text: string): string {
	const s = text.indexOf("{");
	const e = text.lastIndexOf("}");
	if (s < 0 || e <= s) return "";
	try {
		const j = JSON.parse(text.slice(s, e + 1)) as { message?: unknown; result?: { message?: unknown } };
		return typeof j.message === "string" ? j.message : typeof j.result?.message === "string" ? j.result.message : "";
	} catch {
		return "";
	}
}

/**
 * Interpret a finished run: `stdout` of a successful exit, or the `stdout` / message of a failed one.
 * A deploy that reports `Failed` / `Canceled` is a failure even when the exit code said otherwise.
 */
export function parseDeleteOutcome(run: { stdout?: string; error?: string; ok: boolean }): DeleteOutcome {
	const text = run.stdout || run.error || "";
	const dr = asDeployResult(text) ?? (run.error ? asDeployResult(run.error) : undefined);
	if (run.ok && dr && dr.status !== "Failed" && dr.status !== "Canceled" && dr.status !== "SucceededPartial") {
		const completed = Date.parse(String((dr as { completedDate?: unknown }).completedDate ?? ""));
		return {
			kind: "success",
			stats: statsFromResult(dr),
			coverage: coverageFromResult(dr),
			apiResult: toApiDeployResult(dr),
			deployId: dr.id,
			completedAt: Number.isNaN(completed) ? undefined : completed,
		};
	}
	if (run.ok && !dr) {
		// Exit 0 without a readable result: the CLI did not complain, so the delete went through.
		return { kind: "success", stats: NO_STATS, coverage: [] };
	}
	const errorText = envelopeMessage(text) || run.error || text || "The delete failed.";
	return dr
		? { kind: "failed", stats: statsFromResult(dr), coverage: coverageFromResult(dr), apiResult: toApiDeployResult(dr), deployId: dr.id, errorText: run.error || text }
		: { kind: "failed", stats: NO_STATS, coverage: [], errorText };
}

// ── Typed confirmation ─────────────────────────────────────────────────────────

/** The text the user has to type to confirm a delete against a production (or unverifiable) org: its alias, else its username. */
export function destructiveConfirmText(org: { alias?: string; username: string }): string {
	return (org.alias?.trim() || org.username).trim();
}

/** Does what the user typed match (case-sensitive, surrounding blanks ignored)? */
export function confirmationMatches(typed: string | undefined, expected: string): boolean {
	return !!expected && (typed ?? "").trim() === expected;
}

/** The modal's component list: the first `max` (default 20) as `Type:Name`, then `+n more`. */
export function deleteListing(components: readonly DestructiveComponent[], max = 20): string[] {
	const lines = components.slice(0, max).map((c) => `${c.type}:${c.fullName}`);
	if (components.length > max) lines.push(`+${components.length - max} more`);
	return lines;
}
