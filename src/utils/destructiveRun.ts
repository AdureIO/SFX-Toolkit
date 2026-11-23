/**
 * The delete-from-org run with its CLI injected (no `vscode`): writes the destructive package to a temp dir,
 * runs `sf project deploy start --manifest … --post-destructive-changes …`, parses the result, cleans up.
 * `deleteFromOrg.ts` wires the real runner; the tests a fake one.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DeleteOutcome, DestructiveComponent, buildDeleteArgs, buildDestructivePackage, parseDeleteOutcome } from "./destructivePure";

/** Runs `sf <args>` in `cwd`; resolves with stdout, rejects with `{ stdout?, message, cancelled? }` on a non-zero exit. */
export type SfExec = (args: string[], cwd: string) => Promise<string>;

export interface DestructiveRunOptions {
	projectDir: string;
	org: string;
	components: readonly DestructiveComponent[];
	testLevel: string;
	specifiedTests?: readonly string[];
	/** Metadata API version of the package (`62.0`). */
	apiVersion: string;
	exec: SfExec;
}

export interface DestructiveRunResult {
	outcome: DeleteOutcome;
	/** Distinct metadata types of the components (the listings to refresh afterwards). */
	types: string[];
	durationMs: number;
}

export async function runDestructiveDeploy(o: DestructiveRunOptions): Promise<DestructiveRunResult> {
	if (o.components.length === 0) throw new Error("Nothing to delete.");
	const { packageXml, destructiveXml } = buildDestructivePackage(o.components, o.apiVersion);
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asfx-delete-"));
	const started = Date.now();
	const types = [...new Set(o.components.map((c) => c.type))].sort();
	try {
		const manifest = path.join(dir, "package.xml");
		const destructive = path.join(dir, "destructiveChanges.xml");
		// Built first: an invalid test level or test name throws before anything is written or run.
		const args = buildDeleteArgs({ manifest, destructive, org: o.org, testLevel: o.testLevel, specifiedTests: o.specifiedTests });
		await fs.promises.writeFile(manifest, packageXml, "utf8");
		await fs.promises.writeFile(destructive, destructiveXml, "utf8");
		let outcome: DeleteOutcome;
		try {
			const stdout = await o.exec(args, o.projectDir);
			outcome = parseDeleteOutcome({ stdout, ok: true });
		} catch (e) {
			const err = e as { cancelled?: boolean; stdout?: unknown; message?: unknown };
			if (err?.cancelled) outcome = { kind: "cancelled" };
			else outcome = parseDeleteOutcome({ stdout: typeof err?.stdout === "string" ? err.stdout : undefined, error: String(err?.message ?? e), ok: false });
		}
		return { outcome, types, durationMs: Date.now() - started };
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
