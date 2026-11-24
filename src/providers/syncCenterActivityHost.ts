/**
 * Host side of the Deploy & Retrieve Center's activity features (kept out of `SyncCenterPanelProvider`):
 *   - `op`     live state of each deploy / validate / retrieve / delete started from the Center, posted as
 *              `{type:"op", …}` (see `syncCenterOpPure`), with `cancelOp`;
 *   - deploys  the org's recent deploys (Tooling API `DeployRequest`) merged with the local history, the details of
 *              one deploy, and "Open in Setup" (see `deployListPure`);
 *   - timings  the phases of opening the Center, logged once to the output channel.
 * The provider creates one `SyncCenterActivity` per open panel and hands it the few things it needs to know.
 */
import * as vscode from "vscode";
import { AuthInfo } from "../utils/authInfo";
import { getToolingApiVersion } from "../utils/constants";
import { getDeployStatus } from "../utils/deployEngine";
import {
	DEPLOY_LIST_LIMIT,
	DeployDetails,
	DeployListItem,
	OrgDeployRow,
	deployRequestQuery,
	isUnsupportedQueryError,
	mergeDeployLists,
	orgRowOfDeployResult,
	parseDeployDetails,
	parseDeployRequests,
} from "../utils/deployListPure";
import { runCommandArgs } from "../utils/commandRunner";
import { parseCliDeployJson, DeployLiveStatus } from "../utils/deployStatusMap";
import { getHistory } from "../utils/syncHistory";
import { Logger } from "../utils/outputChannel";
import { openOrgPath } from "../utils/openOrgPath";
import { deploymentSetupPath } from "../utils/syncCenterUiPure";
import {
	OpKind,
	OpMessage,
	OutcomeLike,
	applyLive,
	applyRetrieveProgress,
	isFinished,
	newOp,
	sameOpState,
	settleOp,
	settleSimple,
} from "../utils/syncCenterOpPure";

/** What the activity needs to know about the panel's current state (read at call time: the org can change). */
export interface ActivityDeps {
	post(msg: Record<string, unknown>): void;
	projectDir(): string | undefined;
	/** The selected org as `--target-org` / REST target; null = none chosen. */
	orgArg(): string | null;
	/** What the panel calls the selected org. */
	orgLabel(): string;
	/** Does a history entry's org name the selected org (alias-insensitive)? */
	sameOrg(entryOrg: string): boolean;
	/** Bumped whenever the org / project changes: late answers of an earlier org are dropped. */
	generation(): number;
	/** Start a busy phase (the webview's progress bar: `{type:"busy", on, label}`); returns its end. */
	busy(label: string): () => void;
}

/** Cancels when any of the given tokens does. */
export function mergeTokens(...tokens: (vscode.CancellationToken | undefined)[]): { token: vscode.CancellationToken; dispose(): void } {
	const cts = new vscode.CancellationTokenSource();
	const subs = tokens.filter((t): t is vscode.CancellationToken => !!t).map((t) => (t.isCancellationRequested ? (cts.cancel(), undefined) : t.onCancellationRequested(() => cts.cancel())));
	return {
		token: cts.token,
		dispose: () => {
			for (const s of subs) s?.dispose();
			cts.dispose();
		},
	};
}

/** One operation of the Center as the right panel follows it. Every method is safe to call after the op finished. */
export class OpHandle {
	private msg: OpMessage;
	private last: OpMessage | undefined;
	private readonly cts = new vscode.CancellationTokenSource();

	constructor(
		kind: OpKind,
		readonly id: string,
		label: string | undefined,
		private readonly send: (m: OpMessage) => void,
		private readonly cancellable: boolean,
		phase: "queued" | "running" = "queued"
	) {
		this.msg = newOp(kind, id, label, Date.now(), phase);
		this.emit(true);
	}

	/** Cancelled by `cancelOp` (the deploy / delete runs honour it; a retrieve cannot be cancelled from here). */
	get token(): vscode.CancellationToken {
		return this.cts.token;
	}

	get finished(): boolean {
		return isFinished(this.msg.phase);
	}

	cancel(): boolean {
		if (!this.cancellable || this.finished) return false;
		this.cts.cancel();
		return true;
	}

	private emit(force = false): void {
		if (!force && sameOpState(this.last, this.msg)) return;
		this.last = this.msg;
		this.send(this.msg);
	}

	running(message?: string): void {
		if (this.finished) return;
		this.msg = { ...this.msg, phase: "running", ...(message ? { message } : {}) };
		this.emit();
	}

	deployId(id: string | undefined): void {
		if (!id || this.finished || this.msg.deployId === id) return;
		this.msg = { ...this.msg, deployId: id };
		this.emit();
	}

	/** A live deploy snapshot (called every 100 ms by the engine; only changes go out). */
	live(s: DeployLiveStatus): void {
		this.msg = applyLive(this.msg, s);
		this.emit();
	}

	retrieveProgress(done: number, total: number): void {
		this.msg = applyRetrieveProgress(this.msg, done, total);
		this.emit();
	}

	/** The finished deploy / validate / delete. */
	settle(outcome: OutcomeLike): void {
		if (this.finished) return;
		this.msg = settleOp(this.msg, outcome, Date.now());
		this.emit(true);
		this.cts.dispose();
	}

	end(phase: "done" | "failed" | "cancelled", message?: string): void {
		if (this.finished) return;
		this.msg = settleSimple(this.msg, phase, message, Date.now());
		this.emit(true);
		this.cts.dispose();
	}
}

/** Phases of opening the panel, logged together once. */
export class OpenTimings {
	private readonly t0 = Date.now();
	private readonly parts: string[] = [];
	private logged = false;

	/** `name` took `ms` (use `since` for a duration from the start of the open). */
	mark(name: string, ms: number): void {
		this.parts.push(`${name} ${ms} ms`);
	}

	/** `name` happened `ms` after the open started. */
	at(name: string): void {
		this.parts.push(`${name} @${Date.now() - this.t0} ms`);
	}

	log(heading: string): void {
		if (this.logged || this.parts.length === 0) return;
		this.logged = true;
		Logger.info(`${heading}: ${this.parts.join(" | ")}`);
	}
}

export class SyncCenterActivity {
	private readonly ops = new Map<string, OpHandle>();
	private opSeq = 0;

	constructor(private readonly deps: ActivityDeps) {}

	// ── ops ──────────────────────────────────────────────────────────────────────

	/** Start following an operation (`queued` until it runs). */
	beginOp(kind: OpKind, label: string, phase: "queued" | "running" = "queued"): OpHandle {
		const id = `op-${Date.now().toString(36)}-${++this.opSeq}`;
		// A retrieve has no cancel from the webview (its notification keeps the existing Cancel).
		const op = new OpHandle(kind, id, label, (m) => this.deps.post({ ...m }), kind !== "retrieve", phase);
		this.ops.set(id, op);
		for (const [k, v] of this.ops) {
			if (this.ops.size <= 30) break;
			if (v.finished) this.ops.delete(k);
		}
		return op;
	}

	/** A busy phase of the panel's progress bar; call the returned function when it ends. */
	busyBegin(label: string): () => void {
		return this.deps.busy(label);
	}

	cancelOp(id: string): void {
		const op = this.ops.get(id);
		if (op && !op.cancel()) Logger.info(`Deploy & Retrieve Center: operation ${id} cannot be cancelled from here`);
	}

	// ── deploys ──────────────────────────────────────────────────────────────────

	private toolingQuery(soql: string): Promise<unknown> {
		const org = this.deps.orgArg();
		return AuthInfo.get(org, (a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${getToolingApiVersion()}/tooling/query/?q=${encodeURIComponent(soql)}`).then((r) => JSON.parse(r.body));
	}

	/** The org's deploys from `DeployRequest`; falls back to a field-reduced query, then to the ids the history knows. */
	async orgDeploys(failedOnly: boolean): Promise<{ rows: OrgDeployRow[] | undefined; error?: string }> {
		let lastError = "";
		for (const level of ["full", "basic"] as const) {
			try {
				return { rows: parseDeployRequests(await this.toolingQuery(deployRequestQuery({ failedOnly, level }))) };
			} catch (e) {
				lastError = String((e as Error)?.message ?? e);
				const kind = isUnsupportedQueryError(lastError);
				Logger.info(`Deploy & Retrieve Center: DeployRequest query (${level}) failed: ${lastError.slice(0, 300)}`);
				if (kind !== "field") break; // the object itself is not available, or the org / network failed: another query will not help
			}
		}
		// Not queryable: ask the REST metadata endpoint for the deploys this project's history knows.
		if (isUnsupportedQueryError(lastError) === "object") {
			const root = this.deps.projectDir();
			const ids = [...new Set((root ? getHistory(root) : []).filter((h) => h.deployId && this.deps.sameOrg(h.org)).map((h) => h.deployId as string))].slice(0, DEPLOY_LIST_LIMIT);
			const rows = (await Promise.all(ids.map((id) => getDeployStatus(this.deps.orgArg(), id, false).then(orgRowOfDeployResult, () => undefined)))).filter((r): r is OrgDeployRow => !!r);
			return { rows, error: "The org's DeployRequest list is not available; showing the deploys this project knows." };
		}
		return { rows: undefined, error: lastError.replace(/\s+/g, " ").slice(0, 300) || "Could not list the deploys of the org." };
	}

	/** `{type:"listDeploys", failedOnly?}` → `{type:"deploys", items, error?}`. */
	async listDeploys(failedOnly: boolean): Promise<void> {
		const gen = this.deps.generation();
		const root = this.deps.projectDir();
		let org: { rows: OrgDeployRow[] | undefined; error?: string } = { rows: undefined, error: "Choose an org first." };
		if (this.deps.orgArg()) {
			const end = this.deps.busy("Listing deploys…");
			try {
				org = await this.orgDeploys(failedOnly);
			} catch (e) {
				org = { rows: undefined, error: String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 300) };
			} finally {
				end();
			}
		}
		if (gen !== this.deps.generation()) return;
		const items: DeployListItem[] = mergeDeployLists(org.rows, root ? getHistory(root) : [], { orgLabel: this.deps.orgLabel(), sameOrg: (o) => this.deps.sameOrg(o), failedOnly });
		this.deps.post({ type: "deploys", items, ...(org.error ? { error: org.error } : {}) });
	}

	/** `{type:"deployDetails", id}` → `{type:"deployDetails", id, details, error?}`. */
	async deployDetails(id: string): Promise<void> {
		const gen = this.deps.generation();
		const empty: DeployDetails = { componentErrors: [], testErrors: [] };
		const org = this.deps.orgArg();
		if (!org || !/^0Af[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/.test(id)) {
			this.deps.post({ type: "deployDetails", id, details: empty, error: org ? "This entry has no deploy id in the org." : "Choose an org first." });
			return;
		}
		let details = empty;
		let error: string | undefined;
		try {
			details = parseDeployDetails(await getDeployStatus(org, id, true));
		} catch (e) {
			const first = String((e as Error)?.message ?? e);
			try {
				const out = await runCommandArgs("sf", ["project", "deploy", "report", "--job-id", id, "--json", "--target-org", org], this.deps.projectDir(), undefined, false, 60000);
				details = parseDeployDetails(parseCliDeployJson(out));
			} catch (e2) {
				error = `${first}`.replace(/\s+/g, " ").slice(0, 300) || String((e2 as Error)?.message ?? e2).slice(0, 300);
			}
		}
		if (gen !== this.deps.generation()) return;
		this.deps.post({ type: "deployDetails", id, details, ...(error ? { error } : {}) });
	}

	async openDeployInSetup(deployId: string): Promise<void> {
		if (!deployId) return;
		try {
			await openOrgPath(this.deps.orgArg(), deploymentSetupPath(deployId), this.deps.projectDir());
		} catch (err) {
			void vscode.window.showErrorMessage(`Couldn’t open Setup: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
		}
	}

	/** Webview → host messages of this module; true = handled. (`command` is what the Center's older messages use, `type` the newer ones.) */
	handle(msg: { command?: string; type?: string; [k: string]: unknown }): boolean {
		const name = String(msg.command ?? msg.type ?? "");
		switch (name) {
			case "listDeploys":
				void this.listDeploys(msg.failedOnly === true);
				return true;
			case "deployDetails":
				void this.deployDetails(String(msg.id ?? ""));
				return true;
			case "openDeployInSetup":
				void this.openDeployInSetup(String(msg.deployId ?? ""));
				return true;
			case "cancelOp":
				this.cancelOp(String(msg.id ?? ""));
				return true;
			default:
				return false;
		}
	}
}
