/**
 * Live Metadata deploy over REST.
 *
 * Strategy (see the design discussion): submit ONCE via the CLI's async deploy
 * (`sf project deploy start --async --json`) so we reuse its battle-tested
 * source→mdapi conversion + zip, then poll the Metadata REST `deployRequest`
 * endpoint ourselves for live, structured status — no subprocess per poll, no
 * text scraping. On the final poll the same JSON drives the Problems view.
 *
 * Cancellation is authoritative: cancelling a running deploy must tell the SERVER
 * to stop (a PATCH to Canceling), then keep polling until it confirms Canceled —
 * simply dropping the poll loop would leave the deploy running in the org.
 */
import * as vscode from "vscode";
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { runCommand } from "./commandRunner";
import {
	RawDeployResult,
	DeployLiveStatus,
	extractDeployResult,
	parseCliDeployJson,
	isTerminalStatus,
	mapLiveStatus,
} from "./deployStatusMap";

export type JsonDeployOutcome =
	| { kind: "success"; result: RawDeployResult }
	| { kind: "failed"; result?: RawDeployResult; errorText: string }
	| { kind: "cancelled" }
	| { kind: "nothing" }; // NothingToDeploy — no changes

export interface RunJsonDeployOptions {
	/** `sf project deploy start …` WITHOUT `--json` (it's appended). */
	submitCommand: string;
	cwd: string;
	/** Org for the live REST poll + auth (null = default). */
	org: string | null;
	token: vscode.CancellationToken;
	onStatus: (s: DeployLiveStatus) => void;
	timeoutMs: number;
}

/**
 * Run a SYNCHRONOUS `--json` deploy (waits for the org → advances source tracking) while
 * showing live status: discover the running deploy's id via `deploy report --use-most-recent
 * --json` and REST-poll it. Everything is JSON — no human-table scraping. Returns a structured
 * outcome (component list, counts) for the caller.
 */
export async function runJsonDeploy(opts: RunJsonDeployOptions): Promise<JsonDeployOutcome> {
	const { submitCommand, cwd, org, token, onStatus, timeoutMs } = opts;
	const startTime = Date.now();
	let settled = false;

	const liveStatus = (async () => {
		for (let i = 0; i < 30 && !settled && !token.isCancellationRequested; i++) {
			try {
				const rep = await runCommand("sf project deploy report --use-most-recent --json", cwd, undefined, false, token, 60000);
				const dr = parseCliDeployJson(rep);
				if (dr?.id && !isTerminalStatus(dr.status)) {
					await streamDeployStatus({ deployId: dr.id, org, token, startTime, timeoutMs, stop: () => settled, onStatus });
					return;
				}
			} catch {
				/* not registered yet / no recent deploy */
			}
			if (settled) return;
			await new Promise((r) => setTimeout(r, 400));
		}
	})().catch(() => undefined);

	try {
		const out = await runCommand(`${submitCommand} --json`.replace(/\s+/g, " ").trim(), cwd, undefined, false, token, timeoutMs);
		settled = true;
		await liveStatus;
		const dr = parseCliDeployJson(out);
		return dr ? { kind: "success", result: dr } : { kind: "success", result: {} };
	} catch (e: any) {
		settled = true;
		await liveStatus;
		if (e?.cancelled) return { kind: "cancelled" };
		const msg = e?.message ?? String(e);
		if (/NothingToDeploy|No (?:local )?changes to deploy/i.test(msg)) return { kind: "nothing" };
		const dr = parseCliDeployJson(msg);
		return { kind: "failed", result: dr ?? undefined, errorText: msg };
	}
}

export interface StreamDeployStatusOptions {
	/** The `0Af…` id of a deploy already running (e.g. discovered from a synchronous push's output). */
	deployId: string;
	org: string | null;
	token: vscode.CancellationToken;
	onStatus: (s: DeployLiveStatus) => void;
	/** Milliseconds at which the deploy started, so the live timer reads accurately. */
	startTime: number;
	timeoutMs: number;
	/** Return true to stop polling (e.g. the owning synchronous deploy has finished). */
	stop: () => boolean;
	pollIntervalMs?: number;
}

/**
 * Poll an ALREADY-RUNNING deploy for live status (with the ~100 ms timer tick), without
 * submitting anything. Lets a synchronous push — which owns tracking — show the same live
 * notification as the async engine. Returns the final detailed result (component list) for
 * the log table / smart refresh, or null if it couldn't be fetched.
 */
export async function streamDeployStatus(opts: StreamDeployStatusOptions): Promise<RawDeployResult | null> {
	const { deployId, org, token, onStatus, startTime, timeoutMs, stop } = opts;
	const pollIntervalMs = opts.pollIntervalMs ?? 1000;

	let lastLive: DeployLiveStatus = {
		status: "Pending",
		componentsDeployed: 0, componentsTotal: 0, componentErrors: 0,
		testsCompleted: 0, testsTotal: 0, testErrors: 0,
		done: false,
	};
	const ticker = setInterval(() => onStatus({ ...lastLive, elapsedMs: Date.now() - startTime }), 100);
	const deadline = Date.now() + timeoutMs;
	let lastDr: RawDeployResult | null = null;
	let cancelSent = false;

	try {
		while (Date.now() < deadline) {
			// Authoritatively cancel the server-side deploy (the CLI SIGINT alone may not).
			if (token.isCancellationRequested && !cancelSent) {
				cancelSent = true;
				try { await requestCancel(org, deployId); } catch { /* may already be finished */ }
			}
			try {
				const dr = await getDeployStatus(org, deployId, false);
				lastDr = dr;
				lastLive = mapLiveStatus(dr);
				onStatus({ ...lastLive, elapsedMs: Date.now() - startTime });
				if (lastLive.done) break;
			} catch {
				if (stop()) break; // owning deploy finished; give up quietly
			}
			if (stop() && cancelSent) break; // cancelled and owning deploy done
			if (stop()) break;
			await interruptibleSleep(pollIntervalMs, token);
		}
		// One detailed fetch for the component table / diagnostics / coverage.
		try { lastDr = await getDeployStatus(org, deployId, true); } catch { /* keep the light result */ }
	} finally {
		clearInterval(ticker);
	}
	return lastDr;
}

function metadataUrl(instanceUrl: string, deployId: string, includeDetails: boolean): string {
	const base = `${instanceUrl.replace(/\/$/, "")}/services/data/${getToolingApiVersion()}/metadata/deployRequest/${deployId}`;
	return includeDetails ? `${base}?includeDetails=true` : base;
}

async function getDeployStatus(org: string | null, deployId: string, includeDetails: boolean): Promise<RawDeployResult> {
	const { body } = await AuthInfo.get(org, (a) => metadataUrl(a.instanceUrl, deployId, includeDetails));
	const dr = extractDeployResult(JSON.parse(body));
	if (!dr) throw new Error("Unexpected deployRequest response shape");
	return dr;
}

/** Ask the server to cancel. Idempotent-ish: a completed deploy rejects, which we swallow. */
async function requestCancel(org: string | null, deployId: string): Promise<void> {
	await AuthInfo.patch(org, (a) => metadataUrl(a.instanceUrl, deployId, false), {
		deployResult: { status: "Canceling" },
	});
}

/** Sleep that resolves early if cancellation is requested (so we PATCH promptly). */
function interruptibleSleep(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			sub.dispose();
			resolve();
		}, ms);
		const sub = token.onCancellationRequested(() => {
			clearTimeout(timer);
			sub.dispose();
			resolve();
		});
	});
}

