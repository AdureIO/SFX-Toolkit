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
import { Logger } from "./outputChannel";
import { parseDeployIdFromJson } from "../commands/deployMetadata";
import {
	RawDeployResult,
	DeployLiveStatus,
	extractDeployResult,
	mapLiveStatus,
} from "./deployStatusMap";

/** Raised when the deploy could not even be submitted (auth/flags/no id). Callers may fall back to CLI streaming. */
export class DeploySubmitError extends Error {}

export type DeployEngineOutcome =
	| { kind: "success"; result: RawDeployResult }
	| { kind: "failed"; result: RawDeployResult }
	| { kind: "cancelled"; result?: RawDeployResult };

export interface RunRestDeployOptions {
	/** Full `sf project deploy start … --async --json` command (built by buildDeployCommand with asyncJson=true). */
	submitCommand: string;
	cwd: string;
	/** Org alias, or null for the default org. */
	org: string | null;
	token: vscode.CancellationToken;
	onStatus: (s: DeployLiveStatus) => void;
	timeoutMs: number;
	pollIntervalMs?: number;
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

export async function runRestDeploy(opts: RunRestDeployOptions): Promise<DeployEngineOutcome> {
	const { submitCommand, cwd, org, token, onStatus, timeoutMs } = opts;
	const pollIntervalMs = opts.pollIntervalMs ?? 1000;

	// Warm org auth concurrently with the submit subprocess, so the first poll doesn't
	// pay a serial `sf org display` round-trip after submit returns.
	void AuthInfo.getAuthInfoForOrg(org).catch(() => {});

	// Running timer: keep the latest status and re-emit it every second (with a fresh
	// elapsed) so the notification's clock ticks even during submit and between polls.
	const startTime = Date.now();
	let lastLive: DeployLiveStatus = {
		status: "Pending",
		componentsDeployed: 0, componentsTotal: 0, componentErrors: 0,
		testsCompleted: 0, testsTotal: 0, testErrors: 0,
		done: false,
	};
	const emit = (s: DeployLiveStatus) => {
		lastLive = s;
		onStatus({ ...s, elapsedMs: Date.now() - startTime });
	};
	emit(lastLive); // show "Pending · ⏱ 0:00.00" immediately
	// Tick the displayed timer ~10×/s so it visibly runs in sub-seconds (the org is
	// still polled at the slower pollIntervalMs — this only refreshes the elapsed clock).
	const ticker = setInterval(() => onStatus({ ...lastLive, elapsedMs: Date.now() - startTime }), 100);

	try {
		// ── Submit (one subprocess; reuses the CLI's source→mdapi conversion + zip) ──
		let submitOut: string;
		try {
			submitOut = await runCommand(submitCommand, cwd, undefined, false, token, timeoutMs);
		} catch (e: any) {
			if (e?.cancelled) return { kind: "cancelled" }; // cancelled before an id existed → nothing running
			throw new DeploySubmitError(e?.message ?? String(e));
		}
		const deployId = parseDeployIdFromJson(submitOut);
		if (!deployId) {
			throw new DeploySubmitError(`Could not parse a deploy id from submit output: ${submitOut.slice(0, 400)}`);
		}
		Logger.info(`Deploy submitted (async), id=${deployId}. Polling status over REST.`);

		// ── Poll; on cancel, PATCH once then keep polling until the server confirms terminal ──
		const deadline = Date.now() + timeoutMs;
		let cancelSent = false;
		let last: RawDeployResult = {};
		let consecutiveErrors = 0;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			if (token.isCancellationRequested && !cancelSent) {
				cancelSent = true;
				emit({ ...mapLiveStatus(last), status: "Canceling", done: false });
				try {
					await requestCancel(org, deployId);
					Logger.info(`Deploy ${deployId}: cancel requested (Canceling).`);
				} catch (e: any) {
					// The deploy may have already finished — the next poll reveals the real state.
					Logger.warn(`Deploy ${deployId}: cancel request failed (may have already finished): ${e?.message ?? e}`);
				}
			}

			let dr: RawDeployResult;
			try {
				// Poll lightweight: status + counts + stateDetail only (no per-component
				// details). Those come once at the end — polling them every second ships
				// and re-parses the whole component list needlessly and slows the deploy.
				dr = await getDeployStatus(org, deployId, false);
				consecutiveErrors = 0;
			} catch (e: any) {
				// The deploy is already running server-side, so we must NOT fall back to a
				// second CLI deploy. But don't hang until the 45-min deadline either: after a
				// short run of consecutive failures, surface an actionable error with the id.
				consecutiveErrors++;
				if (consecutiveErrors >= 8 || Date.now() > deadline) {
					throw new Error(
						`Deploy ${deployId} was submitted, but polling its status failed (${consecutiveErrors}×): ` +
							`${e?.message ?? e}. Check it with: sf project deploy report --job-id ${deployId}`
					);
				}
				await interruptibleSleep(pollIntervalMs, token);
				continue;
			}

			last = dr;
			const live = mapLiveStatus(dr);
			emit(live);

			if (live.done) {
				// One detailed fetch now, for the component table / diagnostics / coverage.
				let full = dr;
				try {
					full = await getDeployStatus(org, deployId, true);
				} catch {
					/* keep the light result if the detailed fetch fails */
				}
				if (live.status === "Canceled") return { kind: "cancelled", result: full };
				if (live.status === "Succeeded") return { kind: "success", result: full };
				return { kind: "failed", result: full };
			}
			if (Date.now() > deadline) throw new Error("Deploy timed out while polling status.");
			await interruptibleSleep(pollIntervalMs, token);
		}
	} finally {
		clearInterval(ticker);
	}
}
